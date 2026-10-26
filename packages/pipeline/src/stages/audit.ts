/**
 * stages/audit.ts — TS port of scripts/audit_leads.py: a read-only lead
 * quality report printed to the run's log (counts and company names only:
 * the repo is public). Never fails the run.
 *
 * Sections: pipeline health (HOT/WARM/QUEUE/SKIP), route grades, FX
 * likelihood, call readiness, data completeness, blocked / duplicate
 * domains, anomalies (good contact + weak evidence and the reverse, HOT
 * leads with no named contact or no contact at all), leads per event.
 *
 * CLI: tsx src/stages/audit.ts [--db data/fx.db] [--json]
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LeadSchema, repoRoot, type Lead } from "@fx/core";
import { getDb, schema } from "@fx/core/db";
import { shouldSkipUrl } from "../sources/blocklists.js";

type L = Record<string, unknown>;
const num = (v: unknown) => Number(v ?? 0) || 0;
const domainOf = (url: unknown) => { try { return new URL(String(url)).hostname.toLowerCase().replace(/^www\d*\./, ""); } catch { return ""; } };
const count = <T,>(xs: T[], key: (x: T) => string) =>
  xs.reduce<Record<string, number>>((m, x) => { const k = key(x); m[k] = (m[k] ?? 0) + 1; return m; }, {});

export function auditLeads(leads: Lead[]) {
  const ls = leads as unknown as L[];
  const fx = (l: L) => num(l.fx_likelihood_score);
  const hot = ls.filter((l) => l.priority === "HOT" || num(l.score) >= 80);
  const byDomain: Record<string, L[]> = {};
  for (const l of ls) { const d = domainOf(l.website); if (d) (byDomain[d] ??= []).push(l); }
  return {
    total: ls.length,
    priority: {
      hot: hot.length,
      warm: ls.filter((l) => l.priority === "WARM" && num(l.score) < 80).length,
      queue: ls.filter((l) => num(l.score) >= 40 && num(l.score) < 60 && !["HOT", "WARM"].includes(String(l.priority))).length,
      skip: ls.filter((l) => num(l.score) < 40 && !["HOT", "WARM", "QUEUE"].includes(String(l.priority))).length,
    },
    grades: count(ls, (l) => String(l.route_grade || "?")),
    fx_likelihood: {
      strong_70plus: ls.filter((l) => fx(l) >= 70).length,
      moderate_45_69: ls.filter((l) => fx(l) >= 45 && fx(l) < 70).length,
      weak_25_44: ls.filter((l) => fx(l) >= 25 && fx(l) < 45).length,
      none_0_24: ls.filter((l) => fx(l) < 25).length,
    },
    call_readiness: count(ls, (l) => String(l.call_readiness || "unscored")),
    missing: {
      route_grade: ls.filter((l) => !l.route_grade).length,
      decision_makers: ls.filter((l) => !(l.decision_makers as unknown[] | undefined)?.length).length,
      evidence_snippets: ls.filter((l) => !(l.fx_evidence_snippets as unknown[] | undefined)?.length).length,
      currency_pairs: ls.filter((l) => !(l.inferred_currency_pairs as unknown[] | undefined)?.length).length,
      phone: ls.filter((l) => !l.contact_phone).length,
      website: ls.filter((l) => !l.website).length,
    },
    blocked: ls.filter((l) => l.website && shouldSkipUrl(String(l.website)).skip),
    duplicate_domains: Object.entries(byDomain).filter(([, v]) => v.length > 1),
    anomalies: {
      "Grade A/B leads with FX likelihood < 45 (good contact, weak evidence — check the website)":
        ls.filter((l) => ["A", "B"].includes(String(l.route_grade)) && fx(l) < 45),
      "FX likelihood ≥ 70 with Grade D/E/F (strong evidence, no named contact)":
        ls.filter((l) => fx(l) >= 70 && ["D", "E", "F", ""].includes(String(l.route_grade ?? ""))),
      "HOT leads with Grade D/E/F (no named contact route)":
        hot.filter((l) => ["D", "E", "F"].includes(String(l.route_grade))),
      "HOT leads with no phone, email or contact page":
        hot.filter((l) => !l.contact_phone && !l.contact_email && !l.contact_page),
    } as Record<string, L[]>,
    events: count(ls, (l) => String(l.event_id || "?")),
  };
}

function print(a: ReturnType<typeof auditLeads>): void {
  const pct = (n: number) => `${Math.round((100 * n) / Math.max(a.total, 1))}%`;
  const line = (label: string, n: number) => console.log(`  ${label.padEnd(16)} ${String(n).padStart(5)}  ${pct(n)}`);
  console.log(`\n══ FX Discovery — lead quality audit: ${a.total} leads · ${Object.keys(a.events).length} events ══`);
  console.log("PIPELINE HEALTH");
  line("HOT", a.priority.hot); line("WARM", a.priority.warm); line("QUEUE", a.priority.queue); line("SKIP", a.priority.skip);
  console.log("ROUTE GRADES");
  for (const g of ["A", "B", "C", "D", "E", "F", "?"]) if (a.grades[g]) line(g, a.grades[g]!);
  console.log("FX LIKELIHOOD");
  for (const [k, n] of Object.entries(a.fx_likelihood)) line(k, n);
  console.log("CALL READINESS");
  for (const k of ["READY", "REVIEW", "HOLD", "unscored"]) if (a.call_readiness[k]) line(k, a.call_readiness[k]!);
  console.log("DATA COMPLETENESS (missing)");
  for (const [k, n] of Object.entries(a.missing)) line(k, n);
  console.log("DOMAIN ISSUES");
  console.log(`  blocked domains: ${a.blocked.length}  |  duplicate domain groups: ${a.duplicate_domains.length}`);
  for (const [d, ls] of a.duplicate_domains.slice(0, 5)) console.log(`    ${d}  →  ${ls.map((l) => String(l.company_name ?? "?").slice(0, 30)).join(", ")}`);
  console.log("ANOMALIES");
  for (const [label, ls] of Object.entries(a.anomalies)) {
    if (!ls.length) continue;
    console.log(`  ${label}: ${ls.length}`);
    for (const l of ls.slice(0, 3)) console.log(`    · ${String(l.company_name ?? "?").slice(0, 45)}  grade=${l.route_grade ?? "?"}  fx=${l.fx_likelihood_score ?? "?"}`);
  }
  console.log("EVENTS (top 8)");
  for (const [e, n] of Object.entries(a.events).sort((x, y) => y[1] - x[1]).slice(0, 8)) console.log(`  ${e.slice(0, 20).padEnd(20)} ${n}`);
}

export function runAuditStage(opts: { dbPath?: string; json?: boolean } = {}) {
  const { db, close } = getDb(opts.dbPath ?? resolve(repoRoot(), "data/fx.db"));
  try {
    const leads = db.select().from(schema.leads).all().map((row) => {
      const p = LeadSchema.safeParse(row.data);
      return p.success ? p.data : (row.data as Lead);
    });
    const a = auditLeads(leads);
    if (opts.json) console.log(JSON.stringify({ ...a, blocked: a.blocked.length, duplicate_domains: a.duplicate_domains.length,
      anomalies: Object.fromEntries(Object.entries(a.anomalies).map(([k, v]) => [k, v.length])) }, null, 2));
    else print(a);
    return a;
  } finally {
    close();
  }
}

const isMain = (() => { try { return !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--db");
  try { runAuditStage({ dbPath: i >= 0 ? argv[i + 1] : undefined, json: argv.includes("--json") }); }
  catch (e) { console.error("audit failed (report only, run continues):", e); }
}
