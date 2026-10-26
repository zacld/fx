/**
 * stages/call-readiness.ts — TS port of scripts/compute_call_readiness.py:
 * call_readiness and call_readiness_reasons on every lead.
 *
 *   READY   HOT/WARM (or score ≥ 60) + route grade A/B + strong FX evidence + website confidence high/medium
 *   REVIEW  HOT/WARM + grade A/B/C + some FX evidence + a website
 *   HOLD    everything else
 *
 * Strong FX: pays_fx_confirmed, fx_likelihood_score ≥ 45, or 3+ FX signals.
 * Some FX:   any FX payment signal, pays_fx_confirmed, or fx_likelihood_score ≥ 25.
 * Recomputed for every lead each run (the Python script kept a lead's first
 * answer, so readiness went stale as grades and evidence changed).
 *
 * CLI: tsx src/stages/call-readiness.ts [--db data/fx.db] [--out data/leads.json]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LeadSchema, repoRoot, type Lead } from "@fx/core";
import { getDb, schema } from "@fx/core/db";

const GOOD_WEB_CONF = new Set(["high", "medium", "confirmed"]);

export type Readiness = "READY" | "REVIEW" | "HOLD";

export function callReadiness(lead: Lead): { status: Readiness; reasons: string[] } {
  const l = lead as Record<string, unknown>;
  const score = Number(l.score ?? 0) || 0;
  const grade = String(l.route_grade ?? "");
  const fx = Number(l.fx_likelihood_score ?? 0) || 0;
  const webConf = String(l.website_confidence ?? "").toLowerCase();
  const hasWebsite = !!l.website;
  const signals = (l.fx_payment_signals as unknown[] | undefined) ?? [];
  const sigCount = Number(l.signal_count ?? 0) || signals.length;
  const fxConfirmed = !!l.pays_fx_confirmed;

  const hotWarm = l.priority === "HOT" || l.priority === "WARM" || score >= 60;
  const strongFx = fxConfirmed || fx >= 45 || sigCount >= 3;
  const anyFx = signals.length > 0 || fxConfirmed || fx >= 25;

  const missing: string[] = [];
  if (!hotWarm) missing.push(`score too low (${score})`);
  if (!["A", "B"].includes(grade)) missing.push(`route grade ${grade || "missing"} — need A or B (named FD/MD + contact)`);
  if (!strongFx) missing.push(`FX evidence weak (fx_likelihood=${fx}% signals=${sigCount}) — need confirmed/likelihood≥45/signals≥3`);
  if (!GOOD_WEB_CONF.has(webConf)) missing.push(`website confidence ${webConf || "unknown"} — need high/medium`);
  if (!hasWebsite) missing.push("no website");

  if (!missing.length) return { status: "READY", reasons: [] };
  if (hotWarm && ["A", "B", "C"].includes(grade) && anyFx && hasWebsite) return { status: "REVIEW", reasons: missing };
  return { status: "HOLD", reasons: missing };
}

export function runCallReadinessStage(opts: { dbPath?: string; outPath?: string } = {}) {
  const root = repoRoot();
  const dbPath = opts.dbPath ?? resolve(root, "data/fx.db");
  const outPath = opts.outPath ?? resolve(root, "data/leads.json");
  const { db, sqlite, close } = getDb(dbPath);
  const counts: Record<Readiness, number> = { READY: 0, REVIEW: 0, HOLD: 0 };
  try {
    const leads: Record<string, Lead> = {};
    for (const row of db.select().from(schema.leads).all()) {
      const p = LeadSchema.safeParse(row.data);
      leads[row.id] = p.success ? p.data : (row.data as Lead);
    }
    for (const lead of Object.values(leads)) {
      const { status, reasons } = callReadiness(lead);
      Object.assign(lead as Record<string, unknown>, { call_readiness: status, call_readiness_reasons: reasons });
      counts[status]++;
    }
    const upd = sqlite.prepare(`UPDATE leads SET data=@data WHERE id=@id`);
    sqlite.transaction(() => { for (const l of Object.values(leads)) upd.run({ id: l.id, data: JSON.stringify(l) }); })();
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
  const c = runCallReadinessStage({ dbPath: arg("--db"), outPath: arg("--out") });
  console.log(`call-readiness: READY ${c.READY} | REVIEW ${c.REVIEW} | HOLD ${c.HOLD}`);
}
