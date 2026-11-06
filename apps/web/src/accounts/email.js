// Investec's master cold email (Nov 2026), filled in from a company's own filed facts — rule-based, nothing sent.
//
// The first two paragraphs change with the research; the Investec paragraph and the ask stay as written. Golden rule:
// researched, not invasive. The research picks the regions, the currency pair and the opening of the second
// paragraph; it never quotes a forward contract, a lender, a borrowing or an FX gain back at the prospect. Anything
// the filings can't support is left as a [placeholder] for Zac to fill — never a guess (customs-derived countries and
// the niche's default currency are estimates, so they're not used).

const TITLES = new Set(["mr", "mrs", "ms", "miss", "dr", "sir", "dame", "prof", "lord", "lady"]);
const SMALL = new Set(["and", "of", "the", "for", "in", "on", "at", "to", "&"]);
const SUFFIX = /[\s,.]*\b(?:public limited company|limited|ltd|plc|llp)\.?\s*$/i;
const TRAILING = /\s+(?:\(?(?:holdings?|group)\)?|\(u\.?k\.?\))$/i;

// "BRITISH BAKELS LIMITED" -> "British Bakels"; "KEPAK GROUP LIMITED" -> "Kepak"; mixed-case names keep their casing.
export function naturalCompany(name = "") {
  let s = name.replace(SUFFIX, "").trim();
  for (let i = 0; i < 2 && TRAILING.test(s) && s.replace(TRAILING, "").trim(); i++) s = s.replace(TRAILING, "").trim();
  if (s !== s.toUpperCase()) return s;
  return s.split(/\s+/).map((w, i) => {
    const lower = w.toLowerCase();
    if (i > 0 && SMALL.has(lower)) return lower;
    // L.J., 3M, UK, JW — and a first word of three capitals is the company's initials (TXO, NCR, WMG)
    if (/[\d.]/.test(w) || w.replace(/[^A-Z]/g, "").length <= 2 || (i === 0 && /^[A-Z]{3}$/.test(w))) return w;
    return lower.replace(/(^|[-(])([a-z])/g, (m, p, c) => p + c.toUpperCase())
      .replace(/'([a-z])(?=[a-z]{2})/g, (m, c) => "'" + c.toUpperCase());   // O'Neill, but Hunt's
  }).join(" ");
}

// The finance contact's first name, when one is presented (not a Guess) and the name starts with a real first name.
export function firstName(r) {
  if (!r.finance_contact || r.finance_contact_confidence === "Guess") return "";
  const words = r.finance_contact.trim().split(/\s+/).filter((w) => !TITLES.has(w.toLowerCase().replace(/\.$/, "")));
  const first = words[0] || "";
  if (first.replace(/\./g, "").length < 2 || words.length < 2) return "";   // "J. Smith" or a lone word: not safe
  return first === first.toUpperCase() ? first[0] + first.slice(1).toLowerCase() : first;
}

const UK = /^(?:the\s+)?(?:united kingdom|u\.?k\.?|great britain|britain|england|scotland|wales|northern ireland|home|domestic)(?:\s*(?:&|and)\s*(?:ireland|channel islands))?$/i;
const VAGUE = /^(?:rest of (?:the )?world|other(?: countries| regions| countries regions)?|overseas|international|worldwide|non[- ]uk|export|rest of world outside europe|row)$/i;
const RENAME = [
  [/^(?:rest of (?:the )?)?(?:europe|european union|eu|eurozone|continental europe|europe excluding (?:the )?uk|other europe(?:an countries)?)$/i, "Europe"],
  [/^(?:united states(?: of america)?|usa|u\.s\.a?\.?|us)$/i, "the US"],
  [/^(?:north america|usa (?:&|and) canada)$/i, "North America"],
  [/^(?:the )?americas$/i, "the Americas"],
  [/^(?:asia[- ]pacific|apac)$/i, "Asia Pacific"],
  [/^(?:rest of )?asia$/i, "Asia"],
  [/^(?:the )?middle east$/i, "the Middle East"],
  [/^(?:the )?netherlands$/i, "the Netherlands"],
  [/^(?:(?:republic of )?ireland|eire)$/i, "Ireland"],
  [/^(?:uae|united arab emirates)$/i, "the UAE"],
];

// Turnover by region as the accounts give it ("United Kingdom £73.5m · Rest of Europe £5.8m · USA £1.4m") -> the
// places abroad, largest first: ["Europe", "the US"]. UK rows and catch-alls ("Rest of the World") are left out.
export function regionsAbroad(text = "") {
  const rows = String(text).split(/\s*·\s*|\s*;\s*/).map((part) => {
    const m = part.match(/^(.*?)\s*(?:(?:US\$|\$|€|£|¥)\s?([\d,.]+)\s*(k|m|bn)?)?\s*$/i);
    const name = (m?.[1] || "").replace(/[:\-–]+$/, "").trim();
    const value = m?.[2] ? parseFloat(m[2].replace(/,/g, "")) * ({ k: 1e3, m: 1e6, bn: 1e9 }[(m[3] || "").toLowerCase()] || 1) : 0;
    return { name, value };
  }).filter((x) => x.name && !UK.test(x.name) && !VAGUE.test(x.name));
  const names = rows.sort((a, b) => b.value - a.value).map(({ name }) => {
    const hit = RENAME.find(([re]) => re.test(name));
    if (hit) return hit[1];
    if (/^uk\s*(?:&|and)\s*europe$/i.test(name)) return "Europe";
    return name === name.toUpperCase() ? naturalCompany(name) : name;
  });
  return [...new Set(names)].slice(0, 3);
}

const CCY_SIGN = [[/US\$|\$/, "USD"], [/€/, "EUR"], [/¥/, "JPY"]];
const CCY_PLACE = { EUR: "Europe", CHF: "Switzerland", JPY: "Japan", CNY: "China", RMB: "China", HKD: "Hong Kong",
  AUD: "Australia", NZD: "New Zealand", CAD: "Canada", SEK: "Scandinavia", NOK: "Scandinavia", DKK: "Scandinavia",
  PLN: "Poland", CZK: "the Czech Republic", INR: "India", ZAR: "South Africa", SGD: "Singapore", AED: "the UAE" };
const REGION_CCY = [[/^(?:Europe|Ireland|France|Germany|Spain|Italy|the Netherlands|Belgium|Portugal|Austria|Finland)$/, "EUR"],
  [/^(?:the US|North America)$/, "USD"]];

function codes(text = "") {
  const out = [];
  for (const [re, code] of CCY_SIGN) if (re.test(text)) out.push(code);
  for (const m of String(text).matchAll(/\b([A-Z]{3})\b/g)) if (m[1] !== "GBP") out.push(m[1]);
  return out;
}

// The currencies the filings tie to the business, strongest source first: the finder's main currency (not when it's
// only the niche's default), forward contracts, currencies named in the accounts, then the regions they sell to.
export function currenciesFor(r, regions = regionsAbroad(r.turnover_regions)) {
  const found = [];
  if (r.main_currency && r.currency_source !== "niche") found.push(...codes(r.main_currency));
  found.push(...codes(r.fx_forwards), ...codes(r.currencies_in_accounts));
  if (!found.length) for (const place of regions) for (const [re, code] of REGION_CCY) if (re.test(place)) found.push(code);
  const known = new Set(["USD", "EUR", "JPY", "CHF", "CNY", "HKD", "AUD", "NZD", "CAD", "SEK", "NOK", "DKK", "PLN", "CZK",
    "INR", "ZAR", "SGD", "AED", "TRY", "HUF", "MXN", "BRL", "THB", "KRW", "ILS", "SAR", "QAR", "RON"]);
  return [...new Set(found.filter((c) => known.has(c)))].slice(0, 2);
}

const SOURCE = { forwards: "their forward contracts", geography: "their sales by region", text: "the currencies named in " +
  "their accounts", group: "their overseas group", customs: "their HMRC customs records" };

const listOf = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

function direction(r, regions) {
  const d = `${r.currency_direction || ""} ${r.currencies_in_accounts || ""}`.toLowerCase();
  if (/\bboth\b/.test(d)) return "both";
  const buys = /buys|import/.test(d), sells = /sells|export/.test(d) || (!buys && regions.length > 0);
  return buys && sells ? "both" : buys ? "buys" : sells ? "sells" : "";
}

const OPENING = {
  buys: "With overseas suppliers to pay",
  sells: "With sales coming in from overseas",
  both: "With your trading activity",
  "": "With your trading activity",
};

export const INVESTEC_PARAGRAPH = "I’m Zac from Investec’s Corporate Treasury team. We combine our strength in FX with the " +
  "depth of a full banking relationship to help protect margins and manage the risks of paying and getting paid overseas.";
export const ASK = "What’s your availability like on Tuesday or Thursday for an introduction?";
export const SIGN_OFF = "Speak soon,\nZac\nCorporate Treasury | Investec";

// The draft: { text, gaps (placeholders left for Zac), basis (where each filled-in part came from) }.
export function emailDraft(r) {
  const gaps = [], basis = [];
  const name = firstName(r);
  if (name) basis.push(`${r.finance_contact} (${r.finance_contact_confidence || "finance contact"})`);
  else gaps.push(r.no_fd_likely ? "First Name: ask for the MD" : "First Name: ask for the Finance Director");

  const company = naturalCompany(r.company_name || "") || "[Company Name]";
  const companys = /s$/i.test(company) ? `${company}’` : `${company}’s`;   // Bakels’, Kepak’s
  const regions = regionsAbroad(r.turnover_regions);
  const ccys = currenciesFor(r, regions);
  let places = regions;
  if (places.length) basis.push("regions from the turnover note in their accounts");
  else {
    places = [...new Set(ccys.map((c) => CCY_PLACE[c]).filter(Boolean))];
    if (places.length) basis.push(`${listOf(places)} from the currencies in their accounts`);
  }
  const opening = places.length
    ? `Given ${companys} trading relationships across ${listOf(places)}, I thought it would be worth getting in touch.`
    : `Given ${companys} international trading relationships, I thought it would be worth getting in touch.`;

  const pair = ccys.length ? listOf(ccys.map((c) => `GBP/${c}`)) : "[Currency Pair]";
  if (ccys.length) {
    const fromMain = r.main_currency && r.currency_source !== "niche" && codes(r.main_currency).includes(ccys[0]);
    const from = fromMain ? (SOURCE[r.currency_source] || "their filed accounts")
      : codes(r.fx_forwards).includes(ccys[0]) ? "their forward contracts"
      : codes(r.currencies_in_accounts).includes(ccys[0]) ? "the currencies named in their accounts" : "the regions they sell to";
    basis.push(`${pair} from ${from}`);
  } else gaps.push("Currency Pair: nothing in the filings names one");
  const way = direction(r, regions);
  const second = `${OPENING[way]}, I imagine movements in ${pair} are a regular consideration. I’d be interested to hear ` +
    "how you’re approaching this and explore where Investec might be able to support.";

  const text = [`Hi ${name || "[First Name]"},`, opening, second, INVESTEC_PARAGRAPH, ASK, SIGN_OFF].join("\n\n");
  return { text, gaps, basis };
}
