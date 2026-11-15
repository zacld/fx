// The desk's emails that worked (Zac, 15 Nov 2026), as templates for the outreach sequence's email steps. Filled from
// the company's own records only — first name (a presented finance contact), the company's name, its turnover growth,
// its currency and how far the pound has moved against it (the market page's ECB rates) — and what the records can't
// support stays a [placeholder]. Names in the originals (prospects, colleagues) are not kept. Nothing is sent.

import { firstName, naturalCompany } from "./email.js";
import { ownCurrency } from "./format.js";

const SIGN = "Best wishes,\nZac";

export const TEMPLATES = {
  choc1: { name: "Chocolates 1 — they've landed", text: (v) => `Hi ${v.first},

Hopefully, the chocolates I sent to the office arrived? I like the idea of making a good first impression, and I thought some treats to share with the team would be a step in the right direction.

Having had a look into ${v.company}, I wanted to reach out as I was hoping for the opportunity to introduce you to Investec Bank and explain how we are of relevance as a specialist bank, and find out a bit more about your company further to what the accounts show me.

Do you have any availability over the coming weeks for a quick call?

Best regards,
Zac` },
  choc2: { name: "Chocolates 2 — why I reached out", text: (v) => `Hi ${v.first},

I hope the chocolates arrived at your desk?

I just wanted to add a bit of context on why I reached out. At Investec, we work alongside banks such as HSBC and Barclays, supporting growing businesses with areas like FX risk management, deposits, lending and broader corporate finance matters.

Given the business's profile, I thought it could be worthwhile introducing ourselves and learning a little more about your priorities for the year ahead.

If helpful, would you be open to a quick 10–15 minute call over the coming weeks?

${SIGN}` },
  generic: { name: "Generic first email — what we do", text: (v) => `Hi ${v.first},

I hope you are well.

I'm reaching out from Investec Bank to briefly introduce what we do and explore whether it might be relevant for ${v.company}.

We work alongside major banks like HSBC and Barclays, providing strategic support that mid-corporates often don't receive on the transactional side. Our offering covers:

• Treasury: FX risk management, deposits, fund finance, commodities, global payments
• Lending: asset finance, invoice discounting, growth & acquisition finance
• Corporate Finance: support with acquisitions, PE investment, IPOs and trade sales

I'd love the chance to introduce Investec and learn more about your business.

Are you free next week for a quick call?

${SIGN}` },
  fxdesk: { name: "Proactive FX risk management", text: (v) => `Hi ${v.first},

I hope you have had a good start to your week.

One area I thought could be of interest is our FX risk management desk. Investec operate with the agility of a broker, offering a dedicated dealer and competitive pricing, but with the added balance sheet strength and security of a FTSE 100-listed bank.

Unlike larger banks, where FX can often be more transactional, we take a far more proactive approach, getting under the bonnet of your cash flows and helping design tailored hedging strategies to mitigate risk.

Being a nimble 'corporate specialised' bank, I can also make easy introductions to other teams such as working capital.

Free over the next couple of weeks for a quick call?

${SIGN}` },
  personal: { name: "Personalised FX — from their accounts", text: (v) => `Morning ${v.first},

I've had a look at ${v.company}'s accounts in Companies House and can see the business has ${v.growth ? `a growing exposure to currency risk, which I can imagine is becoming more prevalent as revenue continues to scale (${v.growth})` : "a real exposure to currency risk"}.

Most banks treat FX as a side offering, which often means slow, reactive service. At Investec, each client has a dedicated dealer, and none of us look after more than around 100 clients. That allows us to offer genuinely proactive, hands-on support. Many businesses in a similar position have found real value in that, especially given the volatility ${v.swing}.

Investec also offers very flexible working capital solutions and high-yielding money market accounts.

I've kept this brief, but I'd love the opportunity to introduce Investec Treasury properly and, more importantly, understand your objectives from an FX risk perspective.

Would you be open to a call over the coming weeks?

${SIGN}` },
};

// Which template each email step starts with: the gift route (Mail list) and the cold route (Email / Call lists).
// Steps not listed have no template yet (case study, money, Investec, break-up) — Zac picks one or writes his own.
export const STEP_TEMPLATES = {
  post: { 1: "choc1", 3: "choc2", 5: "generic", 8: "fxdesk", 12: "personal" },
  cold: { 1: "generic", 3: "personal", 8: "fxdesk" },
};
export const stepTemplate = (which, step) => STEP_TEMPLATES[which === "post" ? "post" : "cold"][step] || "";

// The pieces a template fills, each with where it came from; a missing piece is a [placeholder].
export function templateValues(r = {}, moves = {}) {
  const first = firstName(r);
  const company = naturalCompany(r.company_name || "");
  const g = parseFloat(String(r.turnover_growth || "").replace(/[+%]/g, ""));
  const cur = ownCurrency(r);
  const m = cur && moves[cur];
  const window = m && (m["3m"] !== undefined ? ["3m", "3 months"] : m["1m"] !== undefined ? ["1m", "month"] : null);
  const swing = window ? `${window[0] === "3m" ? "over recent months" : "over the last month"} (GBP/${cur} has moved ${Math.abs(m[window[0]]).toFixed(1)}% over the past ${window[1]})`
    : "over the last year ([GBP/currency] has moved [x]% over the past [period])";
  return {
    first: first || "[First name]", company: company || "[Company]", growth: g > 0 ? `+${g}% on last year` : "", swing,
    sources: [first ? "first name: the finance contact on the list" : "first name: not confirmed — fill in",
      g > 0 ? `growth: turnover ${r.turnover_growth} in the accounts` : "growth: none shown — sentence without it",
      window ? `currency move: GBP/${cur} on the ECB rates (market page)` : "currency move: no own currency in the records — fill in"],
  };
}

export function fillTemplate(key, r, moves) {
  const t = TEMPLATES[key];
  if (!t) return null;
  const v = templateValues(r, moves);
  return { name: t.name, text: t.text(v), sources: v.sources };
}
