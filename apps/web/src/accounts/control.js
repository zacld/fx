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
