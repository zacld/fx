/**
 * sources/ai.ts — Brain 1 + Brain 2: one LLM call per event (triage + exposure
 * map). COMBINED_ANALYSIS_PROMPT is the prompt from scripts/ingest.py, verbatim —
 * Brain 1/2 *logic* is unchanged in v2; only the provider changed.
 *
 * Default provider: Groq (OpenAI-compatible chat completions, fast Llama
 * inference). AI_PROVIDER=gemini switches to Google. Both via direct REST — no SDK
 * dep. Throws on failure (RateLimitError on 429) so the caller (the `analyse`
 * stage) can fall back to the rule-based buildFallbackEvent. Fetch impl injectable
 * for tests; with no API key it throws.
 *
 * Credentials live in env / .env (gitignored) or CI secrets — never in code:
 *   GROQ_API_KEY  (+ optional GROQ_MODEL, default llama-3.3-70b-versatile)
 *   GEMINI_API_KEY (+ optional GEMINI_MODEL, default gemini-2.0-flash)
 *   AI_PROVIDER = groq | gemini   (default groq)
 */

export const COMBINED_ANALYSIS_PROMPT = `You are Brain 1 — the FX trigger analyst for Universal Partners, a UK B2B foreign exchange broker.

Your job is NOT to summarise news. Your job is to translate ONE market event into:
  (a) a tiered trigger judgement,
  (b) the affected payment flow,
  (c) the specific UK businesses likely to feel it,
  (d) a credible reason to call today,
  (e) a recommendation on how much discovery effort this event deserves.

═══════════════════════════════════════
HOW TO THINK
═══════════════════════════════════════

Reason in this order — every time:

  1. What moved? (currency / rate / tariff / commodity / supply chain / geopolitical)
  2. Which currency or payment flow is affected? (GBP/EUR, GBP/USD, USD-priced commodity, freight cost, etc.)
  3. Who actually feels the financial impact? (specific UK business types writing cheques in foreign currency, or receiving overseas revenue)
  4. Is there a credible reason to call TODAY? (upcoming invoice, margin compression, fresh hook)
  5. Can Brain 3 likely prove the exposure from public website evidence? (import/export language, supplier countries, freight, multi-currency, etc.)
  6. How much discovery effort does this event deserve?

Reason from the SPECIFIC event. Do NOT default to the same niches every time.

The standard: could a sales rep explain the reason for the call in ONE sentence?
  GOOD: "GBP/EUR has moved, so businesses paying European suppliers may have higher upcoming invoice costs."
  BAD:  "You are an international business, so maybe FX matters."

═══════════════════════════════════════
TIERED TRIGGER SYSTEM
═══════════════════════════════════════

Pick ONE trigger_strength. Be conservative with hard rejection — if something might be useful, prefer medium or weak over reject.

STRONG (trigger_score 75-100, discovery_mode = "full")
  Worth a full discovery run. Examples:
  - sharp GBP/EUR or GBP/USD move
  - BoE / Fed / ECB surprise (or surprise hawkish/dovish tilt)
  - inflation or rate shock that visibly moves currency
  - tariff announcement affecting UK trade
  - oil / fuel / shipping / commodity shock
  - trade disruption affecting import/export flows
  - geopolitical event creating currency / payment pressure
  Strong needs: clear payment flow + identifiable UK business types + plausible website evidence.

MEDIUM (trigger_score 45-74, discovery_mode = "limited")
  Plausible FX relevance, lower urgency. Worth some discovery but not a full run. Examples:
  - sector news with a possible payment-flow angle
  - exporter / revenue-conversion stories
  - commodity / freight stories with second-order impact
  - smaller currency moves
  - useful but not worth a full discovery run

WEAK (trigger_score 20-44, discovery_mode = "context_only")
  Market context only — keep for messaging / follow-up colour, but DO NOT generate new leads from it.
  - macro context, indirect FX hooks
  - background that supports outreach but isn't a fresh reason to call

REJECT (trigger_score 0-19, discovery_mode = "reject")
  Only reject when there is genuinely no UK B2B FX hook. Examples:
  - no UK business angle
  - no FX / payment-flow relevance
  - purely consumer article
  - vague stock / earnings / news story with no payment flow
  - pure trader positioning or technical commentary
  - gold / crypto / stock indices with no UK business FX link

If you're unsure between two tiers, pick the LOWER-effort tier (e.g. medium not strong, weak not medium). It is better to under-spend discovery on a borderline event than to waste a full run on a weak one.

═══════════════════════════════════════
DISCOVERY EFFORT GUIDANCE
═══════════════════════════════════════

Recommend a query budget — total search queries Brain 3 should burn on this event:
  full          → 25-40 queries, 5-10 segments, 3-5 micro-categories each
  limited       → 8-15 queries, 2-4 segments, 1-3 micro-categories each
  context_only  → 0 queries, 0-2 segments (kept only as messaging context)
  reject        → 0 queries, 0 segments

The recommended_query_budget is the BUDGET, not a guarantee.

═══════════════════════════════════════
WHO TO TARGET
═══════════════════════════════════════

Always reason from the specific event. Targets must be UK businesses with identifiable foreign-currency payment flow.

AVOID defaulting to weak / generic niches unless the event genuinely justifies them:
  - generic SaaS / software vendors
  - marketing agencies
  - professional services firms
  - vague "international companies"
  - tourism / hospitality (unless payment flow is concrete — e.g. inbound currency conversion)
  - huge PLCs / global giants (not our buyer)
  - trade associations as leads
  - consumer-only retailers

SaaS / software is ONLY a target when the event explicitly relates to:
  - USD cloud / software costs
  - multi-currency pricing for UK SaaS
  - international subscription revenue
  - cross-border SaaS billing
  - visible EU / US customer exposure for a UK software company

STRICT AVOID for segments — never include:
  - consumer-only local businesses (restaurants, coffee shops, hairdressers)
  - businesses where the FX link requires more than 2 logical steps
  - blogs, directories, news sites, marketplaces
  - companies outside the UK

═══════════════════════════════════════
SEGMENTS (only when discovery_mode is "full" or "limited")
═══════════════════════════════════════

For full discovery, produce the right number of segments for the event_breadth:
  broad_currency / broad_macro → 5-10 segments
  tariff / commodity           → 4-7 segments
  sector_specific              → 3-5 segments
For limited discovery, produce 2-4 tightly-targeted segments only.
For context_only / reject, target_segments = [].

For each segment:
  - segment_name: SPECIFIC ("European wine importers UK" not "food companies")
  - business_model: WHO pays WHAT CURRENCY to WHOM (the actual payment flow)
  - fx_payment_logic: step-by-step description of the ACTUAL FX transaction
  - margin_risk: quantify if possible ("3% GBP/EUR move ≈ £15k on £500k annual buy")
  - payment_timing_risk: the timing exposure window (invoice terms, order-to-pay gap)
  - affected_payment_flow: actual payment (currency, counterparty, typical amount, frequency)
  - category_priority_score: integer 0-100. Scoring rubric:
      - direct payment-flow exposure (0-30)
      - recurring FX payment likelihood (0-20)
      - margin sensitivity (0-15)
      - UK SME suitability (0-15)
      - website evidence availability (0-10)
      - contactability (0-10)
    CRITICAL: every segment MUST include category_priority_score. Segments scoring < 65 will not be scraped.
  - micro_categories: 2-5 specific sub-niches. Each must have:
      - name: specific sub-niche (e.g. "French wine importers UK", not "wine importers")
      - why: one sentence on the specific FX exposure logic for this sub-niche
      - search_queries: 2-3 quoted search queries that find REAL UK companies
      - companies_house_terms: 2-3 short name terms that appear in CH company names

Do NOT include high_intent_search_queries or companies_house_terms at the segment level.
All search terms live inside micro_categories only.

═══════════════════════════════════════
RETURN ONLY VALID JSON — no markdown, no code fences
═══════════════════════════════════════

Required output shape (use this when trigger_strength is strong / medium / weak):
{
  "trigger_strength": "strong",
  "trigger_score": 84,
  "urgency_score": 8,
  "discovery_mode": "full",
  "recommended_query_budget": 30,
  "is_fx_relevant": true,
  "commercial_relevance": 8,
  "commercial_relevance_reason": "Direct GBP/EUR move — UK importers face higher landed costs immediately",
  "confidence_level": "high",
  "confidence_reason": "Currency move is explicit and the affected payment flow (GBP→EUR supplier invoices) is concrete",
  "event_type": "Currency move",
  "event_breadth": "broad_currency",
  "currency_pairs": ["GBP/EUR"],
  "what_happened": "One factual sentence describing the specific event",
  "what_changed_financially": "What specifically moved — rate, tariff level, commodity price",
  "who_pays_more": "Specific UK business types facing higher costs",
  "who_receives_less": "Specific UK business types earning less (or 'none')",
  "margin_risk": "High",
  "payment_timing_risk": "High",
  "affected_payment_flow": "GBP revenue vs EUR supplier costs",
  "likely_affected_businesses": ["UK European-wine importers", "UK Italian-food importers", "UK furniture importers from EU"],
  "why_now": "Upcoming EUR supplier invoices placed before the move now cost more in GBP",
  "discovery_recommendation": "Full run — clear payment flow, multiple identifiable importer niches, public websites should show import language",
  "summary": "2-3 sentences: what happened, the financial implication, why UK businesses should care today",
  "fx_payment_logic": "One paragraph: WHY specific UK businesses pay FX because of this, in plain English",
  "sales_angle": "One sentence a sales rep can say TODAY to open a conversation",
  "business_impact_summary": "2-3 sentences: which specific UK business types are affected, what changes in costs/revenue/margin, why today is the moment to call",
  "exposure_types": ["EUR supplier payment exposure", "import margin pressure"],
  "overall_sales_angle": "The sharpest single reason to call UK businesses today",
  "target_segments": [
    {
      "segment_name": "European wine and spirits importers",
      "category_priority_score": 88,
      "business_model": "UK importer buying from French/Italian/Spanish producers, selling to UK trade in GBP. Supplier invoices in EUR. Margins 15-25%.",
      "exposure_level": "Very High",
      "exposure_type": "Import cost exposure — EUR supplier payments vs GBP revenue",
      "likely_currency_pairs": ["GBP/EUR"],
      "fx_payment_logic": "Importer receives invoice from French producer in EUR → converts GBP to EUR → weaker GBP since order date → more GBP needed → margin compressed",
      "margin_risk": "High — 3% GBP/EUR move on £500k annual buy ≈ £15k margin erosion if unhedged",
      "payment_timing_risk": "High — 30-90 day terms create open FX window between order and payment",
      "affected_payment_flow": "EUR payments to European producers, typically £50k-£500k per shipment, quarterly",
      "website_validation_signals": ["imported from", "direct from the producer", "European vineyards", "exclusive importer", "sourced from"],
      "avoid_segments": ["retail wine shops without own import operations", "supermarkets", "pub chains"],
      "sales_angle": "Upcoming EUR wine payments now cost more in GBP than when orders were placed.",
      "exposure_thesis_template": "This company imports wine/spirits from European producers. GBP/EUR move increases GBP cost of upcoming EUR supplier invoices.",
      "micro_categories": [
        {
          "name": "French wine importers UK",
          "why": "Pay EUR to French producers, sell GBP to UK trade — margin directly hit by GBP/EUR fall",
          "search_queries": ["\\"french wine importer\\" UK", "\\"bordeaux importer\\" UK", "french wine distributor UK wholesale"],
          "companies_house_terms": ["french wine", "bordeaux wines", "wine france"]
        },
        {
          "name": "Italian wine and food importers UK",
          "why": "EUR-invoiced Italian suppliers with GBP-only UK revenue creates direct currency mismatch",
          "search_queries": ["\\"italian wine importer\\" UK", "\\"italian food importer\\" UK", "italian deli wholesale UK"],
          "companies_house_terms": ["italian wine", "vino import", "italian foods"]
        }
      ]
    }
  ]
}

For weak triggers, return the same shape but with discovery_mode = "context_only", recommended_query_budget = 0, and target_segments = [] (or 1-2 thin segments kept ONLY as messaging context).

For reject, return ONLY:
{
  "trigger_strength": "reject",
  "trigger_score": 8,
  "urgency_score": 1,
  "discovery_mode": "reject",
  "recommended_query_budget": 0,
  "is_fx_relevant": false,
  "commercial_relevance": 1,
  "commercial_relevance_reason": "Why this event has no UK B2B FX hook",
  "confidence_level": "high",
  "confidence_reason": "Why you are confident this should be rejected",
  "event_type": "",
  "likely_affected_businesses": [],
  "why_now": "",
  "discovery_recommendation": "Reject — no payment-flow hook",
  "target_segments": []
}

Headline: __HEADLINE__
Summary: __SUMMARY__`;

