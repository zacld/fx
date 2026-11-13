// Rank every lead we've scanned (src/accounts/ranking.js) and save it for the Accounts page (leads/ranked):
//   node scripts/rank-leads.mjs enrich.json [order.json]   — enrich.json from tools/niche_hits.py --enrich-out; order.json:
//   every live lead's company number, best first (for tools/find_domains.py)
// Reads the Accounts list, the Recent FX filings list, the measured niches and the alerts from the site's private store.
// Prints counts, company names, scores and niche learnings — no people's names (the repo is public).
import { readFile, writeFile } from "node:fs/promises";
import { ALERTS_KEY, DEALS_KEY, FILINGS_KEY, KEY, NICHES_KEY, RANKED_KEY, STORE, dealSignals, filingsMonthKey, signalsByCompany } from "../api/accounts.mjs";
import { filedMonth, nicheLearnings, rankLeads } from "../src/accounts/ranking.js";
import { openStore } from "./store.mjs";

const [enrichPath, orderPath] = process.argv.slice(2);   // orderPath: company numbers, best lead first (find_domains.py)
const enrich = enrichPath ? (JSON.parse(await readFile(enrichPath, "utf8")).companies || {}) : {};
const store = await openStore(STORE);
const [list, index, niches, alerts, deals] = await Promise.all([KEY, FILINGS_KEY, NICHES_KEY, ALERTS_KEY, DEALS_KEY].map((k) => store.get(k, "json")));
let filingRows = index?.rows || [];
for (const { month } of index?.months || []) filingRows = filingRows.concat((await store.get(filingsMonthKey(month), "json"))?.rows || []);
const listRows = list?.rows || [];

const { rows, ruled_out, niche_of, shy_of, scored } = rankLeads(listRows, filingRows, { enrich, niches: niches?.niches || {}, signals: signalsByCompany([...(alerts?.items || []), ...dealSignals(deals?.items || [])]) });
const learn = nicheLearnings(scored);
const made_at = new Date().toISOString();
await store.set(RANKED_KEY, { made_at, count: rows.length, rows, ruled_out, niche_of, shy_of, niches: learn });

const live = scored.filter((s) => !s.absurd);
if (orderPath) await writeFile(orderPath, JSON.stringify(live.map((s) => s.company_number)));
const bucket = (lo, hi) => live.filter((s) => s.score >= lo && s.score < hi).length;
console.log(`Leads scanned: ${scored.length.toLocaleString()} (Accounts list ${listRows.length.toLocaleString()}, FX filings not on it ${rows.length.toLocaleString()}); ` +
            `ruled out as absurd ${Object.keys(ruled_out).length.toLocaleString()}; list companies relabelled ${Object.keys(niche_of).length.toLocaleString()}`);
const hits = scored.filter((x) => !x.absurd && x.parts.some(([w]) => w.startsWith("Hit list")));
console.log(`Hit list (a recent FX loss and a new FD / buying companies / a PE deal): ${hits.length}`);
hits.slice(0, 20).forEach((x) => console.log(`  ${x.score}  ${x.company_name} — ${x.parts.filter(([w]) => /FX loss|finance director|Buying|Private-equity/.test(w)).map(([w]) => w.slice(0, 60)).join(" · ")}`));
console.log(`Scores: 80+ ${bucket(80, 1e9)} · 60–79 ${bucket(60, 80)} · 40–59 ${bucket(40, 60)} · under 40 ${bucket(-1e9, 40)}`);
const filedMonths = {};
for (const r of filingRows) filedMonths[filedMonth(r)] = (filedMonths[filedMonth(r)] || 0) + 1;
console.log("FX filings by month filed: " + Object.entries(filedMonths).sort().map(([m, n]) => `${m} ${n}`).join(", "));
const short = (parts) => parts.slice(0, 4).map(([w, p]) => `${w.split(" (")[0].slice(0, 40)} ${p > 0 ? "+" : ""}${p}`).join(" · ");
console.log("\nTop 30 leads:");
live.slice(0, 30).forEach((s, i) => console.log(`${String(i + 1).padStart(3)}. ${s.score}  ${s.company_name}${s.onList ? "" : "  [FX filings]"}  — ${s.niche || "no niche"} — ${short(s.parts)}`));
console.log("\nNiches by average lead score (8+ leads):");
console.log("  avg  leads  60+  band  FX loss  ruled out  niche");
for (const n of learn) console.log(`${String(n.avg).padStart(5)} ${String(n.leads).padStart(6)} ${String(n.strong).padStart(4)} ${String(n.band).padStart(5)} ${String(n.loss).padStart(8)} ${String(n.ruled_out).padStart(10)}  ${n.niche}`);
const shyBy = {};
for (const s of live) if (shy_of[s.company_number]) (shyBy[shy_of[s.company_number].niche] ||= []).push(s);
console.log(`\nHard to broker: ${Object.values(shyBy).flat().length} leads`);
for (const [niche, list] of Object.entries(shyBy).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${String(list.length).padStart(4)}  ${niche}: ${list.slice(0, 4).map((s) => `${s.company_name} (${s.score})`).join("; ")}`);
}
const reasons = {};
for (const [number, why] of Object.entries(ruled_out)) {
  const k = why.split(" — ")[0].replace(/ \(sector \d+\)/, "").replace(/, by its name/, "");
  (reasons[k] ||= []).push(scored.find((s) => s.company_number === number));
}
console.log("\nRuled out as absurd, by reason (highest scorers shown — what the score alone would have put in front of you):");
for (const [k, list] of Object.entries(reasons).sort((a, b) => b[1].length - a[1].length)) {
  const top = list.filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 5).map((s) => `${s.company_name} (${s.score})`).join("; ");
  console.log(`  ${list.length.toString().padStart(4)}  ${k}: ${top}`);
}
