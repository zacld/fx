import { describe, expect, it } from "vitest";
import { askFor, monthLabel, chCompanyUrl, isGroupFiling, turnoverSearch, filedWhen, filingRow, filterFilings, sortFilings, bankUrl, companyPath, fxFacts, fxGroup, contactClues, contactGroup, presentedContact, detailSections, numberFromPath, roleGroup, sourceDocuments, factUrl, filterRows, fxLine, fxShare, googleFd, hasConfirmedFd, isFinanceDirector, isNew, money, sortRows, toCsv, wallet } from "./format.js";

const rows = [
  { rank: 1, section: "Core", company_name: "L.J. FAIRBURN AND SON LIMITED", finance_contact: "Alan Metcalfe",
    finance_contact_role: "Finance Director", finance_contact_confidence: "Confirmed", turnover_gbp: "116362737",
    fx_wallet_low_gbp: "43700000", fx_wallet_high_gbp: "94400000", currency_pairs: "GBP/EUR|GBP/USD",
    triggers: "HSBC facility from 2022-10 — renewal is near" },
  { rank: 2, section: "Core", company_name: "NATCO FOODS LIMITED", finance_contact: "Devinder Shinh",
    finance_contact_role: "Financial Controller", finance_contact_confidence: "Confirmed", turnover_gbp: "300000000",
    currency_pairs: "GBP/USD" },
  { rank: 3, section: "Above", company_name: "QUATRA UK LTD", currency_pairs: "GBP/EUR", call_angle: 'Say "hi", then' },
];