export function formatPrompt(headline: string, summary: string): string {
  return COMBINED_ANALYSIS_PROMPT.replace("__HEADLINE__", headline ?? "").replace("__SUMMARY__", summary ?? "");
}

/** Strip ```json fences and return the {...} object substring, parsed. */
export function extractJson<T = Record<string, unknown>>(text: string): T {
  const t = (text ?? "").trim().replace(/```json/gi, "").replace(/```/g, "").trim();
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s === -1 || e === -1 || e <= s) throw new Error("no JSON object found in model output");
  return JSON.parse(t.slice(s, e + 1)) as T;
}

export class RateLimitError extends Error {}

export type AiProvider = "groq" | "gemini";
export interface AiOptions { provider?: AiProvider; apiKey?: string; model?: string; fetchImpl?: typeof fetch; timeoutMs?: number; }
export type AnalyseFn = (headline: string, summary: string) => Promise<Record<string, unknown>>;

const _isRateLimited = (status: number, body: string) => status === 429 || /quota|rate.?limit|resource_exhausted|too many requests/i.test(body);

/** Groq — OpenAI-compatible chat/completions with JSON mode. Default provider. */
export async function analyseViaGroq(headline: string, summary: string, opts: AiOptions = {}): Promise<Record<string, unknown>> {
  const apiKey = opts.apiKey ?? process.env.GROQ_API_KEY ?? "";
  const model = opts.model ?? process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";
  if (!apiKey) throw new Error("no GROQ_API_KEY");
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, temperature: 0.3, response_format: { type: "json_object" }, messages: [{ role: "user", content: formatPrompt(headline, summary) }] }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
  } catch (e) {
    throw new Error(`Groq request failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (_isRateLimited(res.status, body)) throw new RateLimitError(`Groq ${res.status}: ${body.slice(0, 200)}`);
    throw new Error(`Groq ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = json.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error("Groq returned no content");
  return extractJson(text);
}

/** Gemini — generativelanguage.googleapis.com generateContent. Alternative provider. */
export async function analyseViaGemini(headline: string, summary: string, opts: AiOptions = {}): Promise<Record<string, unknown>> {
  const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY ?? "";
  const model = opts.model ?? process.env.GEMINI_MODEL ?? "gemini-2.0-flash";
  if (!apiKey) throw new Error("no GEMINI_API_KEY");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: formatPrompt(headline, summary) }] }] }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
  } catch (e) {
    throw new Error(`Gemini request failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (_isRateLimited(res.status, body)) throw new RateLimitError(`Gemini ${res.status}: ${body.slice(0, 200)}`);
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text) throw new Error("Gemini returned no text");
  return extractJson(text);
}

/** One LLM call for an event — dispatches to the configured provider (Groq by default). */
export async function analyseEvent(headline: string, summary: string, opts: AiOptions = {}): Promise<Record<string, unknown>> {
  const provider: AiProvider = opts.provider ?? (process.env.AI_PROVIDER as AiProvider) ?? "groq";
  return provider === "gemini" ? analyseViaGemini(headline, summary, opts) : analyseViaGroq(headline, summary, opts);
}
