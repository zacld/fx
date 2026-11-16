// Where a company's finance decisions are made — in the UK, or by a parent abroad (Zac, 16 Nov 2026: "come up with
// indicators that can qualify or disqualify … whether the decisions in terms of finances happen in the UK"). Rule-based,
// from the records already on the row: the owner (PSC register), the lender holding its charges, its own hedging and
// facilities, the board's residence, and the accounts' own words (sourcer/control.py's `control_clues`: group treasury,
// cash pool, parent support, group funding, amounts owed to the parent, its own revolving credit facility). Each
// indicator says which way it points and why; the verdict is a lean, never a fact — the questions are for the call.

const UK = /\b(?:united kingdom|england|scotland|wales|northern ireland|great britain|uk|jersey|guernsey|isle of man)\b/i;
// UK clearing and mid-market banks: a facility with one of these is usually arranged and run from the UK.
const UK_BANKS = /\b(?:HSBC|BARCLAYS|LLOYDS|NATWEST|NATIONAL WESTMINSTER|ROYAL BANK OF SCOTLAND|BANK OF SCOTLAND|SANTANDER UK|INVESTEC|CLYDESDALE|VIRGIN MONEY|YORKSHIRE BANK|CLOSE BROTHERS|SHAWBROOK|ALLICA|METRO BANK|AIB GROUP \(UK\)|BANK OF IRELAND \(UK\)|ULSTER BANK|COUTTS|ARBUTHNOT|OAKNORTH|HAMPSHIRE TRUST|SECURE TRUST|UNITY TRUST|TSB)\b/i;
// banks a foreign group usually brings with it: their charge suggests the group banks (and decides) abroad
const FOREIGN_BANKS = [
  [/\b(?:GOLDMAN SACHS|JP ?MORGAN|JPMORGAN|BANK OF AMERICA|CITIBANK|CITIGROUP|WELLS FARGO|MORGAN STANLEY|PNC|TRUIST|US BANK|BANK OF NEW YORK)\b/i, "US"],
  [/\b(?:DEUTSCHE BANK|COMMERZBANK|BNP PARIBAS|SOCIETE GENERALE|SOCIÉTÉ GÉNÉRALE|CREDIT AGRICOLE|CRÉDIT AGRICOLE|ING BANK|ABN AMRO|RABOBANK|NORDEA|DANSKE|SEB|SVENSKA HANDELSBANKEN|UNICREDIT|INTESA|KBC|BELFIUS|RAIFFEISEN|DZ BANK|LANDESBANK|HELABA)\b/i, "European"],
  [/\b(?:MUFG|MITSUBISHI UFJ|SUMITOMO|MIZUHO|BANK OF CHINA|ICBC|CHINA CONSTRUCTION|BANK OF INDIA|STATE BANK OF INDIA|EMIRATES NBD|QATAR NATIONAL)\b/i, "Asian / Middle Eastern"],
];

const CLUE_TEXT = {
  group_treasury: ["Treasury is run centrally by the group", -30],
  fx_by_group: ["FX is managed by the group / parent", -35],
  cash_pool: ["Part of a group cash pool", -20],
  parent_support: ["Relies on the parent's support", -20],
  group_funding: ["Funded through the group's facilities", -20],
  owed_to_parent: ["Owes money to its parent", -10],
  own_rcf: ["Has its own revolving credit facility", 20],
  uk_treasury: ["Treasury team based in the UK", 30],
};

// The owner registered abroad, from the owners list ("ACME GMBH (corporate, Germany); …") or the run-from-abroad line.
export function foreignOwner(r = {}) {
  if (r.ultimate_parent && r.ultimate_parent_country && !UK.test(r.ultimate_parent_country)) return { name: r.ultimate_parent, country: r.ultimate_parent_country };
  for (const part of String(r.owners || "").split(";")) {
    const m = /^(.*?)\s*\(corporate,\s*([^)]+)\)/i.exec(part.trim());
    if (m && !UK.test(m[2])) return { name: m[1].trim(), country: m[2].trim() };
  }
  const line = /Owned from ([^(—]+?)\s*\(([^)]+)\)/.exec(r.run_from_abroad || r.owner || "");
  if (line) return { name: line[2].trim(), country: line[1].trim() };
  const by = /^Owned by (.+?) \(([^)]+)\)/.exec(r.owner || "");   // the FX filings research: "Owned by X GMBH (Germany)"
  return by && !UK.test(by[2]) && !/^\d/.test(by[2]) ? { name: by[1].trim(), country: by[2].trim() } : null;
}

const lenders = (r) => [r.incumbent_bank, r.main_bank, r.banking_relationships, r.bankers].filter(Boolean).join(" ; ");

