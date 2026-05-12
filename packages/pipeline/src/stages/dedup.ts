/**
 * stages/dedup.ts — the "dedup" pipeline stage (v2 equivalent of the two dedup
 * passes + SKIP-removal in scripts/rescore.py's main()). Run after `score`.
 *
 *   1. company-number dedup — group leads by company_number; keep the highest
 *      scorer; merge linked_event_ids / linked_segments / linked_event_headlines
 *      into it; multi_event_trigger=true, multi_event_count=N; score boost
 *      min(8, (N-1)*4) capped at 100; re-derive priority from the boosted score;
 *      drop the others. (Faithful port — the boost happens *after* the gates, so a
 *      Gate-C-capped WARM can be lifted to HOT by multi-event exposure.)
 *   2. website-domain dedup — group leads by website_domain across *different*
 *      company numbers; keep the highest scorer's website; strip the website from
 *      the rest (website=null, website_confidence=null, website_source=
 *      "collision_stripped") and cap their score at 49 (QUEUE) if it was higher.
 *   3. drop all leads whose priority is "SKIP".
 * Writes survivors back to the DB, deletes the dropped ones, re-exports the
 * {id: lead} JSON map to --out, records a `runs` row.
 *
 * CLI:  tsx src/stages/dedup.ts [--db data/fx.db] [--out data/leads.json] [--runs data/runs]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LeadSchema, clearContactFields, bestContactRoute, repoRoot, type Lead } from "@fx/core";
import { getDb, schema } from "@fx/core/db";
import { RunRecorder } from "../run.js";

function priorityFor(score: number): "HOT" | "WARM" | "QUEUE" | "SKIP" {
  return score >= 80 ? "HOT" : score >= 60 ? "WARM" : score >= 40 ? "QUEUE" : "SKIP";
}
function extractDomain(url: string | null | undefined): string {
  if (!url) return "";
  try { return new URL(url).hostname.toLowerCase().replace(/^www\d*\./, ""); } catch { return ""; }
}
function pushTo<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const a = m.get(k);
  if (a) a.push(v); else m.set(k, [v]);
}

export interface DedupResult {
  totalBefore: number;
  cnGroupsMerged: number; cnLeadsRemoved: number;
  domainCollisions: number; skipRemoved: number;
  totalAfter: number; runId: string;
}

/** Pure: dedup a map of leads (mutated in place; returns the surviving map + stats). */
export function dedupLeads(leads: Record<string, Lead>): Omit<DedupResult, "runId"> {
  const ids = Object.keys(leads);
  const totalBefore = ids.length;

  // ── 1. company-number dedup ────────────────────────────────────────────────
  const cnGroups = new Map<string, string[]>();
  for (const id of ids) {
    const cn = leads[id]!.company_number;
    if (cn) pushTo(cnGroups, cn, id);
  }
  let cnGroupsMerged = 0, cnLeadsRemoved = 0;
  for (const group of cnGroups.values()) {
    if (group.length <= 1) continue;
    cnGroupsMerged++;
    group.sort((a, b) => (leads[b]!.score ?? 0) - (leads[a]!.score ?? 0));
    const best = leads[group[0]!]!;
    const all = group.map((i) => leads[i]!);
    const allEventIds = [...new Set(all.flatMap((l) => (l.linked_event_ids?.length ? l.linked_event_ids : [l.event_id])).filter(Boolean))];
    const allSegments = [...new Set(all.map((l) => l.segment_name).filter(Boolean))];
    const allHeadlines = [...new Set(all.map((l) => l.trigger_headline || (l as { event_headline?: string }).event_headline || "").filter((s) => s))];
    best.multi_event_trigger = true;
    best.multi_event_count = group.length;
    best.linked_event_ids = allEventIds;
    (best as Record<string, unknown>).linked_segments = allSegments;
    (best as Record<string, unknown>).linked_event_headlines = allHeadlines;
    const boost = Math.min(8, (group.length - 1) * 4);
    best.score = Math.min(100, (best.score ?? 0) + boost);
    best.scoring_reasons = [...(best.scoring_reasons ?? []), `Multi-event trigger: ${group.length} separate events flag this company (+${boost})`];
    best.priority = priorityFor(best.score);
    for (const i of group.slice(1)) { delete leads[i]; cnLeadsRemoved++; }
  }

  // ── 2. website-domain dedup ────────────────────────────────────────────────
  const domGroups = new Map<string, string[]>();
  for (const id of Object.keys(leads)) {
    const d = extractDomain(leads[id]!.website);
    if (d) pushTo(domGroups, d, id);
  }
  let domainCollisions = 0;
  for (const [d, group] of domGroups) {
    if (group.length <= 1) continue;
    const cns = new Set(group.map((i) => leads[i]!.company_number ?? ""));
    if (cns.size <= 1) continue;            // same (or all-null) CN — handled above / left alone
    group.sort((a, b) => (leads[b]!.score ?? 0) - (leads[a]!.score ?? 0));
    for (const i of group.slice(1)) {
      const l = leads[i]!;
      l.website = null;
      l.website_confidence = null;
      l.website_source = "collision_stripped";
      clearContactFields(l as unknown as Record<string, unknown>);   // contact info came from the wrong site
      l.best_contact_route = bestContactRoute(l);
      if ((l.score ?? 0) > 49) {
        l.score = 49;
        l.priority = "QUEUE";
        l.scoring_reasons = [...(l.scoring_reasons ?? []), `⚠ Website collision (${d}) — stripped, QUEUE cap`];
      }
      domainCollisions++;
    }
  }

  // ── 3. drop SKIP leads ─────────────────────────────────────────────────────
  let skipRemoved = 0;
  for (const id of Object.keys(leads)) if (leads[id]!.priority === "SKIP") { delete leads[id]; skipRemoved++; }

  return { totalBefore, cnGroupsMerged, cnLeadsRemoved, domainCollisions, skipRemoved, totalAfter: Object.keys(leads).length };
}

