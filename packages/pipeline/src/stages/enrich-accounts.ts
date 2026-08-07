/**
 * stages/enrich-accounts.ts — fetches Companies House accounts for each lead
 * and estimates whether the company could plausibly do £100k+/month in FX.
 *
 * For each lead with a company_number:
 *   1. Fetches the latest annual accounts filing from CH filing history
 *   2. If iXBRL available: parses turnover (or balance sheet proxy if filleted)
 *   3. If PDF only: uses accounts_type + employee count from company profile
 *   4. Sets lead.annual_turnover, lead.employee_count, lead.fx_size_check,
 *      lead.fx_size_reason, lead.accounts_year_end on the lead
 *
 * Threshold for £100k/month FX:
 *   - If turnover known: ≥ £1.2m/year
 *   - If filleted accounts (no turnover): current_assets ≥ £200k
 *     AND employees ≥ 3 (or assets ≥ £1m regardless)
 *   - Accounts type "full" (large company > £10.2m) → always pass
 *   - Accounts type "micro" → always fail (already filtered in export)
 *   - No accounts filed → unknown
 *
 * CLI: tsx src/stages/enrich-accounts.ts [--db data/fx.db] [--limit N]
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "@fx/core";
import { getDb } from "@fx/core/db";

const CH_BASE = "https://api.company-information.service.gov.uk";
const DOC_BASE = "https://document-api.company-information.service.gov.uk";

function chAuth(): string {
  const key = process.env.COMPANIES_HOUSE_API_KEY ?? "";
  return `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function chFetch<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${CH_BASE}${path}`, {
      headers: { Authorization: chAuth(), Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch { return null; }
}

interface FilingItem {
  type: string;
  date: string;
  description?: string;
  links?: { document_metadata?: string };
}

interface AccountsResult {
  turnover: number | null;
  currentAssets: number | null;
  totalAssets: number | null;
  netAssets: number | null;
  employees: number | null;
  accountsType: string | null;
  yearEnd: string | null;
  source: "xbrl" | "profile" | "none";
  // FX exposure fields — extracted from accounts notes
  fxCreditorsGbp: number | null;
  fxDebtorsGbp: number | null;
  fxCurrencies: string[];
  fxHasPolicy: boolean;
  fxHasHedging: boolean;
}

const CURRENCY_CODES = ["EUR", "USD", "CHF", "JPY", "AUD", "CAD", "DKK", "NOK", "SEK", "CNY", "HKD", "SGD", "ZAR", "NZD", "PLN", "CZK"];

/** Detect currency codes mentioned near FX-related text in accounts HTML */
function extractFxFromText(html: string): Pick<AccountsResult, "fxCreditorsGbp" | "fxDebtorsGbp" | "fxCurrencies" | "fxHasPolicy" | "fxHasHedging"> {
  // Strip tags for text analysis, but preserve enough structure
  const text = html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

  // Detect currency codes
  const currencies = new Set<string>();
  for (const code of CURRENCY_CODES) {
    if (new RegExp(`\\b${code}\\b`, "i").test(text)) currencies.add(code);
  }
  // Also detect written forms
  if (/\beuro(s)?\b/i.test(text)) currencies.add("EUR");
  if (/\bdollar(s)?\b/i.test(text)) currencies.add("USD");

  // Detect FX risk policy / hedging mentions
  const fxHasPolicy = /foreign.{0,20}currency.{0,40}(policy|risk|exposure|management)/i.test(text) ||
    /currency.{0,20}risk.{0,20}(policy|management|exposure)/i.test(text);
  const fxHasHedging = /(hedg(ing|ed)|forward contract|currency swap|fx (cover|hedge|risk))/i.test(text);

  // Extract GBP amounts near foreign currency creditor/debtor mentions
  // Pattern: "trade creditors denominated in [currency] of £X,XXX" or "foreign currency creditors £X"
  const creditorPattern = /(?:foreign.{0,30}creditor|creditor.{0,30}foreign|trade.{0,20}creditor.{0,60}(?:EUR|USD|euro|dollar)|(?:EUR|USD|euro|dollar).{0,60}creditor)[^£\n]{0,80}£\s*([\d,]+)/gi;
  const debtorPattern  = /(?:foreign.{0,30}debtor|debtor.{0,30}foreign|trade.{0,20}debtor.{0,60}(?:EUR|USD|euro|dollar)|(?:EUR|USD|euro|dollar).{0,60}debtor)[^£\n]{0,80}£\s*([\d,]+)/gi;

  const pickAmount = (pattern: RegExp): number | null => {
    const match = pattern.exec(text);
    if (!match) return null;
    const n = parseFloat((match[1] ?? "").replace(/,/g, ""));
    return isNaN(n) || n <= 0 ? null : n;
  };

  return {
    fxCreditorsGbp: pickAmount(creditorPattern),
    fxDebtorsGbp: pickAmount(debtorPattern),
    fxCurrencies: [...currencies],
    fxHasPolicy,
    fxHasHedging,
  };
}