// {verdict, lean ("uk" | "abroad" | "unclear" | "uk-owned"), score, signs: [{text, points}], questions}
export function financeSeat(r = {}) {
  const signs = [];
  const add = (text, points) => signs.push({ text, points });
  const owner = foreignOwner(r);
  if (owner) add(`Owned from ${owner.country} (${owner.name})`, -15);
  if (/\(U\.?K\.?\)|\bU\.?K\.?\s+(?:LIMITED|LTD|PLC)\b/i.test(r.company_name || "")) add("“UK” in the name — usually a foreign group's UK arm (scored in its own rule)", 0);
  const lent = lenders(r);
  const foreign = FOREIGN_BANKS.find(([rx]) => rx.test(lent));
  if (foreign) add(`Banks with ${foreign[0].exec(lent)[0].replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase())} — a ${foreign[1]} bank, so the group likely banks abroad`, -15);
  else if (UK_BANKS.test(lent) && r.incumbent_bank) add(`Its own facility with ${UK_BANKS.exec(lent)[0].replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase())} — a UK bank`, 20);
  if (r.fx_forwards) add("Its own forward contracts in the accounts", 25);
  else if (/^Uses/i.test(r.fx_today || "")) add(`Handles FX itself: ${r.fx_today}`, 20);
  if (r.fx_borrowings) add(`Borrows in its own name in another currency (${r.fx_borrowings})`, 10);
  for (const clue of String(r.control_clues || "").split(" ‖ ").filter(Boolean)) {
    const [, kind, quote] = clue.split("|");
    const [text, points] = CLUE_TEXT[kind] || [];
    if (text) add(`${text}: “${(quote || "").slice(0, 160)}”`, points);
  }
  const board = /^(\d+) of (\d+) directors/.exec(r.board_line || "");
  if (board) {
    const share = Number(board[1]) / Number(board[2]);
    if (share >= 0.5) add(`UK board: ${r.board_line}`, owner ? 15 : 5);
    else add(`Board mostly abroad: ${r.board_line}`, -15);
  }
  const score = signs.reduce((n, s) => n + s.points, 0);
  // owned abroad alone is "ask"; its own facility, hedging or UK treasury tip it to the UK, group treasury / cash pool /
  // parent support to abroad. A UK-owned company is "decided here" unless its accounts say the group runs it.
  const lean = !owner ? (score > -20 ? "uk-owned" : "abroad") : score >= 5 ? "uk" : score <= -20 ? "abroad" : "unclear";
  const verdict = { "uk-owned": "UK-owned — decided here", uk: "Owned abroad, but decides in the UK", abroad: "Likely run from abroad",
    unclear: "Unclear — ask where FX is decided" }[lean];
  const questions = lean === "uk-owned" ? [] : [
    `Is FX decided here in the UK, or by group treasury${owner ? ` in ${owner.country}` : ""}?`,
    "Do you have your own banking facilities in the UK, or does the group fund you?",
    "Who signs off a hedge — the UK finance team or the parent?",
    "Does the parent set the hedging policy, or do you?",
  ];
  return { verdict, lean, score, signs, questions, owner };
}

export const SEAT_LABEL = { "uk-owned": "UK-owned", uk: "Decides in UK", abroad: "Run from abroad", unclear: "Ask where decided" };

