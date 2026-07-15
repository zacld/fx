/**
 * sources/companies-house.ts — Companies House client. Port of ch_search/ch_profile/
 * ch_officers/ch_validate from scripts/discover.py + discover_web.py, plus the
 * caching (ch_cache.py) and the reliability controls (scripts/discover.py): strict
 * per-request timeout, a per-run HTTP-call budget, slow-call logging, results cached
 * on disk (so repeat lookups within / across runs cost nothing). Never throws.
 *
 * Needs COMPANIES_HOUSE_API_KEY (Basic auth, key as username). The fetch impl is
 * injectable for tests; with no key it returns empty results (CH validation is
 * skipped — leads still get created from website evidence).
 */
import { resolve } from "node:path";
import { Buffer } from "node:buffer";
import { FileCache, repoRoot } from "@fx/core";

const CH_BASE = "https://api.company-information.service.gov.uk";

export interface ChSearchItem { title: string; company_number: string; company_status?: string; company_type?: string; date_of_creation?: string; description?: string; }
export interface ChProfile {
  company_status?: string;
  sic_codes?: Array<string | number>;
  date_of_creation?: string;
  registered_office_address?: Record<string, string>;
  company_name?: string;
  accounts?: {
    accounting_reference_date?: { day?: string; month?: string };
    last_accounts?: { type?: string; period_end_on?: string; made_up_to?: string };
    next_accounts?: { period_end_on?: string };
  };
  has_charges?: boolean;
}
export interface ChOfficer { name?: string; officer_role?: string; resigned_on?: string; appointed_on?: string; }
export interface ChPsc {
  name?: string;
  kind?: string;
  natures_of_control?: string[];
  notified_on?: string;
  ceased_on?: string;
}
export interface ChFilingItem {
  type?: string;
  description?: string;
  date?: string;
  category?: string;
}
export interface ChChargesSummary {
  total_count: number;
  outstanding: number;
  satisfied: number;
}
export interface ChValidation {
  company_number: string; company_name: string; company_status: string; sic_codes: string[];
  incorporated: string; registered_address: string;
  director_name: string | null; director_role: string | null;
  ch_name_match: number; ch_confidence: "high" | "medium" | "low";
}

export interface ChClientOptions {
  apiKey?: string; cachePath?: string; maxCalls?: number; timeoutMs?: number; slowMs?: number;
  cacheTtlSeconds?: number; fetchImpl?: typeof fetch;
}