describe("accounts helpers", () => {
  it("formats money", () => {
    expect(money("116362737")).toBe("£116.4m");
    expect(money("-1925")).toBe("−£2k");
    expect(money("")).toBe("");
    expect(wallet(rows[0])).toBe("£43.7m–£94.4m");
  });

  it("tells a finance director from a controller", () => {
    expect(isFinanceDirector("Finance & Administration Director")).toBe(true);
    expect(isFinanceDirector("Group CFO")).toBe(true);
    expect(isFinanceDirector("Financial Controller")).toBe(false);
    expect(rows.map(hasConfirmedFd)).toEqual([true, false, false]);
  });

  it("filters and sorts", () => {
    expect(filterRows(rows, { fdOnly: true }).map((r) => r.rank)).toEqual([1]);
    expect(filterRows(rows, { pair: "GBP/USD" }).map((r) => r.rank)).toEqual([1, 2]);
    expect(filterRows(rows, { contact: "Ask for the FD" }).map((r) => r.rank)).toEqual([3]);
    expect(filterRows(rows, { query: "natco" }).map((r) => r.rank)).toEqual([2]);
    expect(filterRows(rows, { section: "Above" }).map((r) => r.rank)).toEqual([3]);
    expect(filterRows(rows, { triggersOnly: true }).map((r) => r.rank)).toEqual([1]);
    const withOut = [...rows, { rank: 4, section: "Core", company_name: "OUT LTD", qualified: "Out" }];
    expect(filterRows(withOut).map((r) => r.rank)).toEqual([1, 2, 3]);                    // "Out" hidden by default
    expect(filterRows(withOut, { showOut: true }).map((r) => r.rank)).toEqual([1, 2, 3, 4]);
    expect(sortRows(rows, "turnover").map((r) => r.rank)).toEqual([2, 1, 3]);
    expect(sortRows(rows, "confidence").map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("groups by who is named, hottest confirmed first, then our score", () => {
    const list = [
      { rank: 1, finance_contact: "A", finance_contact_confidence: "Likely" },
      { rank: 2 },
      { rank: 3, finance_contact: "C", finance_contact_confidence: "Verified" },
      { rank: 4, finance_contact: "D", finance_contact_confidence: "Guess" },
      { rank: 5, finance_contact: "E", finance_contact_confidence: "Confirmed" },
    ];
    // a Guess is never presented as the contact: it's a clue, and the page says who to ask for instead
    expect(list.map(contactGroup)).toEqual(["Likely", "Ask for the FD", "Confirmed", "Ask for the FD", "Confirmed"]);
    expect(sortRows(list, "contactFirst").map((r) => r.rank)).toEqual([3, 5, 1, 2, 4]);
    expect(sortRows(list, "rank").map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(filterRows(list, { contact: "Confirmed" }).map((r) => r.rank)).toEqual([3, 5]);
  });

  it("leads with what their filings prove about FX, strongest first", () => {
    const list = [
      { rank: 1, filed_fx_score: "0", main_currency: "EUR", currency_source: "HMRC customs (estimated mix)" },
      { rank: 2, filed_fx_score: "95", currencies_in_accounts: "USD (buys), EUR", fx_notes_url: "https://x/doc#page=31",
        fx_forwards: "Forward contracts to buy US$5.2m (prior year US$3.1m)", fx_today: "Uses forward contracts",
        fx_forwards_evidence: "\"…to purchase US$5.2m (2023: US$3.1m)\" (filed accounts, p31)",
        fx_sensitivity: "10% move in sterling against USD: £450k on profit — \"If sterling had weakened…\"",
        turnover_regions: "United Kingdom £40.1m · Europe £12m", turnover_regions_url: "https://x/doc#page=22" },
      { rank: 3, filed_fx_score: "25", fx_today: "Uses an FX provider: Ebury", fx_today_url: "https://ch/charges" },
    ];
    expect(sortRows(list).map((r) => r.rank)).toEqual([2, 3, 1]);
    expect(list.map(fxGroup)).toEqual(["No FX in the filings yet", "Strong FX proof", "Some FX proof"]);
    const facts = Object.fromEntries(fxFacts(list[1]).map(([k, v, url, quote]) => [k, [v, url, quote]]));
    expect(facts.Currencies).toEqual(["USD (buys), EUR", "https://x/doc#page=31", undefined]);
    expect(facts["How they do FX"][0]).toBe("Forward contracts to buy US$5.2m (prior year US$3.1m)");   // policy not repeated
    expect(facts["How they do FX"][2]).toMatch(/US\$5\.2m/);
    expect(facts["Currency sensitivity"][0]).toBe("10% move in sterling against USD: £450k on profit");
    expect(facts["Sales by region"][1]).toBe("https://x/doc#page=22");
    expect(fxFacts(list[0])).toEqual([["Currencies", "EUR (HMRC customs (estimated mix))", "", undefined]]);
    expect(fxFacts(list[2])[0]).toEqual(["How they do FX", "Uses an FX provider: Ebury", "https://ch/charges", undefined]);
    expect(toCsv([list[1]]).split("\n")[0]).toContain("filed_fx_score,filed_fx,currencies_in_accounts,fx_forwards");
    const sub = { group_fx: "Forward contracts to buy US$5m; FX loss £250k", group_fx_url: "https://p/doc#page=30",
                  group_parent_accounts: "ACME HOLDINGS LIMITED (01234567): group turnover £120m" };
    expect(fxFacts(sub)).toEqual([["Group", sub.group_fx, sub.group_fx_url, sub.group_parent_accounts]]);
    expect(sourceDocuments(sub).map(([label]) => label)).toContain("Parent company's accounts");
  });

  it("links the turnover to its page and says when it isn't disclosed", () => {
    const r = { company_number: "07810330", accounts_url: "https://x/doc", turnover_url: "https://x/doc#page=13",
                turnover_gbp: "80354000", turnover_source: "accounts p13: company profit and loss account, £'000 — \"Turnover 2 80,354 70,650\"" };
    expect(sourceDocuments(r).map(([label]) => label)).toContain("Accounts at the turnover line");
    const company = Object.fromEntries(detailSections(r).find(([s]) => s === "Company")[1].map(([k, v, u]) => [k, [v, u]]));
    expect(company["Turnover source"]).toEqual([r.turnover_source, r.turnover_url]);
    const none = { turnover_check: "turnover not disclosed: the profit and loss account starts at gross profit (abridged accounts)" };
    expect(Object.fromEntries(detailSections(none).find(([s]) => s === "Company")[1].map(([k, v]) => [k, v])).Turnover)
      .toMatch(/not disclosed/);
  });

  it("shows who to ask for, with research clues, when nobody is confirmed", () => {
    const guess = { finance_contact: "Sally Sec", finance_contact_role: "Company Secretary", finance_contact_confidence: "Guess",
                    finance_contact_clues: "Bob Jones — signed the accounts" };
    expect(presentedContact(guess)).toBe(false);
    expect(contactClues(guess)).toEqual(["Sally Sec (Company Secretary) — not confirmed", "Bob Jones — signed the accounts"]);
    expect(askFor(guess)).toBe("Ask for the Finance Director");
    expect(askFor({ no_fd_likely: "no finance director …" })).toBe("Ask for the Managing Director");
    const likely = { finance_contact: "Ann Lee", finance_contact_role: "Director (FCA)", finance_contact_confidence: "Likely" };
    expect([presentedContact(likely), contactClues(likely)]).toEqual([true, []]);
    expect(filterRows([{ rank: 1, ...guess }], { query: "bob jones" }).length).toBe(1);   // clues are searchable
  });

  it("sorts and filters by the finance contact's job role, most senior first", () => {
    const person = (rank, role, conf = "Confirmed") => ({ rank, finance_contact: `P${rank}`, finance_contact_role: role, finance_contact_confidence: conf });
    const list = [
      person(1, "Finance Manager"), person(2, "Director"), person(3, "Group Finance Director", "Guess"),
      person(4, "Financial Controller"), { rank: 5 }, person(6, "Chief Financial Officer"),
      person(7, "Management Accountant"), person(8, "Head of Finance"), person(9, "Assistant Financial Controller"),
      person(10, "Commercial Finance Manager"), person(11, "Head of Logistics"),
    ];
    expect(list.map(roleGroup)).toEqual([
      "Finance Manager", "Other director", "No one named", "Financial Controller", "No one named",
      "CFO / Finance Director", "Accountant", "Head of Finance / Treasurer", "Financial Controller", "Finance Manager", "Other role",
    ]);
    // CFO/FD first, then head of finance, controllers, managers, accountants, other directors… (a Guess counts as no one)
    expect(sortRows(list, "role").map((r) => r.rank)).toEqual([6, 8, 4, 9, 1, 10, 7, 2, 11, 3, 5]);
    expect(filterRows(list, { role: "Finance Manager" }).map((r) => r.rank)).toEqual([1, 10]);
  });

  it("labels the latest scan's additions new and filters recent FX losses", () => {
    const list = [
      { rank: 1, first_seen: "2026-10-28T06:00:00+00:00", recent_fx_loss: "£150,512 FX loss, accounts filed 2026-09-12" },
      { rank: 2, first_seen: "2026-10-20T06:00:00+00:00" },
      { rank: 3 },
    ];
    const madeAt = "2026-10-28T06:00:00+00:00";
    expect(list.map((r) => isNew(r, madeAt))).toEqual([true, false, false]);
    expect(isNew(list[0], "")).toBe(false);
    expect(filterRows(list, { newOnly: true, madeAt }).map((r) => r.rank)).toEqual([1]);
    expect(filterRows(list, { fxLossOnly: true }).map((r) => r.rank)).toEqual([1]);
  });

  it("moves contacted companies off the list into the contacted view", () => {
    const list = [{ rank: 1, company_number: "01" }, { rank: 2, company_number: "02" }, { rank: 3, company_number: "03" }];
    const contacted = { "01": { at: "2026-10-27T09:00:00Z" }, "03": { at: "2026-10-28T09:00:00Z" } };
    expect(filterRows(list, { contacted }).map((r) => r.rank)).toEqual([2]);
    expect(filterRows(list, { query: "call back", notes: { "02": { text: "Call back in January" } } }).map((r) => r.rank)).toEqual([2]);
    expect(filterRows(list, { contacted, view: "contacted" }).map((r) => r.rank)).toEqual([1, 3]);
  });

  it("sorts by largest FX loss, then gains, then no figure", () => {
    const rows = [
      { rank: 1, fx_gain_loss_gbp: "-50000", turnover_gbp: "40000000" },
      { rank: 2, fx_gain_loss_gbp: "" },
      { rank: 3, fx_gain_loss_gbp: "120000" },
      { rank: 4, fx_gain_loss_gbp: "-900000", turnover_gbp: "60000000" },
      { rank: 5, fx_gain_loss_gbp: "30000" },
    ];
    expect(sortRows(rows, "fxLoss").map((r) => r.rank)).toEqual([4, 1, 3, 5, 2]);
    expect(fxShare(rows[3])).toBe("1.5% of turnover");
    expect(fxShare(rows[0])).toBe("0.1% of turnover");
    expect(fxShare({ fx_gain_loss_gbp: "-1000", turnover_gbp: "50000000" })).toBe("<0.1% of turnover");
    expect(fxShare(rows[2])).toBe("");
    expect(fxLine({ ...rows[3], fx_gain_loss_prior_gbp: "-400000" })).toBe("−£900k loss (1.5% of turnover; prior year −£400k)");
  });

  it("links each fact to the record it came from", () => {
    const r = {
      accounts_url: "https://ch/acc", fx_gain_loss_url: "https://ch/acc#page=22", incumbent_bank_url: "https://ch/charge",
      main_bank: "HSBC", incumbent_bank: "HSBC: all-assets debenture since 1 Jan 2020 (Companies House charges register)",
    };
    expect(bankUrl(r)).toBe("https://ch/charge");                                 // the bank holding the debenture
    expect(bankUrl({ ...r, main_bank: "Barclays" })).toBe("https://ch/acc");      // named in the accounts' Bankers line
    expect(factUrl(r, "FX loss of £420k on the latest accounts")).toBe("https://ch/acc#page=22");
    expect(factUrl(r, "New charge to Lloyds registered 3 months ago")).toBe("https://ch/charge");
    expect(factUrl(r, "Turnover grew 24% last year")).toBe("https://ch/acc");
    expect(factUrl(r, "New finance director appointed")).toBe("");
    expect(factUrl({}, "FX loss of £420k")).toBe("");                              // older lists: no link
  });

  it("gives each company its own page with every detail and the documents behind it", () => {
    expect(companyPath("SC123456")).toBe("/accounts/SC123456");
    expect(numberFromPath("/accounts/sc123456")).toBe("SC123456");
    expect(numberFromPath("/accounts")).toBe("");
    expect(numberFromPath("/accounts/../x")).toBe("");
    const r = {
      main_bank: "HSBC", incumbent_bank: "HSBC: all-assets debenture", incumbent_bank_url: "https://ch/charge",
      accounts_url: "https://ch/acc", fx_gain_loss_url: "https://ch/acc#page=22", fx_gain_loss_gbp: "-150512",
      turnover_gbp: "120000000", finance_contact_evidence: "CH occupation", companies_house_url: "https://ch/company/01",
    };
    const sections = Object.fromEntries(detailSections(r));
    expect(Object.keys(sections)).toEqual(["Banking", "FX exposure", "People"]);       // empty sections left out
    expect(sections.Banking[0]).toEqual(["Main bank", "HSBC", "https://ch/charge"]);
    expect(sections["FX exposure"][0]).toEqual(["FX gain/loss", "−£151k loss (0.1% of turnover; prior year n/a)", "https://ch/acc#page=22"]);
    expect(sourceDocuments(r).map(([label]) => label)).toEqual([
      "Latest filed accounts", "Accounts at the FX line", "Charge: HSBC", "Companies House record", "Filing history",
      "Charges register", "Officers", "Owners (PSCs)",
    ]);
    expect(sourceDocuments({ ...r, fx_gain_loss_url: "https://ch/acc" }).map(([l]) => l)).not.toContain("Accounts at the FX line");
  });

  it("searches Google for the company's finance director", () => {
    expect(googleFd(rows[0])).toBe("https://www.google.com/search?q=L.J.+FAIRBURN+AND+SON+finance+director");
    expect(googleFd({ company_name: "Babystyle Ltd." })).toBe("https://www.google.com/search?q=Babystyle+finance+director");
  });

  it("exports CSV that spreadsheets open as text, not formulas", () => {
    const csv = toCsv([{ notes: '=HYPERLINK("http://x","click")', fx_gain_loss_gbp: "-150512", opener: "-2+3", x: "@SUM(A1)" }],
                      ["notes", "fx_gain_loss_gbp", "opener", "x"]);
    expect(csv.split("\n")[1]).toBe(`"'=HYPERLINK(""http://x"",""click"")",-150512,'-2+3,'@SUM(A1)`);
  });

  it("exports CSV with quoting", () => {
    const csv = toCsv([rows[2]], ["company_name", "call_angle"]);
    expect(csv).toBe('company_name,call_angle\nQUATRA UK LTD,"Say ""hi"", then"');
  });
});


describe("recent FX filings", () => {
  const rows = [
    { company_number: "01234567", company_name: "ACME LTD", filed: "2026-11-04", filed_fx_score: 65, fx_gain_loss_gbp: "-420000",
      currencies_in_accounts: "USD (buys)", accounts_url: "https://ch/company/01234567/filing-history", currency: "USD" },
    { company_number: "SC123456", company_name: "GLEN FOODS LTD", filed: "October 2026", filed_fx_score: 20, fx_gain_loss_gbp: "15000" },
  ];
  it("filters by search, strong proof and FX loss", () => {
    expect(filterFilings(rows, { query: "usd" }).map((r) => r.company_number)).toEqual(["01234567"]);
    expect(filterFilings(rows, { query: "sc1234" }).map((r) => r.company_name)).toEqual(["GLEN FOODS LTD"]);
    expect(filterFilings(rows, { strongOnly: true })).toHaveLength(1);
    expect(filterFilings(rows, { lossOnly: true })[0].company_name).toBe("ACME LTD");
    expect(filterFilings(rows)).toHaveLength(2);
    expect(filterFilings([{ moved_up: "Moved up from small accounts (…)" }, {}], { movedOnly: true })).toHaveLength(1);
    expect(filterFilings([{ fx_mentions: ["Purchases are paid in US dollars."] }], { query: "dollars" })).toHaveLength(1);
  });
  it("puts owned-abroad companies (no local FX) a little lower when sorting strongest first", () => {
    const list = [{ company_number: "a", filed: "2026-10-01", filed_fx_score: 65, run_from_abroad: "Owned from Sweden (…) — pitch the UK team" },
      { company_number: "b", filed: "2026-09-01", filed_fx_score: 60, run_from_abroad: "" },
      { company_number: "c", filed: "2026-10-02", rank_score: 30, filed_fx_score: 55 }];
    expect(sortFilings(list).map((r) => r.company_number)).toEqual(["a", "b", "c"]);   // newest: as stored
    expect(sortFilings(list, "strongest").map((r) => r.company_number)).toEqual(["b", "a", "c"]);
    const hot = [{ rank: 1, filed_fx_score: "62", run_from_abroad: "Owned from Sweden — pitch the UK team" },
      { rank: 2, filed_fx_score: "55" }, { rank: 3, filed_fx_score: "20" }];
    expect(sortRows(hot, "hot").map((r) => r.rank)).toEqual([2, 1, 3]);   // lower, but still in its Strong group
  });
  it("links each fact to the filing and says when it was filed", () => {
    const row = filingRow(rows[0]);
    expect(row.fx_gain_loss_url).toBe(rows[0].accounts_url);
    expect(row.main_currency).toBe("USD");
    expect(fxFacts(row).map(([label]) => label)).toEqual(["Currencies", "FX gain/loss"]);
    expect(filedWhen("2026-11-04")).toBe("4 Nov 2026");
    expect(filedWhen("October 2026")).toBe("October 2026");
    expect(monthLabel("2026-09")).toBe("Sep 2026");
    expect(chCompanyUrl("11022760")).toBe("https://find-and-update.company-information.service.gov.uk/company/11022760");
    expect([isGroupFiling({ turnover_basis: "group" }), isGroupFiling({ also_filed: "X LTD (01)" }), isGroupFiling({})]).toEqual([true, true, false]);
    expect(turnoverSearch("CASTOLIN EUTECTIC LIMITED")).toBe("https://www.google.com/search?q=%22CASTOLIN%20EUTECTIC%22%20turnover");
    expect(filterFilings([{ company_name: "X", hmrc_trade: "imports in 9 of the last 12 months" }], { query: "imports" })).toHaveLength(1);
  });
});
