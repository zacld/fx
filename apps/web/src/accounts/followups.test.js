import { describe, expect, it } from "vitest";
import { applyContact, followUp, followUpLine, invalidChange, sortFollowUps, touchesOf } from "./followups.js";

const at = (day) => `${day}T12:00:00.000Z`;   // midday UTC: the same calendar day in UK time
const now = new Date(at("2026-10-28"));

describe("follow-ups", () => {
  it("logs touches, responses and a chosen date; undo removes the company", () => {
    let marks = applyContact({}, "01", { contacted: true, channel: "phone" }, at("2026-10-20"));
    marks = applyContact(marks, "01", { contacted: true, channel: "email" }, at("2026-10-23"));
    expect(touchesOf(marks["01"]).map((t) => t.channel)).toEqual(["phone", "email"]);
    expect(marks["01"].at).toBe(at("2026-10-20"));                                  // first contact kept
    marks = applyContact(marks, "01", { follow_up_at: "2026-11-02" });
    expect(marks["01"].follow_up_at).toBe("2026-11-02");
    marks = applyContact(marks, "01", { contacted: true, channel: "linkedin" }, at("2026-10-28"));
    expect(marks["01"].follow_up_at).toBeUndefined();                               // a new touch resets the date
    marks = applyContact(marks, "01", { response: "replied" }, at("2026-10-28"));
    expect(marks["01"].response).toBe("replied");
    expect(applyContact(marks, "02", { response: "booked" })).toEqual(marks);       // not contacted: nothing changes
    expect(applyContact(marks, "01", { contacted: false })).toEqual({});
    expect(touchesOf({ at: at("2026-10-01") })).toEqual([{ at: at("2026-10-01"), channel: "" }]);   // older marks
  });

  it("refuses bad changes", () => {
    expect(invalidChange({ contacted: true, channel: "phone" })).toBe("");
    expect(invalidChange({ channel: "fax" })).toMatch(/channel/);
    expect(invalidChange({ response: "maybe" })).toMatch(/response/);
    expect(invalidChange({ follow_up_at: "next week" })).toMatch(/YYYY-MM-DD/);
    expect(invalidChange({ contacted: "yes" })).toMatch(/contacted/);
  });

  it("suggests the next touch 2, 4 then 7 days on, then nurture; replies and meetings stop it", () => {
    const one = { at: at("2026-10-26"), touches: [{ at: at("2026-10-26"), channel: "phone" }] };
    expect(followUp(one, {}, now)).toMatchObject({ state: "due", nextDay: "2026-10-28", inDays: 0, action: "Email follow-up", touches: 1 });
    const older = { at: at("2026-10-20"), touches: [{ at: at("2026-10-20"), channel: "email" }] };
    expect(followUp(older, {}, now)).toMatchObject({ state: "overdue", nextDay: "2026-10-22", inDays: -6, action: "Call the office" });
    const two = { ...one, touches: [...one.touches, { at: at("2026-10-27"), channel: "email" }] };
    expect(followUp(two, {}, now)).toMatchObject({ state: "upcoming", nextDay: "2026-10-31", inDays: 3 });
    const three = { ...two, touches: [...two.touches, { at: at("2026-10-28"), channel: "phone" }] };
    expect(followUp(three, {}, now)).toMatchObject({ nextDay: "2026-11-04", action: "Last try — a short break-up note, then nurture" });
    const four = { ...three, touches: [...three.touches, { at: at("2026-10-28"), channel: "email" }] };
    expect(followUp(four, {}, now)).toMatchObject({ state: "nurture", nextDay: "2027-01-26" });
    expect(followUp({ ...one, follow_up_at: "2026-11-10" }, {}, now)).toMatchObject({ state: "upcoming", nextDay: "2026-11-10" });
    expect(followUp({ ...one, response: "replied", response_at: at("2026-10-27") }, {}, now)).toMatchObject({ state: "replied" });
    expect(followUp({ ...one, response: "booked" }, {}, now)).toMatchObject({ state: "booked", nextDay: "", line: "" });
    expect(followUp({ ...one, response: "not_interested" }, {}, now).state).toBe("closed");
    expect(followUp(undefined, {}, now)).toBe(null);
  });

  it("writes the follow-up line from the company's own facts", () => {
    const r = { main_currency: "USD", fact_1: "FX loss of £151k on the latest accounts.", lead_director: "Sam Roe" };
    expect(followUpLine(r, 1)).toBe("Just following up — with sterling still moving, upcoming USD supplier payments could be worth a quick review (FX loss of £151k on the latest accounts). Would a 10-minute call this week work?");
    expect(followUpLine({ fact_1: "New charge to HSBC" }, 1)).toMatch(/\(new charge to HSBC\)/);
    expect(followUpLine(r, 2)).toMatch(/quick comparison on a recent USD payment/);
    expect(followUpLine(r, 3)).toBe("Not sure if you're the right person for this — would USD supplier payments normally sit with finance or with Sam Roe?");
    expect(followUpLine({}, 4)).toMatch(/overseas supplier payments come up/);
    expect(followUpLine({ currency_pairs: "GBP/EUR|GBP/USD" }, 3)).toMatch(/EUR supplier payments/);
  });

  it("lists overdue first, then due, replied, upcoming (soonest first), nurture, booked, closed", () => {
    const m = (day, extra = {}) => ({ at: at(day), touches: [{ at: at(day), channel: "phone" }], ...extra });
    const marks = { a: m("2026-10-27"), b: m("2026-10-20"), c: m("2026-10-26"), d: m("2026-10-25", { response: "booked" }),
                    e: m("2026-10-28", { response: "replied", response_at: at("2026-10-28") }) };
    const rows = ["a", "b", "c", "d", "e"].map((company_number, i) => ({ company_number, rank: i + 1 }));
    expect(sortFollowUps(rows, marks, now).map((r) => r.company_number)).toEqual(["b", "c", "e", "a", "d"]);
  });
});