// ── name helpers (ports of discover_web.py) ──────────────────────────────────
const _JACCARD_STOPS = new Set(["ltd", "limited", "plc", "llp", "uk", "the", "and", "of", "co", "company", "group"]);
export function jaccardSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const tok = (s: string) => new Set((s.toLowerCase().match(/[a-z]+/g) ?? []).filter((t) => !_JACCARD_STOPS.has(t)));
  const A = tok(a), B = tok(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

function cleanOfficerName(raw: string): string {
  const name = (raw || "").trim();
  if (name.includes(",")) {
    const i = name.indexOf(",");
    const surname = name.slice(0, i).trim();
    const forename = name.slice(i + 1).trim();
    const title = surname.replace(/\b\w/g, (c) => c.toUpperCase());
    return (forename ? `${forename} ${title}` : title).trim().replace(/^[,\s]+|[,\s]+$/g, "");
  }
  return name.replace(/^[,\s]+|[,\s]+$/g, "");
}
const _ROLE_PRIORITY = ["finance-director", "managing-director", "chief-executive", "chief-financial-officer", "commercial-director", "director", "company-secretary"];
export function extractDirector(officers: ChOfficer[]): { name: string; role: string } | null {
  const norm = (r: string) => (r || "").toLowerCase().replace(/\s+/g, "-");
  for (const role of _ROLE_PRIORITY) {
    for (const o of officers) if (norm(o.officer_role || "").includes(role)) return { name: cleanOfficerName(o.name || ""), role: o.officer_role || "Director" };
  }
  if (officers.length) return { name: cleanOfficerName(officers[0]!.name || ""), role: officers[0]!.officer_role || "Officer" };
  return null;
}

// ── client ───────────────────────────────────────────────────────────────────
export class ChClient {
  private apiKey: string;
  private cache: FileCache;
  private maxCalls: number;
  private timeoutMs: number;
  private slowMs: number;
  private ttl: number;
  private fetchImpl: typeof fetch;
  callsMade = 0;
  budgetMsgLogged = false;
  stats = { httpCalls: 0, cacheHits: 0, slow: 0, timeouts: 0, errors: 0, empty: 0, budgetStopped: false };

  constructor(o: ChClientOptions = {}) {
    this.apiKey = o.apiKey ?? process.env.COMPANIES_HOUSE_API_KEY ?? "";
    this.cache = new FileCache(o.cachePath ?? resolve(repoRoot(), "data/cache/companies_house.json"));
    this.maxCalls = o.maxCalls ?? Number(process.env.MAX_COMPANIES_HOUSE_CALLS ?? "50");
    this.timeoutMs = o.timeoutMs ?? Number(process.env.CH_READ_TIMEOUT_MS ?? "8000");
    this.slowMs = o.slowMs ?? Number(process.env.CH_SLOW_THRESHOLD_MS ?? "5000");
    this.ttl = o.cacheTtlSeconds ?? Number(process.env.CH_CACHE_TTL_DAYS ?? "14") * 86400;
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  get enabled(): boolean { return !!this.apiKey; }

  private budgetOk(): boolean {
    if (this.callsMade >= this.maxCalls) {
      if (!this.budgetMsgLogged) { console.warn(`Reached MAX_COMPANIES_HOUSE_CALLS=${this.maxCalls} — stopping CH calls, continuing with cached/available data.`); this.budgetMsgLogged = true; }
      this.stats.budgetStopped = true;
      return false;
    }
    return true;
  }

  private async http(path: string): Promise<unknown | null> {
    if (!this.apiKey) return null;
    this.callsMade++; this.stats.httpCalls++;
    const t0 = Date.now();
    try {
      const res = await this.fetchImpl(`${CH_BASE}${path}`, {
        headers: { Authorization: `Basic ${Buffer.from(`${this.apiKey}:`).toString("base64")}`, Accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const dt = Date.now() - t0;
      if (dt >= this.slowMs) { this.stats.slow++; console.warn(`Slow CH call: ${(dt / 1000).toFixed(1)}s ${path}`); }
      if (res.status === 404) return null;
      if (!res.ok) { this.stats.errors++; return null; }
      return await res.json();
    } catch (e) {
      const name = e && typeof e === "object" && "name" in e ? String((e as { name: unknown }).name) : "";
      if (name === "TimeoutError" || name === "AbortError") { this.stats.timeouts++; console.warn(`CH timeout for ${path} after ~${this.timeoutMs}ms — skipping`); }
      else this.stats.errors++;
      return null;
    }
  }

  async search(query: string, n = 10): Promise<ChSearchItem[]> {
    const key = `search:${query.toLowerCase().trim()}|${n}`;
    const { hit, value } = this.cache.lookup(key, this.ttl);
    if (hit) { this.stats.cacheHits++; return Array.isArray(value) ? (value as ChSearchItem[]) : []; }
    if (!this.budgetOk()) return [];
    const j = (await this.http(`/search/companies?q=${encodeURIComponent(query)}&items_per_page=${n}`)) as { items?: ChSearchItem[] } | null;
    const items = j?.items ?? [];
    this.cache.store(key, items, items.length === 0);
    if (items.length === 0) this.stats.empty++;
    return items;
  }

  async profile(cn: string): Promise<ChProfile | null> {
    if (!cn) return null;
    const key = `profile:${cn}`;
    const { hit, value } = this.cache.lookup(key, this.ttl);
    if (hit) { this.stats.cacheHits++; return (value as ChProfile | null) ?? null; }
    if (!this.budgetOk()) return null;
    const j = (await this.http(`/company/${encodeURIComponent(cn)}`)) as ChProfile | null;
    this.cache.store(key, j, j === null);
    return j;
  }

  async officers(cn: string): Promise<ChOfficer[]> {
    if (!cn) return [];
    const key = `officers:${cn}`;
    const { hit, value } = this.cache.lookup(key, this.ttl);
    if (hit) { this.stats.cacheHits++; return Array.isArray(value) ? (value as ChOfficer[]) : []; }
    if (!this.budgetOk()) return [];
    const j = (await this.http(`/company/${encodeURIComponent(cn)}/officers?items_per_page=50`)) as { items?: ChOfficer[] } | null;
    const items = (j?.items ?? []).filter((o) => !o.resigned_on);
    this.cache.store(key, items, items.length === 0);
    return items;
  }

  /**
   * Persons with Significant Control. Often the *real* decision maker (owner)
   * vs the appointed director. Caller filters out ceased records.
   */
  async psc(cn: string): Promise<ChPsc[]> {
    if (!cn) return [];
    const key = `psc:${cn}`;
    const { hit, value } = this.cache.lookup(key, this.ttl);
    if (hit) { this.stats.cacheHits++; return Array.isArray(value) ? (value as ChPsc[]) : []; }
    if (!this.budgetOk()) return [];
    const j = (await this.http(`/company/${encodeURIComponent(cn)}/persons-with-significant-control`)) as { items?: ChPsc[] } | null;
    const items = (j?.items ?? []).filter((p) => !p.ceased_on);
    this.cache.store(key, items, items.length === 0);
    return items;
  }

  /** Recent filings (most-recent N). Useful as an activity signal — recent
   *  charges/mortgages/changes of name correlate with growth + trade finance. */
  async filings(cn: string, n = 10): Promise<ChFilingItem[]> {
    if (!cn) return [];
    const key = `filings:${cn}|${n}`;
    const { hit, value } = this.cache.lookup(key, this.ttl);
    if (hit) { this.stats.cacheHits++; return Array.isArray(value) ? (value as ChFilingItem[]) : []; }
    if (!this.budgetOk()) return [];
    const j = (await this.http(`/company/${encodeURIComponent(cn)}/filing-history?items_per_page=${n}`)) as { items?: ChFilingItem[] } | null;
    const items = j?.items ?? [];
    this.cache.store(key, items, items.length === 0);
    return items;
  }

  /** Charges summary — a recent outstanding charge often means active trade finance. */
  async charges(cn: string): Promise<ChChargesSummary | null> {
    if (!cn) return null;
    const key = `charges:${cn}`;
    const { hit, value } = this.cache.lookup(key, this.ttl);
    if (hit) { this.stats.cacheHits++; return (value as ChChargesSummary | null) ?? null; }
    if (!this.budgetOk()) return null;
    const j = (await this.http(`/company/${encodeURIComponent(cn)}/charges`)) as {
      total_count?: number; unfiltered_count?: number;
      items?: Array<{ status?: string }>;
    } | null;
    if (!j) { this.cache.store(key, null, true); return null; }
    let outstanding = 0, satisfied = 0;
    for (const c of j.items ?? []) {
      if ((c.status || "").toLowerCase().includes("outstanding")) outstanding++;
      else if ((c.status || "").toLowerCase().includes("satisfied")) satisfied++;
    }
    const summary: ChChargesSummary = { total_count: j.total_count ?? (j.items?.length ?? 0), outstanding, satisfied };
    this.cache.store(key, summary, summary.total_count === 0);
    return summary;
  }

  /** Fuzzy-match a company name (Jaccard ≥ 0.35), then enrich with profile + officers. */
  async validate(companyName: string): Promise<ChValidation | null> {
    if (!companyName || !this.apiKey) return null;
    const items = await this.search(companyName, 5);
    if (!items.length) return null;
    let best: ChSearchItem | null = null, bestScore = 0;
    for (const it of items) { const s = jaccardSimilarity(companyName, it.title || ""); if (s > bestScore) { bestScore = s; best = it; } }
    if (!best || bestScore < 0.35 || !best.company_number) return null;
    const profile = await this.profile(best.company_number);
    if (!profile) return null;
    const officers = await this.officers(best.company_number);
    const dir = extractDirector(officers);
    const addr = profile.registered_office_address ?? {};
    const addrStr = [addr["address_line_1"], addr["locality"], addr["postal_code"]].filter(Boolean).join(", ");
    return {
      company_number: best.company_number, company_name: best.title || "",
      company_status: (profile.company_status || "").toLowerCase(),
      sic_codes: (profile.sic_codes ?? []).map(String),
      incorporated: profile.date_of_creation || "", registered_address: addrStr,
      director_name: dir?.name ?? null, director_role: dir?.role ?? null,
      ch_name_match: Math.round(bestScore * 1000) / 1000,
      ch_confidence: bestScore >= 0.7 ? "high" : bestScore >= 0.5 ? "medium" : "low",
    };
  }

  flush(): void { this.cache.flush(this.ttl); }
}

/** Extract the most-specific industry keyword from a search query for the CH fallback.
 *  '"wine importer" UK wholesale' → "wine importer"; 'delicatessen wholesale UK' → "delicatessen". */
const _CH_GENERIC = new Set(["uk", "british", "england", "london", "importer", "exporter", "imports", "exports", "import", "export", "wholesale", "wholesaler", "supplier", "distributor", "manufacturer", "company", "business", "trade", "b2b"]);
export function coreKeyword(query: string): string {
  const quoted = query.match(/"([^"]+)"/);
  if (quoted) return quoted[1]!;
  const toks = query.split(/\s+/).filter((t) => t.length > 3 && !_CH_GENERIC.has(t.toLowerCase()));
  return toks.slice(0, 2).join(" ") || (query.split(/\s+/)[0] ?? "");
}
