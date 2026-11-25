// The Good leads tab's Top 20 (format.js topGoodLeads), worked out exactly as the Accounts page does it — the same rows,
// marks, owner answers and lead score from the site's private store — for a report to the coding session (Zac, 25 Nov
// 2026: "rank it now and tell me results"). Read-only. The repo is public, so the report is printed only encrypted to the
// public key given (RSA-OAEP + AES-256-GCM, gzipped JSON between REPORT-BEGIN / REPORT-END): the log shows counts and
// ciphertext, never a company or a person.
//   node scripts/top-good-report.mjs scripts/report-key.pem [out.enc]   — out.enc: the same ciphertext as a file (the workflow
//   commits it to the working branch for the session to pull: the session's network can't reach the log download host)
import { constants, createCipheriv, publicEncrypt, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { ALERTS_KEY, CHECKS_KEY, CONTACTED_KEY, DEALS_KEY, DOMAINS_KEY, KEY, LISTS_KEY, MOMENTS_KEY, NICHES_KEY, OWNERS_KEY, PARENTS_KEY, RANKED_KEY, STORE,
  VERDICTS_KEY, dealSignals, signalsByCompany } from "../api/accounts.mjs";
import { KEY as MARKET_KEY, STORE as MARKET_STORE } from "../api/market.mjs";
import { OWNERSHIP_LABEL, TOP_GOOD, fxSizeLine, fxSizeOf, goodLeadsList, industryOf, likeGoodLeads, movesByCurrency, nicheTiers, ownership, reviewLearnings,
  score100, setKnownGroups, setKnownLei, setKnownOwnerSearch, setKnownParents, setKnownSignals, setKnownSites, setScoreScale, topGoodLeads, topGoodLine, whyGood,
  withLeadScores } from "../src/accounts/format.js";
import { learningRows } from "../src/accounts/ranking.js";
import { openStore } from "./store.mjs";

const [keyPath, outPath] = process.argv.slice(2);
const publicKey = await readFile(keyPath, "utf8");
const store = await openStore(STORE);
const [list, ranked, verdicts, checks, lists, contacted, niches, alerts, deals, moments, domains, owners, parents] = await Promise.all(
  [KEY, RANKED_KEY, VERDICTS_KEY, CHECKS_KEY, LISTS_KEY, CONTACTED_KEY, NICHES_KEY, ALERTS_KEY, DEALS_KEY, MOMENTS_KEY, DOMAINS_KEY, OWNERS_KEY, PARENTS_KEY]
    .map((k) => store.get(k, "json")));
let moves = {};
try { moves = movesByCurrency(await (await openStore(MARKET_STORE)).get(MARKET_KEY, "json")); } catch { /* no market data: no currency moments */ }

// what ?view=signals and ?view=ranked give the page
const signals = signalsByCompany([...(alerts?.items || []), ...dealSignals(deals?.items || []), ...(moments?.items || [])]);
setKnownSites(Object.fromEntries(Object.entries(domains?.sites || {}).map(([n, s]) => [n, s.website])));
setKnownOwnerSearch(Object.fromEntries(Object.entries(owners?.companies || {}).filter(([, o]) => o.owner)
  .map(([n, o]) => [n, { owner: o.owner, kind: o.kind, country: o.country || "", quote: o.quote || "", url: o.url || "", chain: (o.chain || []).map((c) => c.owner) }])));
setKnownParents(Object.fromEntries(Object.entries(parents?.companies || {}).filter(([, p]) => p.ultimate_parent)
  .map(([n, p]) => [n, { ultimate_parent: p.ultimate_parent, country: p.country || "", evidence: p.evidence || "", accounts_url: p.accounts_url || "" }])));
setKnownSignals(signals);
setKnownGroups(ranked?.group_of);
setKnownLei(ranked?.gleif_of);

// the page's own rows (AccountsApp: baseRows → allRows) and its Good leads tab
const marks = { checks: checks || {}, verdicts: verdicts || {}, lists: lists || {} };
const baseRows = learningRows(list?.rows || [], ranked || {});
const reviews = reviewLearnings(baseRows, marks.checks, marks.verdicts, undefined, marks.lists);
const likes = likeGoodLeads(baseRows, marks.checks, marks.verdicts, marks.lists);
const allRows = withLeadScores(baseRows.map((r) => (marks.verdicts[r.company_number]?.verdict === "not_fit"
  ? { ...r, qualified: "Out", qualify_reason: `Not a fit: ${marks.verdicts[r.company_number].reason || "your review"}` } : r)),
{ niches: nicheTiers(niches?.niches || {}), signals, moves, madeAt: list?.made_at, reviews, likes });
setScoreScale(allRows.filter((r) => !r.dropped).map((r) => r.lead_score));
const good = goodLeadsList(allRows, marks);
const everyone = topGoodLeads(good, { contacted: contacted || {} }, { ...TOP_GOOD, n: Infinity });
const gemini = new Set(Object.entries(owners?.companies || {}).filter(([, o]) => o.gemini_at).map(([n]) => n));

const row = (x, i) => {
  const o = ownership(x.r);
  return { rank: i + 1, points: x.top.score, company: x.r.company_name, number: x.r.company_number, rating: x.rating, mark: x.mark.label,
    industry: industryOf(x.r), turnover: Number(x.r.turnover_gbp) || null, fx_a_year: fxSizeLine(fxSizeOf(x.r)), score: score100(x.r.lead_score),
    owner: { status: OWNERSHIP_LABEL[o.status], owner: o.owner || "", country: o.country || "", source: o.source || "" },
    owner_checked_by_gemini: gemini.has(x.r.company_number), why: topGoodLine(x.top), why_good: whyGood(x.r).text || "" };
};
const report = {
  made_at: new Date().toISOString(), list_made_at: list?.made_at || "", owners_made_at: owners?.made_at || "",
  good_leads: good.length, ranked: everyone.length, left_out: good.length - everyone.length,
  marks: good.reduce((c, x) => ({ ...c, [x.mark.label]: (c[x.mark.label] || 0) + 1 }), {}),
  rated: good.reduce((c, x) => ({ ...c, [x.rating || 0]: (c[x.rating || 0] || 0) + 1 }), {}),
  owners_checked_by_gemini: good.filter((x) => gemini.has(x.r.company_number)).length,
  rows: everyone.map(row),
};

// encrypted to the session's public key: a fresh AES key for the gzipped JSON, the key itself under RSA-OAEP (SHA-256)
const aes = randomBytes(32), iv = randomBytes(12);
const cipher = createCipheriv("aes-256-gcm", aes, iv);
const data = Buffer.concat([cipher.update(gzipSync(JSON.stringify(report))), cipher.final()]);
const sealed = { ek: publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, aes).toString("base64"),
  iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
const blob = Buffer.from(JSON.stringify(sealed)).toString("base64");
console.log(`Good leads: ${good.length}; ranked (not contacted, not out): ${everyone.length}; owner checked by Gemini so far: ${report.owners_checked_by_gemini}`);
console.log("REPORT-BEGIN");
for (let i = 0; i < blob.length; i += 160) console.log(blob.slice(i, i + 160));
console.log("REPORT-END");
if (outPath) await writeFile(outPath, blob + "\n");
