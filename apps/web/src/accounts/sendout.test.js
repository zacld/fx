import { describe, expect, it } from "vitest";
import { CEDAR_COLUMNS, DEFAULT_MESSAGE, SENDOUT, addressFlags, cedarRow, companyLabel, fillMessage, inBatches, sendoutPick, sendoutWeek, splitAddress, teamName } from "./sendout.js";
import { setKnownGroups } from "./format.js";

describe("The send-out week: from Wednesday 18:00 UK time", () => {
  it("is the latest Wednesday whose 18:00 has passed, in UK time", () => {
    expect(sendoutWeek(new Date("2026-11-25T17:59:00Z"))).toBe("2026-11-18");   // Wednesday 17:59 GMT: still last week's
    expect(sendoutWeek(new Date("2026-11-25T18:00:00Z"))).toBe("2026-11-25");   // Wednesday 18:00 GMT: this week's
    expect(sendoutWeek(new Date("2026-11-27T10:00:00Z"))).toBe("2026-11-25");   // Friday
    expect(sendoutWeek(new Date("2026-12-01T09:00:00Z"))).toBe("2026-11-25");   // the next Tuesday
    expect(sendoutWeek(new Date("2026-12-02T18:30:00Z"))).toBe("2026-12-02");
  });
  it("counts 18:00 in British Summer Time (17:00 UTC) as the start", () => {
    expect(sendoutWeek(new Date("2026-07-01T16:59:00Z"))).toBe("2026-06-24");
    expect(sendoutWeek(new Date("2026-07-01T17:00:00Z"))).toBe("2026-07-01");
  });
});

describe("Registered offices in the Cedar sheet's columns", () => {
  it("drops the county, keeps the town and joins a short unit number to its street", () => {
    expect(splitAddress({ registered_address: "Unit 3, Harbour Trade Park, Mill Lane Industrial Estate, Chepstow, Monmouthshire", postcode: "NP16 9ZZ" }))
      .toEqual({ care_of: "", line1: "Unit 3, Harbour Trade Park", line2: "Mill Lane Industrial Estate", city: "Chepstow", postcode: "NP16 9ZZ" });
    expect(splitAddress({ registered_address: "12 Mill Street, Canal Wharf, Bradford, West Yorkshire", postcode: "BD1 9ZZ" }))
      .toEqual({ care_of: "", line1: "12 Mill Street", line2: "Canal Wharf", city: "Bradford", postcode: "BD1 9ZZ" });
    expect(splitAddress({ registered_address: "Ash House, Station Road, Honley, Huddersfield, West Yorkshire", postcode: "HD9 9ZZ" }))
      .toMatchObject({ line1: "Ash House", line2: "Station Road, Honley", city: "Huddersfield" });
  });
  it("handles a one-street address, a repeated premises, the postcode or country inside the line, and care of", () => {
    expect(splitAddress({ registered_address: "Unit 9 Riverside Industrial Estate, Preston", postcode: "PR1 9ZZ" }))
      .toMatchObject({ line1: "Unit 9 Riverside Industrial Estate", line2: "", city: "Preston" });
    expect(splitAddress({ registered_address: "Brook House, Brook House, Willow Industrial Estate, Carlisle, England, CA1 9ZZ", postcode: "CA1 9ZZ" }))
      .toMatchObject({ line1: "Brook House", line2: "Willow Industrial Estate", city: "Carlisle" });
    expect(splitAddress({ registered_address: "C/O Example Accountants LLP, 2 High Street, Lincoln", postcode: "LN1 9ZZ" }))
      .toMatchObject({ care_of: "C/O Example Accountants LLP", line1: "2 High Street", city: "Lincoln" });
    expect(splitAddress({})).toEqual({ care_of: "", line1: "", line2: "", city: "", postcode: "" });
  });
  it("flags an address that may not reach the team", () => {
    const kinds = (r, shared) => addressFlags(r, { shared }).map((f) => f.kind);
    expect(kinds({ registered_address: "2 High Street, Lincoln", postcode: "LN1 9ZZ" }, 124)).toEqual(["shared"]);
    expect(addressFlags({ registered_address: "2 High Street, Lincoln" }, { shared: 124 })[0].text).toMatch(/^124 companies are registered at this postcode/);
    expect(kinds({ registered_address: "2 High Street, Lincoln" }, SENDOUT.sharedMin - 1)).toEqual([]);
    expect(kinds({ registered_address: "C/O Example Accountants LLP, 2 High Street, Lincoln" }, 0)).toEqual(["care_of"]);
    expect(kinds({ registered_address: "PO Box 123, Leeds" }, 0)).toEqual(["po_box"]);
    expect(kinds({}, 0)).toEqual(["none"]);
  });
});

