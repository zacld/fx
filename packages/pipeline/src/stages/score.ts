/**
 * stages/score.ts — the "score" pipeline stage (v2 equivalent of the scoring part
 * of scripts/rescore.py).
 *
 * Reads every lead from the SQLite DB, then for each lead:
 *   1. reclassifies legacy origin tokens — bare nationality adjectives move out of
 *      fx_payment_signals into secondary_signals / fx_origin_hints (port of the
 *      reclassify step in rescore.py main()), so scoring reflects v1 semantics.
 *   2. runs the gate-based scorer (@fx/core scoreLead — faithful port of
 *      rescore.py's rescore(), gates A–I), resolving event urgency from the events
 *      table.
 *   3. recomputes exposure_confidence, signal_count, and lead_type / awareness_level
 *      / saving_opportunity (port of rescore.py classify_lead).
 * Writes updated leads back to the DB, exports a {id: lead} JSON map to --out
 * (default public/data/leads.json, so the dashboard keeps working), and records a
 * `runs` row.
 *
 * NOT yet ported here (later stages): CN/domain dedup + multi-event boost (→ a
 * `dedup` stage), contact-route recompute (→ `enrich-contacts`). So this stage ≈
 * rescore.py minus those passes. It does NOT touch data/leads.json (the v1 pipeline
 * still owns that during the transition).
 *
 * CLI:  tsx src/stages/score.ts [--db data/fx.db] [--out public/data/leads.json] [--runs data/runs]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  scoreLead, exposureConfidence, isLargeOrg, bestContactRoute, ensureContactFields,
  WEAK_ORIGIN_TOKENS, LeadSchema, type Lead,
} from "@fx/core";
import { getDb, schema } from "@fx/core/db";
import { RunRecorder } from "../run.js";

const TRIGGER_BREADTHS = new Set(["broad_currency", "broad_macro", "tariff", "commodity"]);
const EVERGREEN_FREIGHT_SIC_PREFIXES = ["5010", "5020", "5110", "5121", "5122"];

interface EventInfo { breadth: string; urgency: number }

/** Move bare nationality adjectives out of fx_payment_signals → secondary_signals
 *  + fx_origin_hints (idempotent). Returns true if anything changed. */
export function reclassifyOriginTokens(lead: Lead): boolean {
  const raw = lead.fx_payment_signals ?? [];
  const weak = raw.filter((s) => WEAK_ORIGIN_TOKENS.has(String(s).toLowerCase()));
  if (weak.length === 0) return false;
  lead.fx_payment_signals = raw.filter((s) => !WEAK_ORIGIN_TOKENS.has(String(s).toLowerCase()));
  lead.secondary_signals = [...new Set([...(lead.secondary_signals ?? []), ...weak])];
  lead.fx_origin_hints = [...new Set([...(lead.fx_origin_hints ?? []), ...weak])];
  return true;
}

/** Port of rescore.py classify_lead → sets lead.lead_type / awareness_level / saving_opportunity. */
export function classifyLead(lead: Lead, event: EventInfo | undefined): void {
  const score = lead.score ?? 0;
  const multi = !!lead.multi_event_trigger;
  const sics = (lead.sic_codes ?? []).map((s) => String(s).trim()).filter(Boolean);
  const fxN = (lead.fx_payment_signals ?? []).length;
  const paidFx = !!lead.pays_fx_confirmed;
  const eventId = lead.event_id ?? "";
  const staleEvent = !!eventId && event === undefined;
  const isTrigger = !!eventId && (TRIGGER_BREADTHS.has(event?.breadth ?? "") || staleEvent);

  const inImportSic = sics.some((s) =>
    ["46", "47"].includes(s.slice(0, 2)) || EVERGREEN_FREIGHT_SIC_PREFIXES.some((p) => s.startsWith(p)));
  const inMfgSic = sics.some((s) => {
    const f2 = parseInt(s.slice(0, 2), 10);
    return Number.isFinite(f2) && f2 >= 10 && f2 <= 33;
  });
  const isEvergreen = (inImportSic && (fxN > 0 || paidFx)) || (inMfgSic && paidFx) || fxN >= 3;

  lead.lead_type = (multi || (isTrigger && isEvergreen)) ? "both" : isTrigger ? "trigger_exposed" : isEvergreen ? "evergreen_saving" : "unknown";
  lead.awareness_level = (fxN >= 3 || paidFx) ? "high" : fxN >= 1 ? "medium" : "low";
  lead.saving_opportunity = (score >= 85 && (fxN >= 2 || paidFx)) ? "high" : score >= 65 ? "medium" : "low";
}

