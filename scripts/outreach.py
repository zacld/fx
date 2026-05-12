"""
FX Discovery — outreach.py
Generates event-led outreach drafts for each lead.
All messages are copy-ready — nothing is auto-sent.
"""

import os, json, logging
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

PROMPT = """You are writing outreach messages for Zac, a sales consultant at Universal Partners — a UK B2B foreign exchange broker.

Context:
- Company: {company_name}
- Industry/niche: {niche}
- Market event: {event_headline}
- Why they pay FX: {fx_payment_logic}
- FX exposure: {fx_pairs}
- Sales angle: {sales_angle}
- Director name (may be unknown): {director_name}

Write 4 short, punchy outreach messages. All should:
- Lead with the specific market event (not generic FX talk)
- Reference the company's specific exposure
- Be conversational, not corporate
- Soft CTA — no pressure
- Zac's sign-off: "Zac, Universal Partners"

Return ONLY valid JSON:
{{
  "linkedin_connection": "Short LinkedIn connection note (under 300 chars). Start with the event hook. No salesy language.",
  "linkedin_follow_up": "Follow-up message after they connect (2-3 short paragraphs). Event → their exposure → soft offer to chat.",
  "email_subject": "Short punchy subject line (under 50 chars)",
  "email_body": "Email body (3-4 short paragraphs). Event hook → their specific situation → UP value prop → CTA",
  "call_opener": "Phone opener (2-3 sentences). Event hook → question about their situation → natural bridge to UP"
}}

Use [Name] where the person's name would go.
Keep all messages SHORT. LinkedIn note max 300 chars. Email max 200 words."""

@retry(stop=stop_after_attempt(2), wait=wait_exponential(multiplier=1, min=2, max=8))
def generate_outreach(lead, event):
    director = lead.get("director_name") or "unknown"
    r = gemini.models.generate_content(
        model=GEMINI_MODEL,
        contents=PROMPT.format(
            company_name=lead.get("company_name","the company"),
            niche=lead.get("sector") or lead.get("niche",""),
            event_headline=event.get("headline",""),
            fx_payment_logic=event.get("fx_payment_logic",""),
            fx_pairs=", ".join(event.get("currency_pairs",[])),
            sales_angle=event.get("sales_angle",""),
            director_name=director,
        )
    )
    return extract_json(r.text)

def main():
    log.info("=== Outreach Generator ===")
    if not LEADS_FILE.exists():
        log.warning("No leads.json — run discover.py first")
        return

    events = json.loads(EVENTS_FILE.read_text()) if EVENTS_FILE.exists() else {}
    leads  = json.loads(LEADS_FILE.read_text())
    updated = 0

    for lid, lead in leads.items():
        if "outreach" in lead:
            continue
        event = events.get(lead.get("event_id",""), {})
        if not event:
            continue
        try:
            msgs = generate_outreach(lead, event)
            lead["outreach"] = msgs
            updated += 1
            log.info("  Generated outreach for %s", lead.get("company_name","?"))
        except Exception as exc:
            log.warning("  Failed %s: %s", lead.get("company_name","?"), exc)

    LEADS_FILE.write_text(json.dumps(leads, indent=2))
    log.info("=== Done: %d leads with outreach drafts ===", updated)

if __name__ == "__main__":
    main()
