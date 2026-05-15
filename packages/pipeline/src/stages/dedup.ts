/**
 * stages/dedup.ts — the "dedup" pipeline stage. Run after `score`.
 *
 *   1. Companies House number — group by company_number; keep the best lead
 *      (see leadCompare); merge linked_event_ids / linked_segments /
 *      linked_event_headlines; multi_event_trigger=true, multi_event_count=N;
 *      score boost min(8, (N-1)*4) capped at 100; re-derive priority; drop the
 *      others. (The boost happens *after* the gates, so a Gate-C-capped WARM
 *      can be lifted to HOT by multi-event exposure.)
 *   2. Normalised website domain — group by website domain.
 *      * If the group has ≤1 distinct non-null CN, treat as same company:
 *        merge all into the best lead, preserve dropped sources in
 *        duplicate_sources (the surviving lead inherits a CN if any of the
 *        merged ones had one).
 *      * If the group has ≥2 distinct non-null CNs, that is strong evidence
 *        of different entities sharing a host: keep the best lead's website,
 *        strip the website + cap losers at 49 (QUEUE).
 *      (Replaces the v1 "leave all-null-CN same-domain leads alone" quirk —
 *      that was a faithful Python port but it was tanking READY quality
 *      because duplicates like the French Cellar pair ranked twice at 100.)
 *   3. Normalised company-name fallback — for the leads still standing with
 *      no CN, group by companyNameKey; if the key is dedupable (≥2 distinct
 *      tokens, ≥6 chars after stripping legal/trade/generic words) merge as
 *      in pass 2. The dedupable-key guard prevents over-merging on generic
 *      names like "imports ltd" or "trading co".
 *   4. Drop all leads whose priority is "SKIP".
 *
 * Writes survivors back to the DB, deletes the dropped ones, re-exports the
 * {id: lead} JSON map to --out, records a `runs` row.
 *
 * CLI:  tsx src/stages/dedup.ts [--db data/fx.db] [--out data/leads.json] [--runs data/runs]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LeadSchema, clearContactFields, bestContactRoute, repoRoot,
  companyNameKey, isDedupableNameKey,
  type Lead, type LeadEvidence,
} from "@fx/core";
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

// ── Best-lead selection (when merging a duplicate group) ────────────────────
// Ranking dimensions, in order — first difference wins. All "higher is better"
// values are negated so a lexicographic sort picks the best lead first.
const WEBSITE_CONFIDENCE_RANK: Record<string, number> = { confirmed: 4, high: 3, medium: 2, low: 1, none: 0 };
const ROUTE_GRADE_RANK: Record<string, number> = { A: 6, B: 5, C: 4, D: 3, E: 2, F: 1 };

function websiteConfidenceRank(c: Lead["website_confidence"]): number {
  if (!c) return 0;
  return WEBSITE_CONFIDENCE_RANK[c as string] ?? 0;
}
function routeGradeRank(g: Lead["route_grade"]): number {
  if (!g) return 0;
  return ROUTE_GRADE_RANK[g] ?? 0;
}
function leadRank(l: Lead): number[] {
  return [
    -(l.ready_score ?? 0),                            // 1. higher ready_score
    -(l.score ?? 0),                                  // 2. higher score
    -(l.fx_payment_signals?.length ?? 0),             // 3. stronger FX signal count
    -websiteConfidenceRank(l.website_confidence),     // 4. better website confidence
    -routeGradeRank(l.route_grade),                   // 5. better route_grade
    l.company_number ? 0 : 1,                         // 6. valid CH number beats no CH number
    -((l.contact_confidence as number | undefined) ?? 0),  // 7. better decision-maker confidence
  ];
}
function leadCompare(a: Lead, b: Lead): number {
  const ra = leadRank(a), rb = leadRank(b);
  for (let i = 0; i < ra.length; i++) {
    const d = ra[i]! - rb[i]!;
    if (d !== 0) return d;
  }
  return 0;
}

function evidenceFromLead(l: Lead): LeadEvidence {
  const e: LeadEvidence = {
    source_query: l.source_query ?? "",
    source_segment: l.source_segment ?? "",
    source_micro_category: (l as { source_micro_category?: string }).source_micro_category ?? "",
  };
  if (l.website_source != null) e.website_source = l.website_source as string;
  if (l.discovery_path != null) e.discovery_path = l.discovery_path;
  if (l.source_page_url != null) e.source_page_url = l.source_page_url;
  return e;
}

/**
 * Merge `dropped[]` into `best`. Data-only merge — preserves linked events,
 * segments, headlines, and source evidence. Does NOT apply any score change
 * (use `applyMultiEventBoost` separately when the merge represents distinct
 * market-event triggers, ie. the CN pass).
 */
function mergeInto(best: Lead, dropped: Lead[]): void {
  const all = [best, ...dropped];
  const allEventIds = [...new Set(all.flatMap((l) => (l.linked_event_ids?.length ? l.linked_event_ids : [l.event_id])).filter(Boolean))];
  const allSegments = [...new Set(all.map((l) => l.segment_name).filter(Boolean))];
  const allHeadlines = [...new Set(all.map((l) => l.trigger_headline || (l as { event_headline?: string }).event_headline || "").filter((s) => s))];
  best.linked_event_ids = allEventIds;
  (best as Record<string, unknown>).linked_segments = allSegments;
  (best as Record<string, unknown>).linked_event_headlines = allHeadlines;

  // Preserve source evidence from the dropped leads.
  const newSources = dropped.map(evidenceFromLead);
  best.duplicate_sources = [...(best.duplicate_sources ?? []), ...newSources];

  // If best lacks a CH number but a dropped lead has one, claim it + the
  // CH-derived identity fields that go with it.
  if (!best.company_number) {
    const withCn = dropped.find((l) => l.company_number);
    if (withCn) {
      best.company_number = withCn.company_number;
      best.company_status = best.company_status ?? withCn.company_status;
      if (!best.address) best.address = withCn.address ?? "";
      if (!best.sic_codes?.length) best.sic_codes = withCn.sic_codes ?? [];
    }
  }
}