describe("Names on the card", () => {
  it("cases a name filed in capitals and keeps one filed in mixed case", () => {
    expect(companyLabel("ACME TEXTILES LIMITED")).toBe("Acme Textiles Limited");
    expect(companyLabel("NORTHERN BRANDS (LICENSING) LIMITED")).toBe("Northern Brands (Licensing) Limited");
    expect(companyLabel("HILLSIDE PRODUCE PLC")).toBe("Hillside Produce PLC");
    expect(companyLabel("JW SMITH AND SONS LTD")).toBe("JW Smith and Sons Ltd");
    expect(companyLabel("Bright Games Ltd")).toBe("Bright Games Ltd");
  });
  it("names the team as people say it, deal vehicles dropped", () => {
    expect(teamName("ACME TEXTILES LIMITED")).toBe("Acme Textiles");
    expect(teamName("KESTREL GROUP LIMITED")).toBe("Kestrel");
    expect(teamName("FALCON TOPCO LTD")).toBe("Falcon");
  });
  it("fills the message, leaving a placeholder where no first name is typed", () => {
    expect(fillMessage(DEFAULT_MESSAGE, { first: "Sam", team: "Acme Textiles", owner: "Alex Smith" }))
      .toMatch(/^Dear Sam,\n\n.*the wider Acme Textiles team\.[\s\S]*Best wishes,\nAlex$/);
    expect(fillMessage(DEFAULT_MESSAGE, {})).toMatch(/^Dear \[First name\],/);
    expect(fillMessage("Hi {first_name} at {team}", { first: "Priya", team: "Hillside Dairy" })).toBe("Hi Priya at Hillside Dairy");
  });
  it("lays a row out as the Cedar sheet's twelve columns", () => {
    expect(CEDAR_COLUMNS.map(([, h]) => h)).toEqual(["Owner (Sales Person)", "Owners email address", "Owners telephone number", "First Name",
      "Last Name", "Company Name", "Address 1", "Address 2", "Postcode", "City", "Gift", "Message to be included"]);
    const row = cedarRow({ company_name: "RIVERSIDE TRADING LIMITED", registered_address: "Unit 9 Riverside Industrial Estate, Preston", postcode: "PR1 9ZZ" },
      { owner: "Alex", gift: "Biscuits", first: " Jo ", last: "Bloggs" });
    expect(row).toMatchObject({ owner: "Alex", first_name: "Jo", last_name: "Bloggs", company_name: "Riverside Trading Limited",
      address_1: "Unit 9 Riverside Industrial Estate", address_2: "", postcode: "PR1 9ZZ", city: "Preston", gift: "Biscuits" });
    expect(row.message).toMatch(/^Dear Jo,[\s\S]*wider Riverside Trading team/);
    expect(Object.keys(row)).toEqual(CEDAR_COLUMNS.map(([k]) => k));
    expect(cedarRow({ company_name: "X LTD" }, { message: "My own words" }).message).toBe("My own words");
  });
});

describe("Picking the week's 15", () => {
  const row = (n, extra = {}) => ({ company_number: n, company_name: `COMPANY ${n} LIMITED`, lead_score: 50, ...extra });
  const good = (...ns) => Object.fromEntries(ns.map((n, i) => [n, { verdict: "good", rating: 1, at: `2026-11-${10 + i}T10:00:00Z` }]));
  it("takes his good leads in the Top 20 order, skipping the contacted, the out and those already in a batch", () => {
    setKnownGroups({});
    const rows = ["01", "02", "03", "04", "05", "06"].map((n) => row(n));
    rows[4].qualified = "Out";
    const marks = { verdicts: { ...good("01", "02", "03", "04", "05"), "02": { verdict: "good", rating: 3, at: "2026-11-20T10:00:00Z" } }, checks: {}, lists: {} };
    const picked = sendoutPick(rows, marks, { contacted: { "03": {} }, batches: [{ week: "2026-11-18", companies: ["04"] }], n: 15 });
    expect(picked).toEqual(["02", "01"]);   // 02 rated ★★★ first; 03 contacted, 04 sent last week, 05 out, 06 not a good lead
  });
  it("stops at n, keeps one company a group, leaves out one already gifted from the Mail list, and keeps a swap's survivors first", () => {
    setKnownGroups({ "02": { top: "01", hops: 1 } });
    const rows = ["01", "02", "03", "04"].map((n) => row(n));
    const marks = { verdicts: good("01", "02", "03", "04"), checks: {}, lists: { "03": { list: "post", seq: { start: "2026-11-01", gift: "2026-11-01" } } } };
    // newest mark first among equals: 04, 03 (already gifted from the Mail list), 02, then 01 (02's group)
    expect(sendoutPick(rows, marks, { n: 15 })).toEqual(["04", "02"]);
    expect(sendoutPick(rows, marks, { n: 1 })).toEqual(["04"]);
    // a swap: 04 stays first, 02 (swapped out) isn't picked again, so its group's other company can come in
    expect(sendoutPick(rows, marks, { keep: ["04"], batches: [{ week: "2026-11-25", companies: ["04"], skipped: ["02"] }], n: 15 })).toEqual(["04", "01"]);
    setKnownGroups({});
  });
  it("knows every company ever in a batch, picked or swapped out", () => {
    expect([...inBatches([{ companies: ["01", "02"], skipped: ["03"] }, { companies: ["04"] }])]).toEqual(["01", "02", "03", "04"]);
  });
});