/** Parse iXBRL document for key financial metrics */
async function parseXbrl(docId: string): Promise<Partial<AccountsResult>> {
  const contentRes = await fetch(`${DOC_BASE}/document/${docId}/content`, {
    headers: { Authorization: chAuth(), Accept: "application/xhtml+xml" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!contentRes.ok) return {};
  const xhtml = await contentRes.text();

  const tagPattern = /<ix:nonFraction[^>]*name="([^"]+)"[^>]*(?:scale="(-?\d+)")?[^>]*>\s*([-\d,.£ ]+)\s*<\/ix:nonFraction>/gi;
  const tags = [...xhtml.matchAll(tagPattern)];

  const pick = (keySubstrings: string[]): number | null => {
    for (const m of tags) {
      const name = (m[1] ?? "").split(":").pop()?.toLowerCase() ?? "";
      if (keySubstrings.some((k) => name.includes(k))) {
        const scale = parseInt(m[2] ?? "0");
        const raw = parseFloat((m[3] ?? "").replace(/[£,\s]/g, ""));
        if (!isNaN(raw) && raw > 0) return Math.round(raw * Math.pow(10, scale));
      }
    }
    return null;
  };

  // Also try XBRL-tagged FX amounts (less reliable than text, but worth checking)
  const fxCredTag = pick(["foreigncurrencycreditor", "foreigncurrencymonetaryliab"]);
  const fxDebtTag = pick(["foreigncurrencydebtor", "foreigncurrencymonetaryasset"]);

  const fxFromText = extractFxFromText(xhtml);

  return {
    turnover: pick(["turnover", "revenue"]),
    currentAssets: pick(["currentasset"]),
    totalAssets: pick(["totalasset", "totalbalance"]),
    netAssets: pick(["netasset", "equity", "netliabiili", "totalequity"]),
    employees: pick(["numberemployee", "averagenumberemployee"]),
    source: "xbrl",
    fxCreditorsGbp: fxCredTag ?? fxFromText.fxCreditorsGbp,
    fxDebtorsGbp:   fxDebtTag ?? fxFromText.fxDebtorsGbp,
    fxCurrencies:   fxFromText.fxCurrencies,
    fxHasPolicy:    fxFromText.fxHasPolicy,
    fxHasHedging:   fxFromText.fxHasHedging,
  };
}

