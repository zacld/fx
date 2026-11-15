// What we can pitch them (Zac, 15 Nov 2026: "say they have £5m in the bank — we could offer them a money market account
// with better interest … do that with all of our offerings"). Investec UK's corporate products, as its public website
// describes them (investec.com/en_gb, read 15 Nov 2026 — `PRODUCTS[].source`), each matched to the company's own filed
// facts by a rule. Every pitch says which fact triggers it. No rates or prices are quoted (they change; confirm them on
// the desk), nothing from the bank's own records is used, and no AI: the rules below are the whole of it.

import { industryOf, money, parseMoney, peBackedOf } from "./format.js";

const SITE = "https://www.investec.com/en_gb";
export const PRODUCTS = {
  deposits: { name: "Corporate deposits — notice, fixed-term, instant access", group: "Cash",
    what: "Notice accounts (32 / 65 / 95 days), fixed-term deposits and instant access, in GBP, USD and EUR, built for companies with £5m+ on deposit",
    source: `${SITE}/corporate-banking/cash-management.html` },
  currencyDeposits: { name: "USD / EUR deposit accounts", group: "Cash",
    what: "Corporate deposit accounts in US dollars and euros — earn on foreign-currency balances instead of converting them",
    source: `${SITE}/corporate-banking/cash-management.html` },
  fxForwards: { name: "FX spot and forwards", group: "Treasury & risk",
    what: "Spot and forward contracts to fix the rate on future payments and receipts",
    source: `${SITE}/business/popular-solutions/treasury-and-risk-management.html` },
  fxOptions: { name: "FX options and structured hedging", group: "Treasury & risk",
    what: "Options and structured hedges — protection against a bad move while keeping some upside",
    source: `${SITE}/business/popular-solutions/treasury-and-risk-management.html` },
  rateHedging: { name: "Interest rate hedging", group: "Treasury & risk",
    what: "Swaps, caps and collars that fix or cap the interest on bank debt",
    source: `${SITE}/business/popular-solutions/treasury-and-risk-management.html` },
  commodityHedging: { name: "Commodity hedging", group: "Treasury & risk",
    what: "Hedges on the commodities priced into their costs (metals, energy, soft commodities)",
    source: `${SITE}/business/popular-solutions/treasury-and-risk-management.html` },
  workingCapital: { name: "Working capital — invoice finance, asset-based lending, RCF", group: "Lending",
    what: "Invoice finance, asset-based lending and revolving credit to fund stock and debtors as they grow",
    source: `${SITE}/business/solutions/lending.html` },
  refinance: { name: "Refinancing — term loans and revolving credit", group: "Lending",
    what: "Term loans and revolving credit facilities — a competing offer when their facility comes up for renewal",
    source: `${SITE}/business/solutions/lending.html` },
  acquisitionFinance: { name: "Acquisition and leveraged finance", group: "Lending",
    what: "Leveraged and acquisition finance for buy-and-build, buyouts and refinancing a sponsor's debt",
    source: `${SITE}/business/solutions/lending.html` },
  growthFinance: { name: "Growth finance", group: "Lending",
    what: "Growth capital and cash-flow lending for expansion, at home or abroad",
    source: `${SITE}/business/solutions/lending.html` },
  assetFinance: { name: "Asset finance", group: "Lending",
    what: "Finance for plant, machinery, vehicles and equipment",
    source: `${SITE}/business/solutions/lending.html` },
  fxDebt: { name: "Borrowing matched to its currency", group: "Lending",
    what: "Debt in the currency they earn in, or a cross-currency hedge on what they already borrow",
    source: `${SITE}/business/popular-solutions/treasury-and-risk-management.html` },
};

export const PITCH_RULES = { depositsMin: 5e6, depositsSmallMin: 2e6, rateDebtMin: 5e6, bigLoss: 100e3, growthMin: 20 };

const COMMODITY = /metal|steel|alumin|copper|fuel|oil|gas|energy|coffee|cocoa|sugar|grain|soya|cereal|nut|timber|plastic|chemical|scrap|bullion|gold/i;
const ASSETS = /^Manufacturing|Transport, logistics|Construction|Farming|Mining|Energy, water|Business support & rental/;
const num = (v) => { const n = parseMoney(v); return Number.isFinite(n) ? n : NaN; };
const currencyOf = (r) => r.main_currency || r.currency || "";

