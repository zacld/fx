/**
 * stages/enrich-ch-accounts.ts — TS port of scripts/enrich_ch_accounts.py:
 * what each lead's latest filed accounts say about its size, for the lead
 * card's size badge and for scoring (accounts_type: micro-entities aren't
 * lifted).
 *
 * For each lead with a Companies House number, from the latest accounts filing:
 *   accounts_type       "micro-entity" | "small" | "medium" | "full" | "abridged" | "dormant" | "group" | "unknown"
 *   last_accounts_date  period end (ISO)
 *   company_size_band   "<£1m" | "£1m–£5m" | "£5m–£25m" | "£25m–£100m" | "£100m+" | "dormant" | "unknown"
 *   employee_count, employee_band, net_assets, total_assets, turnover_amount
 *   accounts_source     "ch_ixbrl" | "ch_filing_description"
 *
 * Size from turnover when tagged, else from net assets (abridged / micro
 * accounts). A lead already done is skipped; one whose lookup failed is tried
 * again after RETRY_DAYS (the Python script retried every failure every run).
 * Within FX_ACCOUNTS_BUDGET_MIN and the pipeline deadline (sources/deadline.ts).
 *
 * CLI: tsx src/stages/enrich-ch-accounts.ts [--db data/fx.db] [--out data/leads.json] [--force]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LeadSchema, repoRoot, type Lead } from "@fx/core";
import { getDb, schema } from "@fx/core/db";
import { stageDeadline } from "../sources/deadline.js";

const CH_API = "https://api.company-information.service.gov.uk";
const REQ_DELAY_MS = 500;   // CH allows 600 requests / 5 min
const RETRY_DAYS = 14;
const DEFAULT_BUDGET_MIN = Number(process.env.FX_ACCOUNTS_BUDGET_MIN ?? "4");

// ── Pure helpers (tested) ─────────────────────────────────────────────────────
export function sizeBandFromTurnover(t: number | null | undefined): string {
  if (t == null || t < 0) return "unknown";
  if (t < 1_000_000) return "<£1m";
  if (t < 5_000_000) return "£1m–£5m";
  if (t < 25_000_000) return "£5m–£25m";
  if (t < 100_000_000) return "£25m–£100m";
  return "£100m+";
}

/** Size when turnover isn't disclosed (abridged / micro accounts). */
export function sizeBandFromNetAssets(na: number | null | undefined): string {
  if (na == null || na < 0) return "unknown";
  if (na < 316_000) return "<£1m";         // micro / very small
  if (na < 5_100_000) return "£1m–£5m";    // small company range
  if (na < 18_000_000) return "£5m–£25m";  // medium lower end
  return "£25m–£100m";
}

export function employeeBand(n: number | null | undefined): string {
  if (n == null) return "unknown";
  if (n < 5) return "1–4";
  if (n < 10) return "5–9";
  if (n < 25) return "10–24";
  if (n < 50) return "25–49";
  if (n < 100) return "50–99";
  if (n < 250) return "100–249";
  return "250+";
}

export interface Filing { type?: string; description?: string; date?: string;
  description_values?: { made_up_date?: string }; links?: { document_metadata?: string } }

export function inferAccountsType(filing: Filing): string {
  const desc = (filing.description ?? "").toLowerCase();
  const type = (filing.type ?? "").toUpperCase();
  if (type === "AA01" || type === "AA02" || desc.includes("dormant")) return "dormant";
  if (desc.includes("micro-entity") || desc.includes("micro entity") || type === "MCS" || type === "MCSA") return "micro-entity";
  if (desc.includes("abridged")) return "abridged";
  if (desc.includes("small")) return "small";
  if (desc.includes("medium")) return "medium";
  if (desc.includes("group") || desc.includes("consolidated")) return "group";
  if (type === "AA" || type === "AAMD") return "full";
  return "unknown";
}

const TURNOVER = new Set(["TurnoverRevenue", "Revenue", "Turnover", "TurnoverGrossProceeds"]);
const NET_ASSETS = new Set(["NetAssetsLiabilities", "NetAssets"]);
const TOTAL_ASSETS = new Set(["TotalAssetsLessCurrentLiabilities", "Assets", "GrossAssets"]);
const EMPLOYEES = new Set(["AverageNumberEmployeesDuringPeriod", "NumberEmployees", "AverageNumberPersonsEmployedDuringPeriod"]);
const IXBRL_RE = /<ix:nonFraction\b([^>]+)>([-0-9,. –]+)<\/ix:nonFraction>/gi;

