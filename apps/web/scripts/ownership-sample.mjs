// The ownership check (Gemini + Google Search first) on the best 30 leads, for Zac to compare by hand (16 Nov 2026: "use 30 leads and I will compare to
// see if it's actually accurate"):  node scripts/ownership-sample.mjs gleif.json [count]
// For each: what the accounts, the LEI register and Companies House each say, and the combined answer. Read-only; prints
// company names and their owners' (company) names only — a person found as the owner prints as "a person" (the repo is
// public). `--numbers` prints just the sample's company numbers (comma-separated), for the owner search to look up;
// a third argument, owners.json (tools/owner_search.py), adds the web search's answer.
import { readFile } from "node:fs/promises";
import { FILINGS_KEY, KEY, NICHES_KEY, RANKED_KEY, STORE, filingsMonthKey } from "../api/accounts.mjs";
import { ownershipOf, OWNERSHIP_LABEL } from "../src/accounts/control.js";
import { rankLeads } from "../src/accounts/ranking.js";
import { openStore } from "./store.mjs";

const args = process.argv.slice(2).filter((a) => a !== "--numbers");
const numbersOnly = process.argv.includes("--numbers");
const [gleifPath, countArg, ownersPath] = args;
let searched = {};
if (ownersPath) { try { searched = JSON.parse(await readFile(ownersPath, "utf8")).companies || {}; } catch { console.log("No owner search file"); } }
const count = Number(countArg) || 30;
let gleif = {};
try { gleif = JSON.parse(await readFile(gleifPath, "utf8")).companies || {}; } catch { console.log("No LEI file — LEI register column empty"); }
const store = await openStore(STORE);
const [list, index, niches, ranked] = await Promise.all([KEY, FILINGS_KEY, NICHES_KEY, RANKED_KEY].map((k) => store.get(k, "json")));
let filingRows = index?.rows || [];
for (const { month } of index?.months || []) filingRows = filingRows.concat((await store.get(filingsMonthKey(month), "json"))?.rows || []);
const listRows = list?.rows || [];
const byNumber = new Map([...filingRows, ...listRows].map((r) => [r.company_number, r]));
const { scored } = rankLeads(listRows, filingRows, { niches: niches?.niches || {} });
const groups = ranked?.group_of || {};
const top = scored.filter((s) => !s.absurd).slice(0, count);
if (numbersOnly) { process.stdout.write(top.map((s) => s.company_number).join(",")); process.exit(0); }
const tally = { uk: 0, foreign: 0, unknown: 0 };
let agree = 0;
let multi = 0;
console.log(`Ownership check — the best ${top.length} leads by lead score\n`);
top.forEach((s, i) => {
  const r = byNumber.get(s.company_number) || s;
  const found = searched[s.company_number];
  const o = ownershipOf(r, groups[s.company_number] || null, gleif[s.company_number] || null, found?.owner ? found : null);
  const person = (name) => (found?.kind === "person" && name === found.owner ? "a person" : name);
  tally[o.status] += 1;
  if (o.says.length > 1) { multi += 1; if (o.agree) agree += 1; }
  const said = (from) => {
    const x = o.says.find((y) => y.from === from);
    return x ? `${x.status === "uk" ? "UK" : x.status === "foreign" ? "Foreign" : "Not known"}${x.owner ? ` — ${person(x.owner)}` : ""}${x.status === "foreign" ? ` (${x.country})` : ""}${x.note ? ` (${x.note})` : ""}` : "—";
  };
  console.log(`${String(i + 1).padStart(2)}. ${r.company_name} (${s.company_number})`);
  console.log(`    ANSWER: ${OWNERSHIP_LABEL[o.status]}${o.owner ? ` — ${person(o.owner)}` : ""}${o.status === "foreign" ? ` (${o.country})` : ""}   [${o.source || "no source"}]`);
  console.log(`    chain: ${o.chain.map((c) => (found?.kind === "person" && c.startsWith(found.owner) ? "a person" : c)).join(" → ")}`);
  console.log(`    accounts: ${said("accounts")}   |   LEI register: ${said("LEI register")}   |   Companies House: ${said("Companies House")}   |   web search: ${found ? (found.owner ? said("web search") : "nothing found") : "not searched"}`);
});
console.log(`\nUK-owned ${tally.uk} · Foreign-owned ${tally.foreign} · not known ${tally.unknown}; where 2+ sources answered, they agreed ${agree} of ${multi}`);
console.log(`LEI file: ${Object.keys(gleif).length.toLocaleString()} tracked companies hold an LEI`);
