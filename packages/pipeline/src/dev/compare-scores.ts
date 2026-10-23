/**
 * dev/compare-scores.ts — informational parity check (NOT a test).
 *
 * Loads the production data/leads.json (= what the Python rescore.py produced) and,
 * for each lead, runs the v2 scorer (reclassify → @fx/core scoreLead → exposure
 * confidence → classify) and reports how often (score, priority) matches.
 *
 * Notes / why it won't be 100%:
 *  - data/leads.json may predate rescore.py changes (e.g. the nationality-token
 *    fix), so the committed scores were computed by an older scorer;
 *  - rescore.py does a CN/domain dedup pass + multi-event score boost that the
 *    score stage doesn't (yet);
 *  - rescore.py removes SKIP leads; this comparison keeps them.
 * So treat this as "how close is the port" + a list of where they diverge — not a
 * pass/fail gate. Real parity is checked by running the current rescore.py and the
 * v2 score stage on the same fresh input (needs a pipeline run).
 *
 * Run from repo root:  tsx packages/pipeline/src/dev/compare-scores.ts [data/leads.json] [data/events.json]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LeadSchema, repoRoot, type Lead } from "@fx/core";
import { scoreAndClassify } from "../stages/score.js";

function main() {
  const root = repoRoot();
  const leadsPath = resolve(root, process.argv[2] ?? "data/leads.json");
  const eventsPath = resolve(root, process.argv[3] ?? "data/events.json");

  const rawLeads = JSON.parse(readFileSync(leadsPath, "utf8")) as Record<string, unknown>;
  let events: Record<string, { urgency_score?: number; event_breadth?: string }> = {};
  try { events = JSON.parse(readFileSync(eventsPath, "utf8")); } catch { /* optional */ }

  let total = 0, scoreMatch = 0, priorityMatch = 0, bothMatch = 0, parseFail = 0;
  const priFlow: Record<string, number> = {};        // "HOT->WARM" : n
  const mismatches: Array<{ id: string; name: string; was: [number, string]; now: [number, string] }> = [];

  for (const [id, raw] of Object.entries(rawLeads)) {
    total++;
    const obj = raw && typeof raw === "object" ? { ...(raw as object), id: (raw as { id?: string }).id ?? id } : { id };
    const parsed = LeadSchema.safeParse(obj);
    if (!parsed.success) { parseFail++; continue; }
    const lead: Lead = parsed.data;
    const wasScore = lead.score ?? 0;
    const wasPriority = lead.priority;
    const ev = events[lead.event_id];
    scoreAndClassify(lead, ev ? { breadth: ev.event_breadth ?? "", urgency: ev.urgency_score ?? 0 } : undefined);
    const okS = lead.score === wasScore, okP = lead.priority === wasPriority;
    if (okS) scoreMatch++;
    if (okP) priorityMatch++;
    if (okS && okP) bothMatch++;
    if (!okP) priFlow[`${wasPriority}->${lead.priority}`] = (priFlow[`${wasPriority}->${lead.priority}`] ?? 0) + 1;
    if ((!okS || !okP) && mismatches.length < 15) mismatches.push({ id, name: lead.company_name, was: [wasScore, wasPriority], now: [lead.score, lead.priority] });
  }

  const pct = (n: number) => total ? `${((100 * n) / total).toFixed(1)}%` : "—";
  console.log(`compare-scores: ${total} leads (parse-failed: ${parseFail})`);
  console.log(`  score matches v1:    ${scoreMatch} (${pct(scoreMatch)})`);
  console.log(`  priority matches v1: ${priorityMatch} (${pct(priorityMatch)})`);
  console.log(`  both match:          ${bothMatch} (${pct(bothMatch)})`);
  if (Object.keys(priFlow).length) {
    console.log("  priority changes (v1 -> v2):");
    for (const [k, n] of Object.entries(priFlow).sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(16)} ${n}`);
  }
  if (mismatches.length) {
    console.log("  sample mismatches:");
    for (const m of mismatches) console.log(`    ${m.name.slice(0, 38).padEnd(40)} v1=[${m.was[1]} ${m.was[0]}]  v2=[${m.now[1]} ${m.now[0]}]`);
  }
  console.log("\n  (Differences are expected where data/leads.json predates rescore.py's nationality fix,");
  console.log("   and because the score stage doesn't yet do the CN/domain dedup + multi-event boost.)");
}

main();