/** Heuristic as in the Python: "current", "cfwd", "FY_", "cy" or a recent year in the context id. */
function isCurrentPeriod(ctx: string): boolean {
  const r = ctx.toLowerCase();
  return ["current", "cfwd", "fy_", "cy", "2023", "2024", "2025", "2026"].some((k) => r.includes(k));
}

export interface Financials { turnover: number | null; netAssets: number | null; totalAssets: number | null; employees: number | null }

/** Turnover, net assets, total assets and employees from an iXBRL document (value × 10^scale). */
export function parseIxbrlFinancials(text: string): Financials {
  const out: Financials = { turnover: null, netAssets: null, totalAssets: null, employees: null };
  for (const m of text.matchAll(IXBRL_RE)) {
    const attrs = m[1] ?? "";
    const raw = (m[2] ?? "").trim().replace(/,/g, "").replace(/–/g, "-").replace(/ /g, "");
    if (!raw || raw === "-") continue;
    const name = /\bname="([^"]+)"/i.exec(attrs)?.[1];
    if (!name) continue;
    const concept = name.split(":").pop()!;
    const scale = Number(/\bscale="(-?\d+)"/i.exec(attrs)?.[1] ?? "0");
    const unit = (/\bunitRef="([^"]+)"/i.exec(attrs)?.[1] ?? "").toUpperCase();
    const ctx = /\bcontextRef="([^"]+)"/i.exec(attrs)?.[1] ?? "";
    const value = Number(raw) * 10 ** scale;
    if (!Number.isFinite(value)) continue;
    const gbp = unit.includes("GBP") || unit.includes("POUND");
    const pure = unit === "" || unit.includes("PURE");
    if (TURNOVER.has(concept) && gbp && out.turnover == null) out.turnover = value;
    else if (NET_ASSETS.has(concept) && gbp && isCurrentPeriod(ctx) && out.netAssets == null) out.netAssets = value;
    else if (TOTAL_ASSETS.has(concept) && gbp && isCurrentPeriod(ctx) && out.totalAssets == null) out.totalAssets = value;
    else if (EMPLOYEES.has(concept) && pure && isCurrentPeriod(ctx) && out.employees == null) {
      const n = Math.trunc(value);
      if (n > 0 && n < 100_000) out.employees = n;
    }
  }
  return out;
}

/** The lead fields from a filing and what its iXBRL says (null when there's no iXBRL). */
export function accountsFields(filing: Filing, fin: Financials | null): Record<string, unknown> {
  const type = inferAccountsType(filing);
  const f: Record<string, unknown> = {
    accounts_type: type,
    last_accounts_date: (filing.description_values?.made_up_date ?? filing.date ?? "").slice(0, 10),
    accounts_source: fin ? "ch_ixbrl" : "ch_filing_description",
  };
  if (type === "dormant") return { ...f, company_size_band: "dormant" };
  if (fin?.turnover != null) {
    f.turnover_amount = Math.round(fin.turnover);
    f.company_size_band = sizeBandFromTurnover(fin.turnover);
  } else if (type === "micro-entity") f.company_size_band = "<£1m";
  else if (fin?.netAssets != null) f.company_size_band = sizeBandFromNetAssets(fin.netAssets);
  else f.company_size_band = "unknown";
  if (fin?.netAssets != null) f.net_assets = Math.round(fin.netAssets);
  if (fin?.totalAssets != null) f.total_assets = Math.round(fin.totalAssets);
  if (fin?.employees != null) { f.employee_count = fin.employees; f.employee_band = employeeBand(fin.employees); }
  return f;
}

// ── Companies House ──────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function auth(): string {
  return `Basic ${Buffer.from(`${process.env.COMPANIES_HOUSE_API_KEY ?? ""}:`).toString("base64")}`;
}

async function chGet(url: string, accept = "application/json", timeoutMs = 12_000): Promise<Response | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { Authorization: auth(), Accept: accept }, signal: AbortSignal.timeout(timeoutMs) });
      await sleep(REQ_DELAY_MS);
      if (res.status === 429 && attempt === 0) { await sleep(10_000); continue; }
      return res.ok ? res : null;
    } catch { return null; }
  }
  return null;
}