// [{key, name, group, what, why, source}] — strongest first (the order of the rules), each with the fact that triggers it.
export function pitchFor(r = {}) {
  const out = [];
  const add = (key, why) => { if (!out.some((p) => p.key === key)) out.push({ key, ...PRODUCTS[key], why }); };
  const cash = num(r.cash_gbp);
  const debt = num(r.bank_borrowings_gbp);
  const loss = -Number(r.fx_gain_loss_gbp) || 0;
  const growth = parseFloat(String(r.turnover_growth || "").replace("+", ""));
  const cur = currencyOf(r);
  const hedged = /forward|option|hedg|natural/i.test(`${r.fx_today || ""} ${r.fx_forwards || ""}`);
  const niche = `${r.fx_niche || ""} ${industryOf(r)}`;

  if (cash >= PITCH_RULES.depositsMin) {
    add("deposits", `${money(cash)} cash at the year end — ask what it earns where it sits now; a notice or fixed-term deposit usually pays more than a current account`);
  } else if (cash >= PITCH_RULES.depositsSmallMin) {
    add("deposits", `${money(cash)} cash at the year end — below the £5m these accounts are built for, but worth asking how much sits idle through the year`);
  }
  if (r.fx_balances || /USD|EUR|dollar|euro/i.test(r.reporting_currency || "")) {
    add("currencyDeposits", r.fx_balances ? `Holds foreign currency: ${r.fx_balances}` : `Keeps its accounts in ${r.reporting_currency} — its income arrives in that currency`);
  }
  if (cur || r.currencies_in_accounts) {
    const what = cur ? `${cur}` : r.currencies_in_accounts;
    add("fxForwards", r.fx_forwards
      ? `Already uses forwards (${r.fx_forwards}) — quote against the incumbent on the next one`
      : hedged ? `Hedges ${what} today (${r.fx_today}) — offer a competing quote`
      : `Trades in ${what} with no hedging named in its accounts — fix the rate on the next payments`);
  }
  if (loss >= PITCH_RULES.bigLoss || r.fx_sensitivity) {
    add("fxOptions", loss >= PITCH_RULES.bigLoss
      ? `An FX loss of ${money(loss)} — options cap the downside without giving up a good move`
      : `Its accounts show what a currency move costs: ${r.fx_sensitivity}`);
  }
  if (debt >= PITCH_RULES.rateDebtMin || r.bank_debt) {
    add("rateHedging", debt >= PITCH_RULES.rateDebtMin ? `${money(debt)} of bank borrowing — is the rate fixed or capped?` : `Bank borrowing: ${r.bank_debt}`);
  }
  if (r.fx_borrowings) add("fxDebt", `Borrows in another currency: ${r.fx_borrowings}`);
  if (COMMODITY.test(niche)) add("commodityHedging", `${r.fx_niche || industryOf(r)} — commodity prices sit in its costs`);
  const backed = peBackedOf(r);
  if (r.acquisitions || r.lead_flags?.buying) add("acquisitionFinance", `Buying companies${r.acquisitions ? `: ${r.acquisitions}` : ""} — fund the next one`);
  else if (backed) add("acquisitionFinance", `PE-backed (${backed.name}) — sponsors refinance and fund bolt-ons; their lenders usually require a hedging policy`);
  if (r.facility_ends || /renew|refinanc|matur/i.test(r.triggers || "") || r.lead_flags?.moment?.startsWith?.("Bank switch")) {
    add("refinance", r.facility_ends ? `Facility ends ${r.facility_ends}${r.incumbent_bank ? ` (with ${r.incumbent_bank})` : ""} — be in the room before it renews`
      : `Its lending is changing: ${r.triggers || r.lead_flags.moment}`);
  }
  if (growth >= PITCH_RULES.growthMin) {
    add("workingCapital", `Turnover up ${growth}% — growth ties up cash in stock and debtors`);
    if (r.subsidiaries_abroad || /abroad|overseas/i.test(r.lead_reasons || "")) add("growthFinance", `Growing ${r.subsidiaries_abroad ? `with subsidiaries abroad (${r.subsidiaries_abroad})` : "abroad"}`);
  }
  if (ASSETS.test(industryOf(r))) add("assetFinance", `${industryOf(r)} — plant, vehicles or equipment to finance`);
  return out;
}

// "Deposits · FX forwards · Rate hedging" for a card or an export.
export const pitchLine = (r) => pitchFor(r).map((p) => p.name.split(" — ")[0]).join(" · ");
