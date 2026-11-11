// Every lead we've scanned, ranked by the lead score (format.js leadScore): the Accounts list's companies and the
// Recent FX filings list's not on it yet, each with its niche (what its customs records show it trading, else its
// sector — tools/niche_hits.py) and an absurd check (banks, insurers, funds, FX providers themselves, public bodies,
// not-for-profits, dissolved companies: sourcer/absurd.py) that qualifies it Out. Shared by scripts/rank-leads.mjs
// (which saves the result as leads/ranked and prints what it learns per niche) and the Accounts page.
import { filingRow, leadScore, nicheTiers } from "./format.js";

export const FILINGS_SECTION = "From FX filings";
// What a filings row keeps on the Accounts page (the full row stays in the Recent FX filings tab).
export const RANKED_FIELDS = [
  "company_number", "company_name", "filed", "period_end", "turnover_gbp", "turnover_basis", "turnover_check", "size_estimate",
  "turnover_foreign_gbp", "group_parent", "fx_gain_loss_gbp", "fx_gain_loss_prior_gbp", "fx_today", "currency", "currencies_in_accounts",
  "fx_forwards", "fx_sensitivity", "turnover_regions", "subsidiaries_abroad", "reporting_currency", "fx_borrowings",
  "filed_fx_score", "filed_fx", "hmrc_trade", "moved_up", "incumbent_bank", "owner", "triggers", "run_from_abroad", "accounts_url",
  "employees", "bank_debt", "fd_search_url",
];
const slim = (r) => Object.fromEntries(RANKED_FIELDS.filter((k) => r[k] !== undefined && r[k] !== "").map((k) => [k, r[k]]));

// {rows (filings companies not on the list, slim, with fx_niche / section / qualified), ruled_out ({number: reason}
// for both lists), scored (every lead with its score, for the report)}.
export function rankLeads(listRows = [], filingRows = [], { enrich = {}, niches = {}, signals = {}, today = new Date() } = {}) {
  const tiers = nicheTiers(niches);
  const onList = new Set(listRows.map((r) => r.company_number));
  const ruledOut = {};
  const tag = (r) => {
    const e = enrich[r.company_number] || {};
    if (e.absurd) ruledOut[r.company_number] = e.absurd;
    return e;
  };
  const rows = filingRows.filter((r) => r.company_number && !onList.has(r.company_number)).map((r) => {
    const e = tag(r);
    return { ...slim(r), section: FILINGS_SECTION, from_filings: true, fx_niche: e.niche || "", sic: e.sic || [],
             ...(e.absurd ? { qualified: "Out", qualify_reason: e.absurd } : {}) };
  });
  listRows.forEach(tag);
  const ctx = { niches: tiers, signals, today };
  const scored = [...listRows.map((r) => ({ ...r, onList: true })), ...rows.map((r) => ({ ...filingRow(r), onList: false }))]
    .map((r) => {
      const niche = r.fx_niche || enrich[r.company_number]?.niche || "";
      const s = leadScore({ ...r, fx_niche: niche }, ctx);
      return { company_number: r.company_number, company_name: r.company_name, onList: r.onList, niche, score: s.score,
               parts: s.parts, absurd: ruledOut[r.company_number] || "", band: s.parts.some(([w]) => w.startsWith("Turnover £20m")),
               loss: s.parts.some(([w]) => w.startsWith("FX loss")) };
    })
    .sort((a, b) => b.score - a.score);
  return { rows, ruled_out: ruledOut, scored };
}

// Per niche, from the scored leads: how many, average score, how many score 60+, in the band, with an FX loss, ruled out.
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