async function latestAccountsFiling(cn: string): Promise<Filing | null> {
  const res = await chGet(`${CH_API}/company/${cn}/filing-history?category=accounts&items_per_page=10`);
  if (!res) return null;
  const items = ((await res.json()) as { items?: Filing[] }).items ?? [];
  return items.find((i) => ["AA", "AAMD", "MCS", "MCSA", "AA01", "AA02"].includes((i.type ?? "").toUpperCase())) ?? items[0] ?? null;
}

async function ixbrlDocument(filing: Filing): Promise<string | null> {
  const metaUrl = filing.links?.document_metadata;
  if (!metaUrl) return null;
  const meta = await chGet(metaUrl);
  if (!meta) return null;
  const m = (await meta.json()) as { links?: { document?: string; self?: string }; resources?: Record<string, unknown> };
  const contentUrl = m.links?.document ?? m.links?.self;
  if (!contentUrl || !m.resources || !("application/xhtml+xml" in m.resources)) return null;
  const doc = await chGet(contentUrl, "application/xhtml+xml, application/xml;q=0.9", 20_000);
  const text = doc ? await doc.text() : "";
  return text.length > 200 ? text : null;
}

// ── Stage ────────────────────────────────────────────────────────────────────
export interface ChAccountsOptions { dbPath?: string; outPath?: string; force?: boolean; budgetMinutes?: number }

export async function runEnrichChAccountsStage(opts: ChAccountsOptions = {}) {
  const root = repoRoot();
  const dbPath = opts.dbPath ?? resolve(root, "data/fx.db");
  const outPath = opts.outPath ?? resolve(root, "data/leads.json");
  // ...or earlier, leaving call readiness, drafts and export time before the pipeline's end
  const deadline = stageDeadline(opts.budgetMinutes ?? DEFAULT_BUDGET_MIN, 3);
  const counts = { enriched: 0, failed: 0, leftForNextRun: 0, due: 0 };
  if (!process.env.COMPANIES_HOUSE_API_KEY) {
    console.log("enrich-ch-accounts: COMPANIES_HOUSE_API_KEY not set — skipped");
    return counts;
  }
  const { db, sqlite, close } = getDb(dbPath);
  try {
    const leads: Record<string, Lead> = {};
    for (const row of db.select().from(schema.leads).all()) {
      const p = LeadSchema.safeParse(row.data);
      leads[row.id] = p.success ? p.data : (row.data as Lead);
    }
    const due = Object.values(leads).filter((l) => {
      const any = l as Record<string, unknown>;
      if (!l.company_number) return false;
      if (opts.force) return true;
      if (any.accounts_type) return false;
      const tried = any.accounts_checked_at as string | undefined;
      return !tried || (Date.now() - new Date(tried).getTime()) / 86_400_000 >= RETRY_DAYS;
    });
    counts.due = due.length;
    for (const lead of due) {
      if (Date.now() >= deadline) { counts.leftForNextRun = due.length - counts.enriched - counts.failed; break; }
      const any = lead as Record<string, unknown>;
      any.accounts_checked_at = new Date().toISOString();
      const cn = String(lead.company_number).trim().toUpperCase().padStart(8, "0");
      const filing = await latestAccountsFiling(cn);
      if (!filing) { counts.failed++; continue; }
      const fin = inferAccountsType(filing) === "dormant" ? null : await ixbrlDocument(filing).then((d) => d && parseIxbrlFinancials(d));
      Object.assign(any, accountsFields(filing, fin || null));
      counts.enriched++;
    }
    const upd = sqlite.prepare(`UPDATE leads SET data=@data WHERE id=@id`);
    sqlite.transaction(() => { for (const l of due) upd.run({ id: l.id, data: JSON.stringify(l) }); })();
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(leads, null, 2));
    return counts;
  } finally {
    close();
  }
}

const isMain = (() => { try { return !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  runEnrichChAccountsStage({ dbPath: arg("--db"), outPath: arg("--out"), force: argv.includes("--force"),
    budgetMinutes: arg("--budget-min") ? Number(arg("--budget-min")) : undefined })
    .then((c) => {
      console.log(`enrich-ch-accounts: due ${c.due} | enriched ${c.enriched} | no filing ${c.failed} | left for next run ${c.leftForNextRun}`);
      process.exit(0);
    })
    .catch((e) => { console.error("enrich-ch-accounts failed:", e); process.exit(1); });
}