/** Fetch latest accounts data for a company */
async function fetchAccountsData(companyNumber: string): Promise<AccountsResult> {
  const result: AccountsResult = {
    turnover: null, currentAssets: null, totalAssets: null,
    netAssets: null, employees: null, accountsType: null,
    yearEnd: null, source: "none",
    fxCreditorsGbp: null, fxDebtorsGbp: null,
    fxCurrencies: [], fxHasPolicy: false, fxHasHedging: false,
  };

  // 1. Filing history
  const history = await chFetch<{ items: FilingItem[] }>(
    `/company/${companyNumber}/filing-history?category=accounts&items_per_page=3`,
  );

  const latest = history?.items?.find((i) =>
    ["AA", "AAMD", "AA01", "ACCOUNTS"].some((t) => i.type.startsWith(t)),
  );

  if (latest) {
    result.yearEnd = latest.date;
    const desc = latest.description ?? "";
    // IMPORTANT: "total-exemption-full" = small company (exemption from audit), NOT large.
    // Only "accounts-type-full" WITHOUT "total-exemption" means genuinely large company.
    if (desc.includes("dormant")) result.accountsType = "dormant";
    else if (desc.includes("micro")) result.accountsType = "micro";
    else if (desc.includes("total-exemption")) result.accountsType = "small"; // small with audit exemption
    else if (desc.includes("abridged")) result.accountsType = "small";
    else if (desc.includes("small")) result.accountsType = "small";
    else if (desc.match(/accounts-type-full/)) result.accountsType = "full"; // genuine large company
    else if (desc.includes("group")) result.accountsType = "full"; // group accounts = large
  }

  // 2. Try XBRL if there's a document
  if (latest?.links?.document_metadata) {
    const docId = latest.links.document_metadata.split("/").pop()!;
    await sleep(300);

    // Check available formats
    const metaRes = await fetch(`${DOC_BASE}/document/${docId}`, {
      headers: { Authorization: chAuth() }, signal: AbortSignal.timeout(8_000),
    }).catch(() => null);
    const meta = metaRes?.ok ? (await metaRes.json() as { resources?: Record<string, unknown> }) : null;

    if (meta?.resources?.["application/xhtml+xml"]) {
      await sleep(200);
      const xbrl = await parseXbrl(docId);
      Object.assign(result, xbrl);
    }
  }

  return result;
}

/** Decide if a company could plausibly do £100k/month in FX */
function fxSizeCheck(data: AccountsResult): { pass: boolean; reason: string } {
  // Full accounts = large company (> £10.2m turnover or > £5.1m BS) — always pass
  if (data.accountsType === "full") {
    return { pass: true, reason: "Full accounts filed (turnover > £10m likely)" };
  }
  // Dormant — always fail
  if (data.accountsType === "dormant") {
    return { pass: false, reason: "Dormant company" };
  }
  // Known turnover
  if (data.turnover !== null) {
    if (data.turnover >= 1_200_000) {
      return { pass: true, reason: `Turnover £${(data.turnover / 1e6).toFixed(1)}m ≥ £1.2m threshold` };
    }
    return { pass: false, reason: `Turnover £${data.turnover.toLocaleString()} — below £1.2m threshold` };
  }
  // No turnover (filleted) — use balance sheet proxies
  if (data.currentAssets !== null || data.netAssets !== null) {
    const assets = data.currentAssets ?? data.netAssets ?? 0;
    const emps = data.employees ?? 0;
    if (assets >= 1_000_000) {
      return { pass: true, reason: `Current assets £${(assets / 1e6).toFixed(1)}m — large enough` };
    }
    if (assets >= 200_000 && emps >= 3) {
      return { pass: true, reason: `Current assets £${(assets / 1000).toFixed(0)}k + ${emps} employees` };
    }
    if (assets >= 200_000) {
      return { pass: false, reason: `Current assets £${(assets / 1000).toFixed(0)}k but only ${emps} employees — too small` };
    }
    return { pass: false, reason: `Current assets £${assets.toLocaleString()} — below £200k threshold` };
  }
  // No financial data at all
  return { pass: false, reason: "No accounts data available" };
}

