"""
FX Discovery — outreach.py
Generates message ingredients for each lead — not hardcoded templates.

Philosophy:
  Zac writes his own messages in his own tone.
  This script provides sharp, specific ingredients so he can write quickly:
    - what happened (event hook)
    - why it matters to THIS company
    - the likely payment/currency exposure
    - the commercial pain point
    - a suggested angle
    - one good opening question
    - a soft CTA
    - optional LinkedIn note starter
    - optional call opener

The goal is message AMMO, not a rigid script.
Nothing is auto-sent. Everything is copy-ready context.
"""

import os, json, logging, time
from pathlib import Path
from google import genai
from dotenv import load_dotenv
from tenacity import retry, stop_after_attempt, wait_exponential

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s")
log = logging.getLogger(__name__)

GEMINI_API_KEY = os.environ["GEMINI_API_KEY"]
GEMINI_MODEL   = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")

DATA_DIR    = Path(__file__).parent.parent / "data"
EVENTS_FILE = DATA_DIR / "events.json"
LEADS_FILE  = DATA_DIR / "leads.json"

gemini = genai.Client(api_key=GEMINI_API_KEY)

def extract_json(text):
    text = text.strip().replace("```json","").replace("```","").strip()
    s, e = text.find("{"), text.rfind("}")
    if s == -1 or e == -1: raise ValueError("No JSON")
    return json.loads(text[s:e+1])

INGREDIENTS_PROMPT = """You are helping Zac, a sales consultant at Universal Partners (UK B2B FX broker), prepare to reach out to a prospect.

Your job is NOT to write a full outreach message. Zac writes his own messages in his own voice.
Your job is to give him sharp, specific ingredients — context and angles he can use to write naturally.

Lead details:
  Company: {company_name}
  Director: {director_name}
  Segment: {segment_name}
  Business model: {business_model}
  Website signals: {fx_signals}
  Why they pay FX: {fx_payment_logic}
  FX exposure: {fx_pairs}

Trigger event:
  Headline: {event_headline}
  Summary: {event_summary}
  Why this affects them: {why_affected}
  Sales angle: {sales_angle}

Generate message ingredients. Be specific to this company and this event. Avoid:
- Generic "we provide FX services" language
- Sounding like financial advice or making market predictions
- Overclaiming or scare tactics
- Robotic template language
- Anything longer than it needs to be

Return ONLY valid JSON:
{{
  "event_hook": "1-2 conversational sentences referencing the specific market event. Something Zac could actually say naturally. E.g. 'Did you see GBP/EUR moving lower this week? Market positioning suggests sterling could stay under pressure.'",

  "why_it_matters": "1-2 sentences explaining why this event is relevant to THIS specific company's payment flows. Be concrete — reference their segment and payment direction.",

  "likely_exposure": "One line describing the likely currency/payment flow. E.g. 'GBP revenue / EUR supplier invoices' or 'USD-priced stock / GBP revenue'.",

  "pain_point": "The specific commercial pain this creates. E.g. 'Upcoming EUR supplier payments will cost more GBP than when orders were placed.' Keep it short and real.",

  "sales_angle": "The angle Zac should take — what to ask about or offer. Should feel like good sales advice, not a pitch. E.g. 'Ask whether they have upcoming EUR payments and whether those are being actively managed or just going through the bank at the rate of the day.'",

  "opening_question": "One specific, natural question to open with that invites them to share their situation. Should NOT feel like a sales pitch. E.g. 'Do you currently handle your EUR payments through your bank, or do you use a specialist?'",

  "soft_cta": "A low-pressure close — 2-3 options Zac can choose from based on context. E.g. 'Worth a quick call?' / 'Happy to share what we're seeing on GBP/EUR if useful.' / 'Let me know if timing is relevant — no obligation.'",

  "linkedin_note": "A natural 1-2 sentence LinkedIn connection note starter (NOT a full message — just the opening Zac can personalise). Under 200 chars. Reference the event and their sector. Use [Name] where appropriate.",

  "call_opener": "A natural 2-sentence phone opener. Event hook → bridge to their situation. Use [Name]. Should sound like a real call, not a script. E.g. 'Hi [Name], it's Zac from Universal Partners — I saw GBP/EUR has been moving lower and noticed [Company] works with European suppliers. Do you currently have any upcoming EUR payments, or is that handled through finance?'"
}}"""

