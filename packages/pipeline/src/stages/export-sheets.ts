/**
 * stages/export-sheets.ts — push the Daily Call List (top 25 HOT by ready_score)
 * to a Google Sheet. Optional last stage of the pipeline; skipped silently when
 * GOOGLE_SHEET_ID is not set so this is non-blocking on local / unconfigured runs.
 *
 * Env contract:
 *   GOOGLE_SHEET_ID                — destination spreadsheet ID (URL fragment)
 *   GOOGLE_SERVICE_ACCOUNT_KEY     — full service-account JSON, raw or base64
 *   GOOGLE_SHEET_TAB    (optional) — tab name; default "Daily Call List"
 *   FX_EXPORT_LIMIT     (optional) — number of leads to export; default 25
 *
 * Behaviour: clears the target tab's first 1000 rows, then writes a header row +
 * up-to-N call-ready rows. Designed to overwrite each run — Zac always sees the
 * latest list, not yesterday's plus today's.
 *
 * CLI:  tsx src/stages/export-sheets.ts [--db data/fx.db] [--limit N] [--tab "..."]
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LeadSchema, repoRoot, type Lead } from "@fx/core";
import { getDb, schema } from "@fx/core/db";
import { RunRecorder } from "../run.js";
import { parseServiceAccount, getAccessToken, updateRange, clearRange } from "../sources/google-sheets.js";

const HEADERS = [
  "Rank", "Ready score", "Score", "Priority", "Company", "Website",
  "Segment", "Event", "Director", "Role", "Phone", "Email", "Route grade",
  "FX signals (n)", "FX signals", "Why now", "Exposure thesis",
  "LinkedIn (company)", "LinkedIn (director)", "Rescored at",
] as const;

function pickPhone(lead: Lead): string {
  const e164 = (lead as Record<string, unknown>).contact_phones_e164 as string[] | undefined;
  if (e164?.length) return e164[0]!;
  return lead.contact_phone ?? "";
}
function pickEmail(lead: Lead): string {
  if (lead.contact_email) return lead.contact_email;
  const dms = (lead as Record<string, unknown>).decision_makers as Array<Record<string, unknown>> | undefined;
  const dm = dms?.find((d) => d.email) ?? dms?.find((d) => d.email_candidate);
  return (dm?.email as string | undefined) ?? (dm?.email_candidate as string | undefined) ?? "";
}
function pickDirectorLinkedIn(lead: Lead): string {
  const dms = (lead as Record<string, unknown>).decision_makers as Array<Record<string, unknown>> | undefined;
  return (dms?.[0]?.linkedin_search as string | undefined) ?? (lead as Record<string, unknown>).linkedin_url as string ?? "";
}
function clip(s: string | null | undefined, n: number): string {
  const v = (s ?? "").replace(/\s+/g, " ").trim();
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
}

export function buildSheetRows(leads: Lead[], limit: number): Array<Array<string | number>> {
  const ranked = leads
    .filter((l) => l.priority === "HOT" && (l.ready_score ?? 0) > 0)
    .sort((a, b) => (b.ready_score ?? 0) - (a.ready_score ?? 0))
    .slice(0, limit);
  return ranked.map((l, i) => [
    i + 1,
    l.ready_score ?? 0,
    l.score ?? 0,
    l.priority ?? "",
    l.company_name ?? "",
    l.website ?? "",
    l.segment_name ?? "",
    (l as Record<string, unknown>).event_headline as string ?? l.trigger_headline ?? "",
    l.director_name ?? "",
    l.director_role ?? "",
    pickPhone(l),
    pickEmail(l),
    (l as Record<string, unknown>).route_grade as string ?? "",
    (l.fx_payment_signals ?? []).length,
    (l.fx_payment_signals ?? []).slice(0, 5).join(", "),
    clip(l.why_affected ?? (l as Record<string, unknown>).why_financially_exposed as string ?? "", 280),
    clip(l.exposure_thesis ?? "", 280),
    (l as Record<string, unknown>).company_linkedin as string ?? "",
    pickDirectorLinkedIn(l),
    l.rescored_at ?? "",
  ]);
}

export interface ExportSheetsOptions {
  dbPath?: string; runsDir?: string;
  spreadsheetId?: string; serviceAccountKey?: string;
  tab?: string; limit?: number; persist?: boolean;
}
export interface ExportSheetsResult { totalLeads: number; exported: number; skipped: boolean; reason?: string; runId: string; }

export async function runExportSheetsStage(opts: ExportSheetsOptions = {}): Promise<ExportSheetsResult> {
  const root = repoRoot();
  const dbPath = opts.dbPath ?? resolve(root, "data/fx.db");
  const runsDir = opts.runsDir ?? resolve(root, "data/runs");
  const persist = opts.persist ?? true;
  const spreadsheetId = opts.spreadsheetId ?? process.env.GOOGLE_SHEET_ID ?? "";
  const saKeyRaw = opts.serviceAccountKey ?? process.env.GOOGLE_SERVICE_ACCOUNT_KEY ?? "";
  const tab = opts.tab ?? process.env.GOOGLE_SHEET_TAB ?? "Daily Call List";
  const limit = opts.limit ?? (Number(process.env.FX_EXPORT_LIMIT ?? "25") || 25);

  const rec = new RunRecorder("export-sheets", { spreadsheetId: !!spreadsheetId, tab, limit });

  // Skip cleanly when the env isn't configured — local runs and PRs shouldn't
  // need the secret to succeed.
  if (!spreadsheetId || !saKeyRaw) {
    const reason = !spreadsheetId ? "GOOGLE_SHEET_ID not set" : "GOOGLE_SERVICE_ACCOUNT_KEY not set";
    console.log(`export-sheets: skipped — ${reason}`);
    return { totalLeads: 0, exported: 0, skipped: true, reason, runId: rec.run.run_id };
  }

  const { db, sqlite, close } = getDb(dbPath);
  try {
    const leads: Lead[] = [];
    for (const row of db.select().from(schema.leads).all()) {
      const p = LeadSchema.safeParse(row.data);
      leads.push(p.success ? p.data : (row.data as Lead));
    }
    const rows = buildSheetRows(leads, limit);

    const sa = parseServiceAccount(saKeyRaw);
    const accessToken = await getAccessToken(sa);

    // Clear yesterday's rows so a 12-row export doesn't leave 25-row stragglers.
    await clearRange({ accessToken, spreadsheetId, range: `${tab}!A1:Z1000` });
    await updateRange({
      accessToken, spreadsheetId, range: `${tab}!A1`,
      values: [HEADERS as unknown as string[], ...rows],
    });

    rec.section("lead_stats", { total_leads: leads.length, exported: rows.length, tab, spreadsheet_id: spreadsheetId });
    if (persist) rec.finish(sqlite, runsDir);
    console.log(`export-sheets: wrote ${rows.length} rows to "${tab}" of ${spreadsheetId}`);
    return { totalLeads: leads.length, exported: rows.length, skipped: false, runId: rec.run.run_id };
  } finally {
    close();
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): ExportSheetsOptions {
  const o: ExportSheetsOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") o.dbPath = argv[++i];
    else if (a === "--runs") o.runsDir = argv[++i];
    else if (a === "--tab") o.tab = argv[++i];
    else if (a === "--limit") o.limit = Number(argv[++i]);
    else if (a === "--sheet") o.spreadsheetId = argv[++i];
  }
  return o;
}
const isMain = (() => { try { return !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  runExportSheetsStage(parseArgs(process.argv.slice(2))).then((r) => {
    if (r.skipped) console.log(`export-sheets: skipped (${r.reason}) — run_id ${r.runId}`);
    else console.log(`export-sheets: ${r.exported}/${r.totalLeads} leads exported | run_id ${r.runId}`);
  }).catch((e) => { console.error("export-sheets failed:", e); process.exitCode = 1; });
}