/** Grade FX priority A–D from accounts + lead signals */
function fxPriorityGrade(
  accounts: AccountsResult,
  fxSignals: string[],
  sicCodes: string[],
): { grade: "A" | "B" | "C" | "D"; evidence: string[] } {
  const evidence: string[] = [];
  const disclosed = (accounts.fxCreditorsGbp ?? 0) + (accounts.fxDebtorsGbp ?? 0);

  if (accounts.fxCreditorsGbp && accounts.fxCreditorsGbp > 0) {
    evidence.push(`Foreign-currency creditors disclosed in latest accounts (£${accounts.fxCreditorsGbp.toLocaleString()})`);
  }
  if (accounts.fxDebtorsGbp && accounts.fxDebtorsGbp > 0) {
    evidence.push(`Foreign-currency debtors disclosed in latest accounts (£${accounts.fxDebtorsGbp.toLocaleString()})`);
  }
  if (accounts.fxHasPolicy) evidence.push("Foreign currency risk management policy mentioned in accounts");
  if (accounts.fxHasHedging) evidence.push("Hedging activity referenced in accounts");
  if (fxSignals.length > 0) evidence.push(`${fxSignals.length} FX/overseas signal${fxSignals.length > 1 ? "s" : ""} found on website`);

  // Grade A: hard disclosed FX balance ≥ £100k
  if (disclosed >= 100_000) return { grade: "A", evidence };
  // Grade B: any disclosed FX balance, OR policy + overseas signals
  if (disclosed > 0 || (accounts.fxHasPolicy && fxSignals.length >= 1)) return { grade: "B", evidence };
  // Grade C: strong website FX signals + import/wholesale SIC
  const tier1Sic = ["46","50","51"].some(p => sicCodes.some(s => s.startsWith(p)));
  if (fxSignals.length >= 2 && tier1Sic) return { grade: "C", evidence };
  if (fxSignals.length >= 3) return { grade: "C", evidence };
  // Grade D: SIC-based only
  return { grade: "D", evidence };
}

/** Estimate annual FX opportunity range from available data */
function fxOpportunityRange(accounts: AccountsResult, sicCodes: string[]): { low: number; high: number; label: string } | null {
  const disclosed = (accounts.fxCreditorsGbp ?? 0) + (accounts.fxDebtorsGbp ?? 0);

  if (disclosed > 0) {
    // Creditor balance is a snapshot — annual flow is typically 3–8× the balance
    const low  = Math.round(disclosed * 3 / 100_000) * 100_000;
    const high = Math.round(disclosed * 8 / 100_000) * 100_000;
    return { low, high, label: fmtRange(low, high) };
  }
  if (accounts.turnover && accounts.turnover > 0) {
    // For importers/wholesalers assume 20–40% of turnover is foreign purchases
    const tier1 = ["46","50","51"].some(p => sicCodes.some(s => s.startsWith(p)));
    const pctLow  = tier1 ? 0.20 : 0.10;
    const pctHigh = tier1 ? 0.40 : 0.20;
    const low  = Math.round(accounts.turnover * pctLow  / 100_000) * 100_000;
    const high = Math.round(accounts.turnover * pctHigh / 100_000) * 100_000;
    if (low < 100_000) return null;
    return { low, high, label: fmtRange(low, high) };
  }
  return null;
}

function fmtRange(low: number, high: number): string {
  const f = (n: number) => n >= 1_000_000 ? `£${(n/1_000_000).toFixed(0)}m` : `£${(n/1_000).toFixed(0)}k`;
  return `${f(low)}–${f(high)}`;
}

/** Build a pre-call angle string from available evidence */
function buildCallAngle(
  accounts: AccountsResult,
  companyName: string,
  currencies: string[],
): string {
  const curs = currencies.length > 0
    ? currencies.slice(0, 2).map(c => c === "EUR" ? "euro" : c === "USD" ? "dollar" : c.toLowerCase()).join(" and ")
    : "foreign currency";

  if (accounts.fxCreditorsGbp && accounts.fxCreditorsGbp > 0) {
    return `From your latest accounts, you appear to have significant ${curs} supplier payments — around £${accounts.fxCreditorsGbp.toLocaleString()} in foreign currency trade creditors. How are you currently managing those payments?`;
  }
  if (accounts.fxHasPolicy || accounts.fxHasHedging) {
    return `Your accounts reference a foreign currency risk management policy — it looks like you have meaningful ${curs} exposure. How are you currently managing that?`;
  }
  return `From what I can see, you appear to purchase across multiple currencies. How are you currently managing your ${curs} supplier payments?`;
}

export interface EnrichAccountsOptions {
  dbPath?: string;
  limit?: number;
}