export interface DedupStageOptions { dbPath?: string; outPath?: string; runsDir?: string; persist?: boolean; }

export function runDedupStage(opts: DedupStageOptions = {}): DedupResult {
  const root = repoRoot();
  const dbPath = opts.dbPath ?? resolve(root, "data/fx.db");
  const outPath = opts.outPath ?? resolve(root, "data/leads.json");
  const runsDir = opts.runsDir ?? resolve(root, "data/runs");
  const persist = opts.persist ?? true;

  const { db, sqlite, close } = getDb(dbPath);
  const rec = new RunRecorder("dedup", { dbPath, outPath });
  try {
    const leads: Record<string, Lead> = {};
    for (const row of db.select().from(schema.leads).all()) {
      const p = LeadSchema.safeParse(row.data);
      leads[row.id] = p.success ? p.data : (row.data as Lead);
    }
    const beforeIds = new Set(Object.keys(leads));
    const stats = dedupLeads(leads);
    const survivors = new Set(Object.keys(leads));

    if (persist) {
      const upd = sqlite.prepare(
        `UPDATE leads SET priority=@priority, score=@score, website=@website, website_confidence=@website_confidence,
           website_source=@website_source, data=@data WHERE id=@id`,
      );
      const del = sqlite.prepare(`DELETE FROM leads WHERE id=@id`);
      const tx = sqlite.transaction(() => {
        for (const id of beforeIds) {
          if (survivors.has(id)) {
            const l = leads[id]!;
            upd.run({
              id, priority: l.priority, score: l.score, website: l.website ?? null,
              website_confidence: (l.website_confidence as string | null) ?? null,
              website_source: (l.website_source as string | null) ?? null, data: JSON.stringify(l),
            });
          } else {
            del.run({ id });
          }
        }
      });
      tx();
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(leads, null, 2));
    }

    const after: Record<string, number> = { HOT: 0, WARM: 0, QUEUE: 0, SKIP: 0 };
    for (const l of Object.values(leads)) after[l.priority] = (after[l.priority] ?? 0) + 1;
    rec.section("lead_stats", { ...stats, after_priorities: after });
    rec.topLeads(Object.values(leads).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 20).map((l) => ({
      id: l.id, company_name: l.company_name, priority: l.priority, score: l.score, website_domain: l.website_domain,
      segment_name: l.segment_name, lead_type: l.lead_type, multi_event_count: l.multi_event_count,
    })));
    if (persist) rec.finish(sqlite, runsDir);

    return { ...stats, runId: rec.run.run_id };
  } finally {
    close();
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): DedupStageOptions {
  const o: DedupStageOptions = {};
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
  const r = runDedupStage(parseArgs(process.argv.slice(2)));
  console.log(`dedup: ${r.totalBefore} → ${r.totalAfter} leads | CN groups merged ${r.cnGroupsMerged} (−${r.cnLeadsRemoved}) | domain collisions ${r.domainCollisions} | SKIP removed ${r.skipRemoved} | run_id ${r.runId}`);
}
