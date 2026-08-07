/**
 * sources/smtp-verify.ts — verify generated email guesses via MX lookup +
 * optional SMTP RCPT probe. Three things the v1 Python script didn't do:
 *
 *  1. Persistent cache — results live in data/cache/smtp.json (30 d TTL) so
 *     repeat runs don't re-probe every guess. Verifies SURVIVE laptop ↔ CI
 *     handovers (the cache is committed-friendly if the user wants it; default
 *     gitignored under data/cache/).
 *  2. CI-safe by default — port 25 is blocked from most cloud egress
 *     (GitHub Actions included). When FX_SMTP_DISABLE=1 (the default in CI),
 *     we skip the RCPT probe entirely and only do an MX-existence check.
 *     Verifies done locally still serve from cache.
 *  3. HTTP verifier opt-in — when FX_EMAIL_VERIFIER_URL is set, queries that
 *     endpoint instead. Generic interface: POST {email} → {smtp_verified,
 *     catch_all}. Works with Hunter, Snov, NeverBounce — caller picks.
 *
 * Returns SmtpResult — { smtp_verified: bool | null, catch_all: bool, source }.
 * smtp_verified === null means "couldn't determine" (no MX, or RCPT skipped).
 */
import { promises as dns } from "node:dns";
import net from "node:net";
import { resolve } from "node:path";
import { FileCache, repoRoot } from "@fx/core";

const CACHE_VERSION = 1;
const DEFAULT_CACHE_PATH = resolve(repoRoot(), "data/cache/smtp.json");
const DEFAULT_TTL_DAYS = Number(process.env.FX_SMTP_CACHE_TTL_DAYS ?? "30");

export interface SmtpResult {
  email: string;
  smtp_verified: boolean | null;     // null = could not determine
  catch_all: boolean;
  source: "cache" | "smtp" | "http" | "mx_only" | "skipped";
}

export interface SmtpVerifierOptions {
  cachePath?: string;
  ttlSeconds?: number;
  disableSmtp?: boolean;             // default: env FX_SMTP_DISABLE / CI
  httpVerifierUrl?: string;          // env FX_EMAIL_VERIFIER_URL (POST {email}, returns {smtp_verified, catch_all})
  httpVerifierToken?: string;        // env FX_EMAIL_VERIFIER_TOKEN, sent as Authorization: Bearer
  rcptTimeoutMs?: number;            // default 2500
  ratePerHostMs?: number;            // default 200 — pacing between RCPTs for the same MX host
}

function envBool(name: string): boolean {
  const v = (process.env[name] || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Default disable: explicit env, or running in CI (GitHub Actions / Buildkite / Vercel). */
export function smtpProbeDisabledByDefault(): boolean {
  if (envBool("FX_SMTP_DISABLE")) return true;
  if (envBool("CI") || envBool("GITHUB_ACTIONS") || envBool("BUILDKITE") || envBool("VERCEL")) return true;
  return false;
}

interface MxRecord { exchange: string; priority: number }
const mxMemo = new Map<string, Promise<MxRecord[]>>();
async function lookupMx(domain: string): Promise<MxRecord[]> {
  const cached = mxMemo.get(domain);
  if (cached) return cached;
  const p = (async () => {
    try {
      const records = await dns.resolveMx(domain);
      return records.slice().sort((a, b) => a.priority - b.priority);
    } catch { return []; }
  })();
  mxMemo.set(domain, p);
  return p;
}

const hostNextAllowed = new Map<string, number>();
async function paceFor(host: string, gapMs: number): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, (hostNextAllowed.get(host) ?? 0) - now);
  if (wait) await new Promise((r) => setTimeout(r, wait));
  hostNextAllowed.set(host, Date.now() + gapMs);
}

/** Single SMTP RCPT probe. Returns true on 250, false on 5xx, null on retryable / no signal. */
async function smtpRcpt(host: string, email: string, timeoutMs: number): Promise<boolean | null> {
  return new Promise((resolveResult) => {
    const sock = net.createConnection({ host, port: 25 });
    let buf = "", phase = 0, settled = false;
    const finish = (v: boolean | null) => {
      if (settled) return;
      settled = true;
      try { sock.write("QUIT\r\n"); } catch { /* ignore */ }
      sock.destroy();
      resolveResult(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.setEncoding("utf8");
    sock.on("error", () => { clearTimeout(timer); finish(null); });
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const code = parseInt(line.slice(0, 3), 10);
        if (Number.isNaN(code)) continue;
        if (phase === 0 && code >= 200 && code < 300) {
          sock.write(`EHLO fx-verify\r\n`);
          phase = 1;
        } else if (phase === 1 && code >= 200 && code < 300) {
          sock.write(`MAIL FROM:<check@example.com>\r\n`);
          phase = 2;
        } else if (phase === 2 && code >= 200 && code < 300) {
          sock.write(`RCPT TO:<${email}>\r\n`);
          phase = 3;
        } else if (phase === 3) {
          if (code === 250) { clearTimeout(timer); finish(true); return; }
          if (code >= 500 && code < 600) { clearTimeout(timer); finish(false); return; }
          clearTimeout(timer); finish(null); return;
        } else if (code >= 400) {
          clearTimeout(timer); finish(null); return;
        }
      }
    });
  });
}