export async function runEnrichAccounts(opts: EnrichAccountsOptions = {}): Promise<{ processed: number; passed: number; failed: number; unknown: number }> {
  const root = repoRoot();
  const dbPath = opts.dbPath ?? resolve(root, "data/fx.db");
  const { sqlite, close } = getDb(dbPath);

  // Only process leads with a CH number and website that haven't been accounts-checked yet
  const rows = sqlite.prepare(`
    SELECT id, data FROM leads
    WHERE json_extract(data,'$.company_number') IS NOT NULL
    AND json_extract(data,'$.company_number') != ''
    AND json_extract(data,'$.website') IS NOT NULL
    AND json_extract(data,'$.fx_size_check') IS NULL
    AND json_extract(data,'$.priority') != 'SKIP'
    ${opts.limit ? `LIMIT ${opts.limit}` : ""}
  `).all() as Array<{ id: string; data: string }>;

  const updateLead = sqlite.prepare(`UPDATE leads SET data=@data WHERE id=@id`);

  let processed = 0, passed = 0, failed = 0, unknown = 0;

  for (const row of rows) {
    let lead: Record<string, unknown>;
    try { lead = JSON.parse(row.data); } catch { continue; }

    const companyNumber = lead.company_number as string;
    process.stdout.write(`  [${processed + 1}/${rows.length}] ${(lead.company_name as string)?.slice(0, 40)}… `);

    await sleep(600); // CH rate limit: ~1 req/sec
    const accountsData = await fetchAccountsData(companyNumber);
    const { pass, reason } = fxSizeCheck(accountsData);

    lead.annual_turnover = accountsData.turnover;
    lead.employee_count = accountsData.employees;
    lead.current_assets = accountsData.currentAssets;
    lead.net_assets = accountsData.netAssets;
    lead.accounts_year_end = accountsData.yearEnd;
    lead.accounts_type = accountsData.accountsType ?? lead.accounts_type;
    lead.fx_size_check = pass ? "pass" : (accountsData.source === "none" ? "unknown" : "fail");
    lead.fx_size_reason = reason;

    // FX exposure intelligence
    const sicCodes = ((lead.sic_codes as string[] | undefined) ?? []).map(String);
    const fxSignals = (lead.fx_payment_signals as string[] | undefined) ?? [];
    const { grade, evidence } = fxPriorityGrade(accountsData, fxSignals, sicCodes);
    const opportunity = fxOpportunityRange(accountsData, sicCodes);
    const allCurrencies = [
      ...accountsData.fxCurrencies,
      ...((lead.likely_currencies as string[] | undefined) ?? []),
    ].filter((v, i, a) => a.indexOf(v) === i);

    lead.fx_priority            = grade;
    lead.fx_creditors_gbp       = accountsData.fxCreditorsGbp;
    lead.fx_debtors_gbp         = accountsData.fxDebtorsGbp;
    lead.fx_currencies_detected = allCurrencies;
    lead.fx_has_policy          = accountsData.fxHasPolicy;
    lead.fx_has_hedging         = accountsData.fxHasHedging;
    lead.fx_opportunity_low     = opportunity?.low ?? null;
    lead.fx_opportunity_high    = opportunity?.high ?? null;
    lead.fx_opportunity_label   = opportunity?.label ?? "";
    lead.fx_evidence            = evidence;
    lead.fx_call_angle          = buildCallAngle(accountsData, String(lead.company_name ?? ""), allCurrencies);

    updateLead.run({ id: row.id, data: JSON.stringify(lead) });

    if (pass) { passed++; process.stdout.write(`✓ PASS — ${reason}\n`); }
    else if (accountsData.source === "none") { unknown++; process.stdout.write(`? UNKNOWN\n`); }
    else { failed++; process.stdout.write(`✗ FAIL — ${reason}\n`); }

    processed++;
  }

  close();
  return { processed, passed, failed, unknown };
}

// CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opts: EnrichAccountsOptions = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--db") opts.dbPath = args[++i];
    else if (args[i] === "--limit") opts.limit = Number(args[++i]);
  }

  console.log("enrich-accounts: checking Companies House accounts for FX size…");
  runEnrichAccounts(opts).then((r) => {
    console.log(`\nenrich-accounts: processed=${r.processed} | pass=${r.passed} | fail=${r.failed} | unknown=${r.unknown}`);
    process.exit(0);
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