@retry(stop=stop_after_attempt(5), wait=wait_exponential(multiplier=2, min=10, max=90))
def generate_ingredients(lead: dict, event: dict) -> dict:
    # Find the matching segment for this lead
    segment_name  = lead.get("segment_name", "")
    business_model = ""
    why_affected   = ""
    sales_angle    = ""
    for seg in event.get("target_segments", []):
        if seg.get("segment_name","").lower() in segment_name.lower() or segment_name.lower() in seg.get("segment_name","").lower():
            business_model = seg.get("business_model","")
            why_affected   = seg.get("why_financially_exposed") or seg.get("why_affected","")
            sales_angle    = seg.get("sales_angle","")
            break
    if not business_model:
        business_model = lead.get("fx_payment_logic","") or ""

    fx_signals = ", ".join((lead.get("fx_payment_signals") or [])[:5]) or "none found"
    fx_pairs   = ", ".join(event.get("currency_pairs") or
                           [seg.get("likely_currency_pairs",[""])[0]
                            for seg in event.get("target_segments",[]) if seg.get("likely_currency_pairs")][:2]) or "GBP/EUR"

    r = gemini.models.generate_content(
        model=GEMINI_MODEL,
        contents=INGREDIENTS_PROMPT.format(
            company_name   = lead.get("company_name","the company"),
            director_name  = lead.get("director_name","unknown"),
            segment_name   = segment_name,
            business_model = business_model[:300],
            fx_signals     = fx_signals,
            fx_payment_logic = lead.get("fx_payment_logic","")[:200] or business_model[:200],
            fx_pairs       = fx_pairs,
            event_headline = event.get("headline",""),
            event_summary  = (event.get("business_impact_summary") or event.get("summary",""))[:300],
            why_affected   = why_affected[:300] or event.get("overall_sales_angle","")[:200],
            sales_angle    = sales_angle[:200] or event.get("overall_sales_angle","")[:200],
        )
    )
    return extract_json(r.text)

def main():
    log.info("=== Message Ingredients Generator ===")
    if not LEADS_FILE.exists():
        log.warning("No leads.json — run discover.py first")
        return

    events = json.loads(EVENTS_FILE.read_text()) if EVENTS_FILE.exists() else {}
    leads  = json.loads(LEADS_FILE.read_text())
    updated = 0

    # Process top-scoring leads first; limit to avoid exhausting quota
    MAX_TO_GENERATE = int(os.getenv("OUTREACH_MAX_LEADS", "20"))
    sorted_leads = sorted(leads.items(), key=lambda x: -x[1].get("score",0))

    for lid, lead in sorted_leads:
        if updated >= MAX_TO_GENERATE:
            break
        # Skip leads that already have fresh ingredients
        if lead.get("message_ingredients"):
            continue
        # Only generate for HOT/WARM leads with evidence
        if lead.get("priority") not in ("HOT","WARM"):
            continue

        event = events.get(lead.get("event_id",""), {})
        if not event:
            # Try linked events
            for eid in lead.get("linked_event_ids", []):
                event = events.get(eid, {})
                if event:
                    break
        if not event:
            continue

        try:
            ingredients = generate_ingredients(lead, event)
            lead["message_ingredients"] = ingredients
            # Keep legacy outreach field name as alias for backward compat
            lead["outreach"] = {
                "call_opener":          ingredients.get("call_opener",""),
                "linkedin_connection":  ingredients.get("linkedin_note",""),
                "linkedin_follow_up":   "",
                "email_subject":        "",
                "email_body":           "",
            }
            updated += 1
            log.info("  Ingredients for %s", lead.get("company_name","?"))
            time.sleep(2)   # pace Gemini calls — free tier rate limit
        except Exception as exc:
            log.warning("  Failed %s: %s", lead.get("company_name","?"), exc)
            time.sleep(5)   # back off on failure

    LEADS_FILE.write_text(json.dumps(leads, indent=2))

    # Sync to public/data/
    public = Path(__file__).parent.parent / "public" / "data"
    public.mkdir(parents=True, exist_ok=True)
    (public / "leads.json").write_text(LEADS_FILE.read_text())

    log.info("=== Done: %d leads with message ingredients ===", updated)

if __name__ == "__main__":
    main()
