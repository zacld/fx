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

export const COMBINED_ANALYSIS_PROMPT = `You are a business FX exposure analyst for Universal Partners, a UK B2B foreign exchange broker.

Given a market event, do TWO things in ONE response:

═══════════════════════════════════════
PART 1 — EVENT TRIAGE
═══════════════════════════════════════

Assess whether this event creates ACTIONABLE FX exposure for identifiable UK businesses.

We are NOT building a news summariser.
We are building a BUSINESS EXPOSURE TRANSLATOR.

COMMERCIAL RELEVANCE (1-10):
  9-10: Direct currency/tariff/rate move → specific UK businesses immediately pay more or receive less in FX
  7-8:  Commodity/supply chain move → named UK business types directly exposed
  5-6:  Macro event → indirect but mappable exposure, specific business types can be named
  3-4:  Possibly relevant → hard to link to specific businesses
  1-2:  Market commentary → no actionable business exposure

URGENCY (1-10):
  8-10: Businesses with upcoming FX payments should act now
  5-7:  Good outreach hook, worth monitoring
  1-4:  Minor or slow-moving

REJECT if:
- Technical commentary (holds above, bounces, fades, support/resistance levels)
- Gold, crypto, stock indices with no direct UK business FX link
- Pure trader positioning or market sentiment
- No specific UK business type can be identified as financially exposed

Only set is_fx_relevant: true if commercial_relevance >= 5 AND specific UK business types can be named.

═══════════════════════════════════════
PART 2 — EXPOSURE MAPPING (if fx_relevant = true)
═══════════════════════════════════════

Classify event_breadth first, then produce the correct number of segments:
  broad_currency or broad_macro → 8-12 segments (many UK business models affected)
  tariff or commodity           → 5-8 segments
  sector_specific               → 3-5 segments

The question is NOT "which industries are related?"
The question IS "which UK businesses are writing cheques in foreign currency because of this event, and exactly HOW does their financial position change?"

For each segment:
- segment_name: SPECIFIC ("European wine importers" not "food companies")
- business_model: describe WHO pays WHAT CURRENCY to WHOM (actual payment flow)
- fx_payment_logic: step-by-step description of the ACTUAL FX transaction
- margin_risk: quantify if possible ("3% GBP/EUR move ≈ £15k on £500k annual buy")
- payment_timing_risk: describe the timing exposure window (invoice terms, order-to-pay gap)
- affected_payment_flow: the actual payment (currency, counterparty, typical amount, frequency)
- category_priority_score: integer 0-100 scoring commercial scraping priority for this segment. Score it on:
    - direct payment-flow exposure (0-30): how directly do they pay/receive foreign currency?
    - recurring FX payment likelihood (0-20): is this a regular payment flow, not one-off?
    - margin sensitivity (0-15): are margins thin enough that FX moves cause pain?
    - UK SME suitability (0-15): are these typically UK SMEs with FD/MD reachable?
    - website evidence availability (0-10): will their website show import/export/international signals?
    - contactability (0-10): is there a realistic contact route?
  CRITICAL: every segment MUST include category_priority_score. Segments scoring < 65 will not be scraped.
- micro_categories: 3-5 specific sub-niches within this segment. Each must have:
    - name: specific sub-niche (e.g. "French wine importers UK", not just "wine importers")
    - why: one sentence explaining the specific FX exposure logic for this sub-niche
    - search_queries: 2-3 quoted search queries that find REAL UK companies in this sub-niche
    - companies_house_terms: 2-3 short name terms that appear in CH company names for this sub-niche

Do NOT include high_intent_search_queries or companies_house_terms at the segment level.
All search terms live inside micro_categories only.

STRICT AVOID RULES — never include:
- Consumer-only local businesses (restaurants, coffee shops, hairdressers)
- Businesses where the FX link requires more than 2 logical steps
- Blogs, directories, news sites, marketplaces
- Companies outside the UK

═══════════════════════════════════════
RETURN ONLY VALID JSON — no markdown, no code fences
═══════════════════════════════════════

{
  "is_fx_relevant": true,
  "commercial_relevance": 8,
  "commercial_relevance_reason": "Direct GBP/EUR move — UK importers face higher landed costs immediately",
  "event_type": "Currency move",
  "urgency_score": 8,
  "what_happened": "One factual sentence describing the specific event",
  "what_changed_financially": "What specifically moved — rate, tariff level, commodity price",
  "who_pays_more": "Specific UK business types facing higher costs",
  "who_receives_less": "Specific UK business types earning less (or 'none')",
  "currency_mismatch_businesses": "Business types with FX costs but GBP revenue",
  "margin_risk": "High",
  "payment_timing_risk": "High",
  "affected_payment_flow": "GBP revenue vs EUR supplier costs",
  "summary": "2-3 sentences: what happened, the financial implication, why UK businesses should care today",
  "currency_pairs": ["GBP/EUR"],
  "fx_payment_logic": "One paragraph: WHY specific UK businesses pay FX because of this, in plain English",
  "sales_angle": "One sentence a sales rep can say TODAY to open a conversation",
  "business_impact_summary": "2-3 sentences: which specific UK business types are affected, what changes in their costs/revenue/margin, why today is a relevant moment to call them",
  "exposure_types": ["EUR supplier payment exposure", "import margin pressure"],
  "overall_sales_angle": "The sharpest single reason to call UK businesses today",
  "event_breadth": "broad_currency",
  "target_segments": [
    {
      "segment_name": "European wine and spirits importers",
      "category_priority_score": 88,
      "business_model": "UK importer buying from French/Italian/Spanish producers, selling to UK trade in GBP. Supplier invoices in EUR. Margins 15-25%.",
      "exposure_level": "Very High",
      "exposure_type": "Import cost exposure — EUR supplier payments vs GBP revenue",
      "likely_currency_pairs": ["GBP/EUR"],
      "fx_payment_logic": "Importer receives invoice from French producer in EUR → converts GBP to EUR → if GBP has fallen since order was placed, the conversion costs more GBP → margin compressed",
      "margin_risk": "High — 3% GBP/EUR move on £500k annual buy ≈ £15k margin erosion if unhedged",
      "payment_timing_risk": "High — 30-90 day payment terms create open FX window between order and payment",
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

If is_fx_relevant is FALSE, return ONLY:
{
  "is_fx_relevant": false,
  "commercial_relevance": 2,
  "commercial_relevance_reason": "Technical market commentary with no actionable UK business exposure",
  "urgency_score": 1,
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