/** Score & classify a single lead in place (no I/O). Exported for tests / reuse. */
export function scoreAndClassify(lead: Lead, event: EventInfo | undefined): { changedPriority: boolean; reclassified: boolean } {
  const reclassified = reclassifyOriginTokens(lead);
  // backfill is_large_org from name/website/snippet (mirrors rescore.py's backfill) — Gate I reads it
  lead.is_large_org = isLargeOrg(lead.company_name ?? "", lead.website ?? "", lead.website_snippet ?? "");
  const { score, priority, reasons } = scoreLead(lead, event?.urgency ?? 0);
  const changedPriority = priority !== lead.priority;
  lead.score = score;
  lead.priority = priority;
  lead.scoring_reasons = reasons;
  lead.exposure_confidence = exposureConfidence(lead);
  lead.signal_count = (lead.fx_payment_signals ?? []).length + (lead.secondary_signals ?? []).length;
  lead.rescored_at = new Date().toISOString();
  classifyLead(lead, event);
  // contact-route field (matches rescore.py: setdefault contact fields, then recompute)
  ensureContactFields(lead as unknown as Record<string, unknown>);
  lead.best_contact_route = bestContactRoute(lead);
  return { changedPriority, reclassified };
}

export interface ScoreStageOptions { dbPath?: string; outPath?: string; runsDir?: string; persist?: boolean; }
export interface ScoreStageResult {
  total: number; reclassified: number; changedPriority: number;
  before: Record<string, number>; after: Record<string, number>; runId: string;
}

export function runScoreStage(opts: ScoreStageOptions = {}): ScoreStageResult {
  const root = process.cwd();
  const dbPath = opts.dbPath ?? resolve(root, "data/fx.db");
  const outPath = opts.outPath ?? resolve(root, "public/data/leads.json");
  const runsDir = opts.runsDir ?? resolve(root, "data/runs");
  const persist = opts.persist ?? true;

  const { db, sqlite, close } = getDb(dbPath);
  const rec = new RunRecorder("score", { dbPath, outPath });

  try {
    const events = new Map<string, EventInfo>();
    for (const e of db.select().from(schema.events).all()) {
      events.set(e.id, { breadth: e.event_breadth, urgency: e.data?.urgency_score ?? e.urgency_score ?? 0 });
    }

    const rows = db.select().from(schema.leads).all();
    const before: Record<string, number> = { HOT: 0, WARM: 0, QUEUE: 0, SKIP: 0 };
    const after: Record<string, number> = { HOT: 0, WARM: 0, QUEUE: 0, SKIP: 0 };
    let reclassified = 0, changedPriority = 0;
    const out: Record<string, Lead> = {};

    for (const row of rows) {
      const parsed = LeadSchema.safeParse(row.data);
      const lead: Lead = parsed.success ? parsed.data : (row.data as Lead);
      before[lead.priority] = (before[lead.priority] ?? 0) + 1;
      // event urgency: primary event_id, falling back to max of linked events (rescore.py uses primary)
      let ev = events.get(lead.event_id);
      if (!ev?.urgency) for (const eid of lead.linked_event_ids ?? []) { const x = events.get(eid); if ((x?.urgency ?? 0) > (ev?.urgency ?? 0)) ev = x; }
      const r = scoreAndClassify(lead, ev);
      if (r.reclassified) reclassified++;
      if (r.changedPriority) changedPriority++;
      after[lead.priority] = (after[lead.priority] ?? 0) + 1;
      out[lead.id] = lead;
    }

    if (persist) {
      const upd = sqlite.prepare(
        `UPDATE leads SET priority=@priority, score=@score, exposure_level=@exposure_level,
           exposure_confidence=@exposure_confidence, lead_type=@lead_type, rescored_at=@rescored_at,
           is_large_org=@is_large_org, data=@data WHERE id=@id`,
      );
      const tx = sqlite.transaction((leads: Lead[]) => {
        for (const lead of leads) upd.run({
          id: lead.id, priority: lead.priority, score: lead.score, exposure_level: lead.exposure_level || "",
          exposure_confidence: lead.exposure_confidence, lead_type: lead.lead_type,
          rescored_at: lead.rescored_at ?? null, is_large_org: lead.is_large_org ? 1 : 0, data: JSON.stringify(lead),
        });
      });
      tx(Object.values(out));

      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(out, null, 2));
    }

    rec.section("lead_stats", { total: rows.length, reclassified, changed_priority: changedPriority, before, after });
    rec.topLeads(
      Object.values(out).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 20).map((l) => ({
        id: l.id, company_name: l.company_name, priority: l.priority, score: l.score,
        website_domain: l.website_domain, segment_name: l.segment_name, lead_type: l.lead_type,
        fx_payment_signals: l.fx_payment_signals, contact_phone: l.contact_phone ?? null,
        best_contact_route: l.best_contact_route ?? "",
      })),
    );
    if (persist) rec.finish(sqlite, runsDir);

    return { total: rows.length, reclassified, changedPriority, before, after, runId: rec.run.run_id };
  } finally {
    close();
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): ScoreStageOptions {
  const o: ScoreStageOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") o.dbPath = argv[++i];
    else if (a === "--out") o.outPath = argv[++i];
    else if (a === "--runs") o.runsDir = argv[++i];
  }
  return o;
}
const isMain = (() => { try { return !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  const r = runScoreStage(parseArgs(process.argv.slice(2)));
  console.log(`score: ${r.total} leads | reclassified ${r.reclassified} | priority changed ${r.changedPriority}`);
  console.log(`  before: ${JSON.stringify(r.before)}`);
  console.log(`  after:  ${JSON.stringify(r.after)}`);
  console.log(`  run_id: ${r.runId}`);
}
