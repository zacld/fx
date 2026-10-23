import { describe, expect, it } from "vitest";
import { affected, describeMove, effectOn, eventsFor, impactLine, mainWindow, pct } from "./moves.js";

const eur = { code: "EUR", name: "euro", symbol: "€", changes: { "1d": -1.1, "1m": -2.3, "3m": -3.4 },
              since: { "1m": "2026-09-21", "3m": "2026-07-23" }, impact_per_million: { "1m": 20000, "3m": 30080 },
              material: ["1m", "3m"] };
const usdUp = { code: "USD", name: "US dollar", symbol: "$", changes: { "1m": 2.0 }, since: { "1m": "2026-09-21" },
                impact_per_million: { "1m": -15000 }, material: ["1m"] };

describe("market moves", () => {
  it("describes the pound's move and what it does per 1m", () => {
    expect(mainWindow(eur)).toBe("1m");
    expect(describeMove(eur)).toBe("The pound has fallen 2.3% against the euro over the last month");
    expect(impactLine(eur)).toBe("Every €1m of purchases now costs £20,000 more than on 21 Sept");
    expect([pct(-0.04), pct(-2.31), pct(1.5)]).toEqual(["0.0%", "−2.3%", "+1.5%"]);
  });

  it("lands on importers and exporters the right way round", () => {
    const importer = effectOn({ currency_direction: "Buys (importer)" }, eur);
    expect(importer.hurt).toBe(true);
    expect(importer.line).toBe("The pound has fallen 2.3% against the euro over the last month — as a euro buyer, "
      + "every €1m of purchases now costs £20,000 more than on 21 Sept.");
    expect(effectOn({ currency_direction: "Sells (exporter)" }, eur).hurt).toBe(false);   // weaker pound helps exporters
    const exporter = effectOn({ currency_direction: "Sells (exporter)" }, usdUp);
    expect(exporter.hurt).toBe(true);
    expect(exporter.line).toContain("every $1m of sales now brings in £15,000 less");
    expect(effectOn({ currency_direction: "Unknown" }, eur)).toBe(null);
  });

  it("matches accounts, skips qualified-out, hurt first", () => {
    const accounts = [
      { rank: 1, main_currency: "EUR", currency_direction: "Sells (exporter)" },
      { rank: 2, main_currency: "EUR", currency_direction: "Buys (importer)" },
      { rank: 3, main_currency: "EUR", currency_direction: "Buys (importer)", qualified: "Out" },
      { rank: 4, main_currency: "USD", currency_direction: "Buys (importer)" },
    ];
    expect(affected(accounts, eur).map((x) => x.account.rank)).toEqual([2, 1]);
  });

  it("finds recent events that explain the move", () => {
    const events = [
      { detected_at: "2026-10-21T09:00:00Z", currency_pairs: ["GBP/EUR"], trigger_strength: "medium", headline: "CPI" },
      { detected_at: "2026-10-21T08:00:00Z", currency_pairs: ["GBP/USD"], trigger_strength: "strong", headline: "Oil" },
      { detected_at: "2026-10-01T08:00:00Z", currency_pairs: ["EUR/GBP"], trigger_strength: "strong", headline: "Old" },
      { detected_at: "2026-10-20T08:00:00Z", currency_pairs: ["EUR/GBP"], trigger_strength: "weak", headline: "Weak" },
    ];
    const now = Date.parse("2026-10-22T08:00:00Z");
    expect(eventsFor(events, "EUR", "2026-10-21", 7, ["strong", "medium"], now).map((e) => e.headline)).toEqual(["CPI"]);
    // Monday 06:07 run: the last fixing is Friday, but weekend and Monday-morning events still count
    const monday = [{ detected_at: "2026-10-26T06:00:00Z", currency_pairs: ["GBP/EUR"], trigger_strength: "strong", headline: "Mon" }];
    expect(eventsFor(monday, "EUR", "2026-10-23", 7, ["strong"], Date.parse("2026-10-26T06:07:00Z")).map((e) => e.headline))
      .toEqual(["Mon"]);
  });
});