function randomLocalPart(): string {
  return "fx" + Math.random().toString(36).slice(2, 12);
}

export interface SmtpVerifier {
  verifyEmail(email: string): Promise<SmtpResult>;
  detectCatchAll(domain: string): Promise<boolean>;
  flush(): void;
  stats(): { cacheHits: number; cacheMisses: number; rcptCalls: number; rcptVerified: number };
}

export function createSmtpVerifier(opts: SmtpVerifierOptions = {}): SmtpVerifier {
  const cache = new FileCache(opts.cachePath ?? DEFAULT_CACHE_PATH, CACHE_VERSION);
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_DAYS * 86400;
  const disable = opts.disableSmtp ?? smtpProbeDisabledByDefault();
  const httpUrl = opts.httpVerifierUrl ?? process.env.FX_EMAIL_VERIFIER_URL ?? "";
  const httpToken = opts.httpVerifierToken ?? process.env.FX_EMAIL_VERIFIER_TOKEN ?? "";
  const rcptTimeout = opts.rcptTimeoutMs ?? 2500;
  const hostGap = opts.ratePerHostMs ?? 200;
  const stats = { cacheHits: 0, cacheMisses: 0, rcptCalls: 0, rcptVerified: 0 };

  async function catchAllForDomain(domain: string): Promise<boolean> {
    if (disable && !httpUrl) return false;
    const key = `catchall:${domain}`;
    const { hit, value } = cache.lookup(key, ttl);
    if (hit) return value === true;
    const probe = `${randomLocalPart()}@${domain}`;
    const res = await verifyEmail(probe, true);
    cache.store(key, res.smtp_verified === true);
    return res.smtp_verified === true;
  }

  async function verifyEmail(email: string, skipCatchAll = false): Promise<SmtpResult> {
    const e = email.toLowerCase().trim();
    const at = e.indexOf("@");
    if (at <= 0) return { email: e, smtp_verified: false, catch_all: false, source: "skipped" };
    const domain = e.slice(at + 1);

    const key = `verify:${e}`;
    const cached = cache.lookup(key, ttl);
    if (cached.hit) {
      stats.cacheHits++;
      const v = cached.value as { smtp_verified: boolean | null; catch_all: boolean };
      return { email: e, smtp_verified: v.smtp_verified, catch_all: v.catch_all, source: "cache" };
    }
    stats.cacheMisses++;

    // HTTP verifier path (Hunter / Snov / NeverBounce / custom).
    if (httpUrl) {
      try {
        const res = await fetch(httpUrl, {
          method: "POST", signal: AbortSignal.timeout(8000),
          headers: {
            "content-type": "application/json",
            ...(httpToken ? { authorization: `Bearer ${httpToken}` } : {}),
          },
          body: JSON.stringify({ email: e }),
        });
        if (res.ok) {
          const j = (await res.json()) as { smtp_verified?: boolean | null; catch_all?: boolean };
          const out: SmtpResult = { email: e, smtp_verified: j.smtp_verified ?? null, catch_all: !!j.catch_all, source: "http" };
          cache.store(key, { smtp_verified: out.smtp_verified, catch_all: out.catch_all });
          return out;
        }
      } catch { /* fall through to SMTP / mx_only */ }
    }

    // No HTTP, SMTP disabled, or HTTP failed → do an MX-only check.
    const mx = await lookupMx(domain);
    if (!mx.length) {
      cache.store(key, { smtp_verified: false, catch_all: false }, true);
      return { email: e, smtp_verified: false, catch_all: false, source: "mx_only" };
    }
    if (disable) {
      // MX exists → the domain accepts mail somewhere, but we can't say if THIS
      // address is deliverable. Don't cache aggressively — a CI run shouldn't
      // permanently mark every guess as 'unknown'.
      return { email: e, smtp_verified: null, catch_all: false, source: "mx_only" };
    }

    // Detect catch-all first so we don't issue a false-positive on a catch-all
    // domain. Skipped when recursing FROM detectCatchAll.
    let catchAll = false;
    if (!skipCatchAll) catchAll = await catchAllForDomain(domain);

    if (catchAll) {
      const out: SmtpResult = { email: e, smtp_verified: null, catch_all: true, source: "smtp" };
      cache.store(key, { smtp_verified: null, catch_all: true });
      return out;
    }

    // Real RCPT probe against the lowest-priority MX hosts (up to 2).
    let result: boolean | null = null;
    for (const rec of mx.slice(0, 2)) {
      await paceFor(rec.exchange, hostGap);
      stats.rcptCalls++;
      result = await smtpRcpt(rec.exchange, e, rcptTimeout);
      if (result !== null) break;
    }
    if (result === true) stats.rcptVerified++;
    const out: SmtpResult = { email: e, smtp_verified: result, catch_all: false, source: "smtp" };
    cache.store(key, { smtp_verified: result, catch_all: false });
    return out;
  }

  return {
    verifyEmail: (email) => verifyEmail(email),
    detectCatchAll: catchAllForDomain,
    flush() { cache.flush(ttl); },
    stats() { return { ...stats }; },
  };
}