/** Apply the multi-event scoring boost — only the CN pass uses this. */
function applyMultiEventBoost(best: Lead, groupSize: number): void {
  best.multi_event_trigger = true;
  best.multi_event_count = groupSize;
  const boost = Math.min(8, (groupSize - 1) * 4);
  best.score = Math.min(100, (best.score ?? 0) + boost);
  best.scoring_reasons = [...(best.scoring_reasons ?? []), `Multi-event trigger: ${groupSize} separate events flag this company (+${boost})`];
  best.priority = priorityFor(best.score);
}

export interface DedupResult {
  totalBefore: number;
  cnGroupsMerged: number; cnLeadsRemoved: number;
  domainGroupsMerged: number; domainLeadsRemoved: number;
  domainCollisions: number;
  nameGroupsMerged: number; nameLeadsRemoved: number;
  skipRemoved: number;
  totalAfter: number; runId: string;
}

/** Pure: dedup a map of leads (mutated in place; returns the surviving map + stats). */
export function dedupLeads(leads: Record<string, Lead>): Omit<DedupResult, "runId"> {
  const ids = Object.keys(leads);
  const totalBefore = ids.length;

  // ── 1. Companies House number ─────────────────────────────────────────────
  const cnGroups = new Map<string, string[]>();
  for (const id of ids) {
    const cn = leads[id]!.company_number;
    if (cn) pushTo(cnGroups, cn, id);
  }
  let cnGroupsMerged = 0, cnLeadsRemoved = 0;
  for (const group of cnGroups.values()) {
    if (group.length <= 1) continue;
    cnGroupsMerged++;
    group.sort((a, b) => leadCompare(leads[a]!, leads[b]!));
    const best = leads[group[0]!]!;
    const dropped = group.slice(1).map((i) => leads[i]!);
    mergeInto(best, dropped);
    applyMultiEventBoost(best, group.length);
    for (const i of group.slice(1)) { delete leads[i]; cnLeadsRemoved++; }
  }

  // ── 2. Normalised website domain ──────────────────────────────────────────
  // Replaces the v1 "leave all-null-CN groups alone" quirk: that quirk was a
  // faithful Python port, but READY quality matters more than preserving
  // duplicate null-CN leads. Now: ≤1 distinct non-null CN = merge (same
  // company); ≥2 distinct CNs = cross-CN collision (strip + cap).
  const domGroups = new Map<string, string[]>();
  for (const id of Object.keys(leads)) {
    const d = extractDomain(leads[id]!.website);
    if (d) pushTo(domGroups, d, id);
  }
  let domainGroupsMerged = 0, domainLeadsRemoved = 0, domainCollisions = 0;
  for (const [d, group] of domGroups) {
    if (group.length <= 1) continue;
    const distinctCns = new Set(group.map((i) => leads[i]!.company_number).filter((v): v is string => !!v));

    if (distinctCns.size <= 1) {
      // Same company (single CN or all-null) — merge into best.
      domainGroupsMerged++;
      group.sort((a, b) => leadCompare(leads[a]!, leads[b]!));
      const best = leads[group[0]!]!;
      const dropped = group.slice(1).map((i) => leads[i]!);
      mergeInto(best, dropped);
      for (const i of group.slice(1)) { delete leads[i]; domainLeadsRemoved++; }
      continue;
    }

    // Cross-CN collision — different companies sharing a host. Strip + cap losers.
    group.sort((a, b) => leadCompare(leads[a]!, leads[b]!));
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

  // ── 3. Normalised company-name fallback (null-CN leads only) ──────────────
  const nameGroups = new Map<string, string[]>();
  for (const id of Object.keys(leads)) {
    if (leads[id]!.company_number) continue;            // CN-pass already handled those
    const key = companyNameKey(leads[id]!.company_name);
    if (!isDedupableNameKey(key)) continue;             // too short / too generic to safely merge
    pushTo(nameGroups, key, id);
  }
  let nameGroupsMerged = 0, nameLeadsRemoved = 0;
  for (const group of nameGroups.values()) {
    if (group.length <= 1) continue;
    nameGroupsMerged++;
    group.sort((a, b) => leadCompare(leads[a]!, leads[b]!));
    const best = leads[group[0]!]!;
    const dropped = group.slice(1).map((i) => leads[i]!);
    mergeInto(best, dropped);
    for (const i of group.slice(1)) { delete leads[i]; nameLeadsRemoved++; }
  }

  // ── 4. Drop SKIP leads ────────────────────────────────────────────────────
  let skipRemoved = 0;
  for (const id of Object.keys(leads)) if (leads[id]!.priority === "SKIP") { delete leads[id]; skipRemoved++; }

  return {
    totalBefore,
    cnGroupsMerged, cnLeadsRemoved,
    domainGroupsMerged, domainLeadsRemoved, domainCollisions,
    nameGroupsMerged, nameLeadsRemoved,
    skipRemoved,
    totalAfter: Object.keys(leads).length,
  };
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
  console.log(`dedup: ${r.totalBefore} → ${r.totalAfter} leads | CN merged ${r.cnGroupsMerged} (−${r.cnLeadsRemoved}) | domain merged ${r.domainGroupsMerged} (−${r.domainLeadsRemoved}) | domain collisions ${r.domainCollisions} | name merged ${r.nameGroupsMerged} (−${r.nameLeadsRemoved}) | SKIP removed ${r.skipRemoved} | run_id ${r.runId}`);
}
