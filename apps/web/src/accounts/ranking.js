// Every lead we've scanned, ranked by the lead score (format.js leadScore): the Accounts list's companies and the
// Recent FX filings list's not on it yet, each with its niche (what its customs records show it trading, else its
// sector — tools/niche_hits.py) and an absurd check (banks, insurers, funds, FX providers themselves, public bodies,
// not-for-profits, dissolved companies: sourcer/absurd.py) that qualifies it Out. Shared by scripts/rank-leads.mjs
// (which saves the result as leads/ranked and prints what it learns per niche) and the Accounts page.
import { filingRow, filedIso, leadScore, nicheTiers } from "./format.js";

export const FILINGS_SECTION = "From FX filings";
// What a filings row keeps on the Accounts page (the full row stays in the Recent FX filings tab).
export const RANKED_FIELDS = [
  "company_number", "company_name", "filed", "period_end", "turnover_gbp", "turnover_basis", "turnover_check", "size_estimate",
  "turnover_foreign_gbp", "group_parent", "fx_gain_loss_gbp", "fx_gain_loss_prior_gbp", "fx_today", "currency", "currencies_in_accounts",
  "fx_forwards", "fx_sensitivity", "turnover_regions", "subsidiaries_abroad", "reporting_currency", "fx_borrowings",
  "filed_fx_score", "filed_fx", "hmrc_trade", "moved_up", "incumbent_bank", "owner", "triggers", "run_from_abroad", "accounts_url",
  "employees", "bank_debt", "fd_search_url",
  "acquisitions", "acquisitions_evidence", "acquired_abroad", "new_fd_in_accounts", "new_fd_in_accounts_evidence",
];
const slim = (r) => Object.fromEntries(RANKED_FIELDS.filter((k) => r[k] !== undefined && r[k] !== "").map((k) => [k, r[k]]));

// {rows (filings companies not on the list, slim, with fx_niche / section / qualified), ruled_out ({number: reason}
// for both lists), niche_of ({number: corrected niche} for list companies), shy_of ({number: {niche, why}}: hard to
// broker, both lists), scored (every lead with its score)}.
export function rankLeads(listRows = [], filingRows = [], { enrich = {}, niches = {}, signals = {}, today = new Date() } = {}) {
  const tiers = nicheTiers(niches);
  const onList = new Set(listRows.map((r) => r.company_number));
  // A list company's niche: the corrected one (customs goods, else a sector code that really names a niche) wins over
  // the finder's older label; a sector niche the correction doesn't confirm (a catch-all code) is dropped.
  const sectorNames = new Set(Object.values(niches).filter((n) => n?.kind === "sector").map((n) => n.name));
  const nicheOf = {};
  for (const r of listRows) {
    const e = enrich[r.company_number];
    if (!e) continue;
    const niche = e.niche || (sectorNames.has(r.fx_niche) ? "" : r.fx_niche || "");
    if (niche !== (r.fx_niche || "")) nicheOf[r.company_number] = niche;
  }
  const ruledOut = {};
  const shyOf = {};   // hard to broker (tools/niche_hits.py, sourcer/niches.broker_shy): {number: {niche, why}}
  const tag = (r) => {
    const e = enrich[r.company_number] || {};
    if (e.absurd) ruledOut[r.company_number] = e.absurd;
    if (e.shy && !e.absurd) shyOf[r.company_number] = e.shy;
    return e;
  };
  const rows = filingRows.filter((r) => r.company_number && !onList.has(r.company_number)).map((r) => {
    const e = tag(r);
    return { ...slim(r), section: FILINGS_SECTION, from_filings: true, fx_niche: e.niche || "", sic: e.sic || [],
             ...(e.absurd ? { qualified: "Out", qualify_reason: e.absurd } : {}) };
  });
  listRows.forEach(tag);
  const ctx = { niches: tiers, signals, today };
  const scored = [...listRows.map((r) => ({ ...r, onList: true, fx_niche: nicheOf[r.company_number] ?? r.fx_niche })),
    ...rows.map((r) => ({ ...filingRow(r), onList: false }))]
    .map((r) => {
      const niche = r.fx_niche || "";
      const s = leadScore({ ...r, fx_niche: niche }, ctx);
      return { company_number: r.company_number, company_name: r.company_name, onList: r.onList, niche, score: s.score,
               parts: s.parts, absurd: ruledOut[r.company_number] || "", band: s.parts.some(([w]) => w.startsWith("Turnover £20m")),
               loss: s.parts.some(([w]) => w.startsWith("FX loss")) };
    })
    .sort((a, b) => b.score - a.score);
  return { rows, ruled_out: ruledOut, niche_of: nicheOf, shy_of: shyOf, scored };
}

// Per niche, from the scored leads: how many, average score, how many score 60+, in the band, with an FX loss, ruled out.
export const filedMonth = (r) => (filedIso(r) || "").slice(0, 7) || "unknown";

export function nicheLearnings(scored = [], minLeads = 8) {
  const by = new Map();
  for (const s of scored) {
    const k = s.niche || "(no niche)";
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(s);
  }
  return [...by].map(([niche, list]) => {
    const live = list.filter((s) => !s.absurd);
    const avg = live.length ? live.reduce((n, s) => n + s.score, 0) / live.length : 0;
    return { niche, leads: list.length, avg: Math.round(avg * 10) / 10, strong: live.filter((s) => s.score >= 60).length,
             band: live.filter((s) => s.band).length, loss: live.filter((s) => s.loss).length, ruled_out: list.length - live.length };
  }).filter((n) => n.leads >= minLeads).sort((a, b) => b.avg - a.avg);
}

// How Zac's verdicts (Good lead / Not a fit, api VERDICTS_KEY) split by where the lead came from, its niche, its lead
// score band and its hard-to-broker sector — what to recalibrate the score and the niches against. Each group:
// {key, good, not_fit, reviewed, good_share}; reasons: {reason: count}.
export const scoreBand = (score) => (score >= 80 ? "80+" : score >= 60 ? "60–79" : score >= 40 ? "40–59" : "under 40");
export function verdictLearnings(scored = [], verdicts = {}, { shyOf = {} } = {}) {
  const groups = { source: {}, niche: {}, band: {}, sector: {} };
  const reasons = {};
  let reviewed = 0;
  const add = (kind, key, v) => {
    const g = (groups[kind][key] ||= { key, good: 0, not_fit: 0 });
    g[v] += 1;
  };
  for (const s of scored) {
    const v = verdicts[s.company_number]?.verdict;
    if (v !== "good" && v !== "not_fit") continue;
    reviewed += 1;
    add("source", s.onList ? "Accounts list (finder)" : "FX filings scan", v);
    add("niche", s.niche || "(no niche)", v);
    add("band", scoreBand(s.score), v);
    if (shyOf[s.company_number]) add("sector", shyOf[s.company_number].niche, v);
    if (v === "not_fit") reasons[verdicts[s.company_number].reason || "No reason"] = (reasons[verdicts[s.company_number].reason || "No reason"] || 0) + 1;
  }
  const done = (o) => Object.values(o).map((g) => ({ ...g, reviewed: g.good + g.not_fit, good_share: Math.round((100 * g.good) / (g.good + g.not_fit)) }))
    .sort((a, b) => b.reviewed - a.reviewed);
  return { reviewed, source: done(groups.source), niche: done(groups.niche), band: done(groups.band), sector: done(groups.sector), reasons };
}