// Who owns it, all the way up, and is that in the UK (Zac, 16 Nov 2026: "figure out if they're based in the UK —
// that's our primary targets"). From, best first: the accounts' own "ultimate parent … incorporated in X" sentence; the
// daily ownership pass's walk up the register (`group`: {top, top_name, hops, abroad} — the top UK parent and any owner
// registered abroad above it); the company's own owners list. {status: "uk" | "foreign" | "unknown", owner, country,
// chain, source, searches: [[label, url]]} — the searches are Google links to check it by hand, never fetched.
const google = (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;
// `search`: the web search's answer (lead-sourcer/sourcer/owner_search.py — {owner, kind, country, quote, url}): the owner a
// person would name (TowerBrook, Investindustrial, a founder) where the registers stop at a holding company.
export function ownershipOf(r = {}, group = null, lei = null, search = null) {
  const name = r.company_name || "";
  // what each source says: {from, status, owner, country}
  const says = [];
  if (r.ultimate_parent && r.ultimate_parent_country) {
    says.push({ from: "accounts", status: UK.test(r.ultimate_parent_country) ? "uk" : "foreign", owner: r.ultimate_parent, country: r.ultimate_parent_country });
  }
  if (lei) {
    const top = lei.ultimate || lei.direct;
    const country = lei.ultimate ? lei.ultimate_country : lei.direct_country;
    if (top) says.push({ from: "LEI register", status: UK.test(country) ? "uk" : "foreign", owner: top, country });
    else if (/individuals/.test(lei.exception || "")) says.push({ from: "LEI register", status: "uk", owner: "", country: "UK", note: lei.exception });
  }
  // Companies House: an owner registered abroad above the top UK parent; else a foreign corporate owner; else people as
  // owners and where they live; a UK parent alone is only "UK" when something says who owns that parent (16 Nov 2026
  // sample: a company with no owner on the register was read as UK-owned — Mango, BoomBit — so that's "not known" now)
  const people = [...String(r.owners || "").matchAll(/\(individual,\s*([^)]+)\)/gi)].map((m) => m[1].trim());
  if (group?.abroad) {
    const m = /^(.*?)(?:\s*\(([^)]+)\))?$/.exec(group.abroad);
    if (!m[2]) says.push({ from: "Companies House", status: "unknown", owner: m[1], country: "", note: "registered outside the UK register, country not given" });
    else says.push({ from: "Companies House", status: UK.test(m[2]) ? "uk" : "foreign", owner: m[1], country: m[2] });
  } else {
    const f = foreignOwner({ ...r, ultimate_parent: "" });
    if (f) says.push({ from: "Companies House", status: "foreign", owner: f.name, country: f.country });
    else if (people.length && people.every((c) => !UK.test(c))) says.push({ from: "Companies House", status: "foreign", owner: "", country: people[0], note: "owned by individuals living abroad" });
    else if (people.length) says.push({ from: "Companies House", status: "uk", owner: group?.hops ? group.top_name : "", country: "UK", note: "owned by individuals in the UK" });
    else if (/^Owned by \d+ individual/.test(r.owner || "")) says.push({ from: "Companies House", status: "unknown", owner: "", country: "", note: "owned by individuals, where they live not read yet" });
    else if (group?.hops) says.push({ from: "Companies House", status: "unknown", owner: group.top_name, country: "", note: "top UK parent; who owns it isn't on the register" });
  }
  if (search?.owner) {
    const c = search.country || "";
    says.push({ from: "web search", status: c ? (UK.test(c) ? "uk" : "foreign") : "unknown", owner: search.owner, country: c,
      kind: search.kind, quote: search.quote, url: search.url,
      note: `${search.kind === "pe" ? "private equity" : search.kind === "person" ? "a person" : "a company"}${c ? "" : ", country not stated"}` });
  }
  // a foreign owner named anywhere wins (the register can stop at a UK holding company the accounts or LEI see past);
  // then any definite answer; "not known" only when nothing is definite
  const known = says.filter((x) => x.status !== "unknown");
  const best = known.find((x) => x.status === "foreign") || known.find((x) => x.owner) || known[0] || says[0];
  const status = best ? best.status : "unknown";
  // the owner shown: the search's (the name a person would give) when it found one, else the best source's
  const found = says.find((x) => x.from === "web search");
  const owner = found?.owner || best?.owner || (group?.hops ? group.top_name : "");
  const country = best?.country || "";
  const agree = known.length > 1 && known.every((x) => x.status === status);
  const chain = [name];
  if (group?.hops && group.top_name) chain.push(`${group.top_name} (UK)`);
  if (best?.owner && best.owner !== chain[chain.length - 1] && best.owner !== name && best.owner !== owner) chain.push(best.status === "foreign" ? `${best.owner} (${best.country})` : best.owner);
  // the search's own steps up the chain ("who owns X?" → a company → "who owns that?")
  for (const step of (found ? (search?.chain || []).map((c) => (typeof c === "string" ? c : c?.owner || "")).slice(0, -1) : [])) if (step && !chain.some((c) => c.startsWith(step))) chain.push(step);
  if (owner && owner !== chain[chain.length - 1] && owner !== name) chain.push(found?.country || (status === "foreign" && !found) ? `${owner} (${found?.country || country})` : owner);
  const searches = [[`Who owns ${name}?`, google(`who owns ${name}`)]];
  const top = owner && owner !== name ? owner : group?.top_name;
  if (top && top !== name) searches.push([`Where is ${top} based?`, google(`${top} headquarters`)]);
  searches.push([`${name} parent company`, google(`"${name}" parent company`)]);
  const source = best ? `${best.from}${known.length > 1 ? (agree ? ` (${known.length} sources agree)` : " (sources differ — check)") : ""}` : "";
  return { status, owner, country, chain, source, says, agree, searches, kind: found?.kind || "", evidence: found ? { quote: found.quote, url: found.url } : null };
}
export const OWNERSHIP_LABEL = { uk: "UK-owned", foreign: "Foreign-owned", unknown: "Owner not known" };
