"""
Structural mechanism table and niche generation.

These 6 mechanisms represent business models that CANNOT operate without
crossing a currency boundary. The model itself is the proof — no API call
is needed to validate mechanism strength (always "confirmed"). Competition
still needs checking separately, because a structurally confirmed niche
can still be crowded with FX broker marketing.

Adding a 7th mechanism should be rare: if it feels tempting, it's almost
certainly a contingent niche in disguise.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import List

from .schema import Niche, bucket_volume, derive_call_style


# ── The fixed structural table ──────────────────────────────────────────────

STRUCTURAL_TABLE = [
    {
        "mechanism": "overseas_equipment",
        "mechanism_display": "Overseas capital equipment purchasing",
        "niches": [
            {
                "niche": "UK food & beverage manufacturers",
                "effective_volume_raw": 280,
                "fx_direction": "pays_foreign",
                "evidence_source": (
                    "Italian and German processing lines (Tetra Pak, GEA, Bosch Packaging, "
                    "Alfa Laval) are industry-standard for UK food producers; documented in "
                    "Food Manufacture magazine and capital equipment tender notices on Contracts Finder"
                ),
                "payer_profile": "",
                "notes": (
                    "FX exposure at equipment order and on EUR-denominated maintenance/spares "
                    "contracts; recurring annual consumable spend compounds the one-off capex hit"
                ),
            },
            {
                "niche": "UK precision engineering & CNC machine shops",
                "effective_volume_raw": 170,
                "fx_direction": "pays_foreign",
                "evidence_source": (
                    "German and Japanese machine tool dominance (Mazak, DMG Mori, Trumpf, "
                    "Fanuc, Heidenhain) documented in UK Engineering and Machinery Market trade "
                    "press; MACH exhibition attendance records show near-universal German/Japanese "
                    "capital sourcing"
                ),
                "payer_profile": "",
                "notes": (
                    "High-value one-off purchases (£50k–£2m+); tooling, cutting inserts, and "
                    "spare parts often EUR/JPY-denominated on annual service contracts"
                ),
            },
            {
                "niche": "UK pharmaceutical contract manufacturers (CMOs)",
                "effective_volume_raw": 85,
                "fx_direction": "pays_foreign",
                "evidence_source": (
                    "European capital equipment (Bosch, Glatt, GEA, IMA, Fette Compacting) "
                    "standard in UK pharmaceutical CMOs per ABPI manufacturing surveys and "
                    "facility filings with the MHRA"
                ),
                "payer_profile": "",
                "notes": (
                    "Regulatory-grade equipment sourced from a narrow European supplier base; "
                    "validation costs and long-term spares contracts typically EUR-denominated"
                ),
            },
        ],
    },
    {
        "mechanism": "offshore_labour",
        "mechanism_display": "Offshore labour outsourcing",
        "niches": [
            {
                "niche": "UK software development agencies with offshore teams",
                "effective_volume_raw": 420,
                "fx_direction": "pays_foreign",
                "evidence_source": (
                    "UK tech trade press (TechNation reports, Clutch.co UK agency profiles, "
                    "CognitionX surveys) consistently document Indian and Eastern European "
                    "developer outsourcing as the primary cost-management route for UK software "
                    "agencies with 10-200 staff"
                ),
                "payer_profile": "",
                "notes": (
                    "Monthly payroll in INR, PLN, RON, or EUR; recurring high-volume FX exposure "
                    "that compounds with any GBP weakness — predictable and hedgeable"
                ),
            },
            {
                "niche": "UK business process outsourcing (BPO) firms",
                "effective_volume_raw": 120,
                "fx_direction": "pays_foreign",
                "evidence_source": (
                    "Everest Group and NelsonHall UK BPO market reports identify the Philippines "
                    "and India as dominant delivery locations; Capita, Teleperformance UK, and "
                    "Firstsource filings confirm large offshore payroll books"
                ),
                "payer_profile": "",
                "notes": (
                    "Large monthly payroll runs in PHP or INR; highly predictable recurring "
                    "exposure — ideal candidate for forward contract programmes"
                ),
            },
            {
                "niche": "UK digital marketing agencies with offshore content/dev",
                "effective_volume_raw": 350,
                "fx_direction": "pays_foreign",
                "evidence_source": (
                    "The Drum Agency Census and Econsultancy benchmarking surveys show majority "
                    "of mid-size UK agencies (20-150 staff) have contractor relationships in "
                    "Eastern Europe or South Asia for SEO content, dev, and design"
                ),
                "payer_profile": "",
                "notes": (
                    "Mix of contractor payments (EUR, PLN, INR) and platform costs; FX exposure "
                    "often unmanaged because per-contractor amounts feel small until aggregated "
                    "across a roster of 20+ freelancers"
                ),
            },
        ],
    },
    {
        "mechanism": "international_freight",
        "mechanism_display": "Direct international freight payment",
        "niches": [
            {
                "niche": "UK sea freight forwarders",
                "effective_volume_raw": 210,
                "fx_direction": "pays_foreign",
                "evidence_source": (
                    "BIFA (British International Freight Association) membership data and "
                    "freight forwarder financial filings confirm direct payments to overseas "
                    "port agents and ocean carriers; IATA and Drewry confirm ocean freight "
                    "is globally USD-priced regardless of voyage origin"
                ),
                "payer_profile": "",
                "notes": (
                    "USD freight costs billed per container; high volume and predictable flow "
                    "makes this ideal for systematic FX management — many small forwarders "
                    "still pay spot via their bank"
                ),
            },
            {
                "niche": "UK air cargo importers (direct consignees)",
                "effective_volume_raw": 95,
                "fx_direction": "pays_foreign",
                "evidence_source": (
                    "IATA rate cards are USD-denominated globally; UK importers who self-clear "
                    "air freight (pharma, electronics, perishables) pay directly in USD rather "
                    "than through a freight forwarder's bundled GBP invoice"
                ),
                "payer_profile": "",
                "notes": (
                    "Higher per-shipment FX values than sea freight; companies most likely to "
                    "self-manage air freight are in pharma, electronics, and high-value perishables"
                ),
            },
            {
                "niche": "UK perishable food importers",
                "effective_volume_raw": 160,
                "fx_direction": "pays_foreign",
                "evidence_source": (
                    "Fresh Produce Journal and Cold Chain Federation document UK importers of "
                    "fruit, vegetables, and fish paying directly for reefer containers and air "
                    "freight; time-sensitive perishable cargo means direct freight management "
                    "rather than freight forwarder bundling"
                ),
                "payer_profile": "",
                "notes": (
                    "Dual FX exposure: EUR/USD freight costs plus EUR/USD supplier payments; "
                    "seasonal purchase spikes (e.g. Spanish tomatoes, South American citrus) "
                    "create predictable hedging windows"
                ),
            },
        ],
    },
    {
        "mechanism": "us_platform_spend",
        "mechanism_display": "US-domiciled platform spend (AWS / Azure / GCP / Salesforce)",
        "niches": [
            {
                "niche": "UK SaaS companies with significant cloud infrastructure spend",
                "effective_volume_raw": 600,
                "fx_direction": "pays_foreign",
                "evidence_source": (
                    "AWS, GCP, and Azure bill UK customers in USD by default; confirmed via AWS "
                    "pricing documentation and widely discussed in UK tech communities (Hacker News "
                    "UK, SaaS Alliance forums). UK SaaS companies processing £1m+ ARR typically "
                    "carry £5k–£500k/month USD cloud bills"
                ),
                "payer_profile": "AWS / Azure / GCP (USD)",
                "notes": (
                    "Many finance directors assume GBP billing exists when it doesn't; the FX "
                    "cost sits hidden in the cloud invoice and goes unhedged — strong opening angle"
                ),
            },
            {
                "niche": "UK enterprise software resellers and VARs (Salesforce / Oracle / SAP)",
                "effective_volume_raw": 240,
                "fx_direction": "pays_foreign",
                "evidence_source": (
                    "Salesforce licenses are USD-denominated per Salesforce pricing documentation; "
                    "UK VARs purchase at USD wholesale prices, carrying the FX risk between their "
                    "USD cost and GBP customer billing. Oracle and SAP UK partner agreements "
                    "similarly USD-denominated at wholesale"
                ),
                "payer_profile": "Salesforce / Oracle / SAP (USD)",
                "notes": (
                    "Annual licence commitments in USD; VARs and resellers carry currency risk "
                    "between USD purchase and GBP customer invoice — often absorbed as margin "
                    "erosion rather than managed"
                ),
            },
            {
                "niche": "UK fintech and financial services firms with US platform dependencies",
                "effective_volume_raw": 380,
                "fx_direction": "pays_foreign",
                "evidence_source": (
                    "UK fintech reliance on US-based compliance, fraud, and data infrastructure "
                    "(AWS, Stripe, Twilio, Plaid, Sift, Sardine) documented in FCA sandbox "
                    "applications and Innovate Finance / Fintech Futures UK market surveys"
                ),
                "payer_profile": "AWS / Azure / GCP (USD)",
                "notes": (
                    "Layered USD exposure: cloud hosting + API usage costs + SaaS licensing; "
                    "grows faster than GBP revenue as product scales — acute for Series A-B fintechs"
                ),
            },
        ],
    },
    {
        "mechanism": "commodity_trading",
        "mechanism_display": "Globally-priced commodity trading",
        "niches": [
            {
                "niche": "UK metals stockists and distributors",
                "effective_volume_raw": 130,
                "fx_direction": "both",
                "evidence_source": (
                    "LME (London Metal Exchange) prices copper, aluminium, lead, zinc, nickel, "
                    "and tin in USD; UK metals stockholders confirmed as USD-exposed in Metals "
                    "Focus UK market reports and BMMA (British Metals Recycling Association) "
                    "industry documentation"
                ),
                "payer_profile": "",
                "notes": (
                    "Buy and sell prices reference USD LME benchmarks; a GBP/USD move directly "
                    "compresses or expands margin on every tonne traded — recurring, measurable, hedgeable"
                ),
            },
            {
                "niche": "UK energy brokers and independent power traders",
                "effective_volume_raw": 90,
                "fx_direction": "both",
                "evidence_source": (
                    "Brent crude and TTF gas benchmarks are USD-denominated; Ofgem and UK Energy "
                    "Networks Association documents confirm UK independent energy traders operate "
                    "against USD commodity benchmarks regardless of final delivery in GBP"
                ),
                "payer_profile": "",
                "notes": (
                    "Particularly exposed during volatility spikes; smaller independent traders "
                    "rarely have a treasury function — FX management is typically absent"
                ),
            },
            {
                "niche": "UK soft commodity traders (coffee, cocoa, grains)",
                "effective_volume_raw": 70,
                "fx_direction": "both",
                "evidence_source": (
                    "ICE and CBOT benchmarks for arabica/robusta coffee, cocoa, wheat, and soya "
                    "are USD-denominated; GAFTA (Grain and Feed Trade Association) standard "
                    "contracts specify USD settlement for members trading these commodities"
                ),
                "payer_profile": "",
                "notes": (
                    "Smaller niche but very high FX sensitivity per trade; good overlap with "
                    "specialty food importers who also carry EUR supplier exposure"
                ),
            },
        ],
    },
    {
        "mechanism": "cross_border_risk",
        "mechanism_display": "Cross-border risk writing and financing",
        "niches": [
            {
                "niche": "Lloyd's of London managing agents and syndicates",
                "effective_volume_raw": 55,
                "fx_direction": "both",
                "evidence_source": (
                    "Lloyd's Annual Report confirms majority of premium income and claims settled "
                    "in USD, EUR, and other foreign currencies; Lloyd's publishes multi-currency "
                    "financial statements confirming systematic FX exposure for all ~50 managing "
                    "agents and ~80 active syndicates"
                ),
                "payer_profile": "",
                "notes": (
                    "Sophisticated buyers but smaller syndicates and managing general agents "
                    "(MGAs) are often underserved by specialist FX advisory — procurement is "
                    "diffuse across multiple departments"
                ),
            },
            {
                "niche": "UK trade finance and export credit companies",
                "effective_volume_raw": 45,
                "fx_direction": "both",
                "evidence_source": (
                    "UK Export Finance (UKEF) annual report documents GBP-funded facilities "
                    "supporting foreign-currency trade; private trade finance companies (TFG, "
                    "Stenn, Tradewind, Bibby Financial) confirmed in FCA register as holding "
                    "foreign-currency-denominated receivables"
                ),
                "payer_profile": "",
                "notes": (
                    "Foreign-currency receivables and loan books create direct balance-sheet FX "
                    "exposure; larger ticket sizes than typical SME FX but relationship is often "
                    "with the FD rather than a dedicated treasury team"
                ),
            },
            {
                "niche": "UK captive insurance managers",
                "effective_volume_raw": 35,
                "fx_direction": "both",
                "evidence_source": (
                    "AIRMIC (Association of Insurance and Risk Managers) and Captive Review UK "
                    "document captive management firms administering multi-currency policy books "
                    "on behalf of multinational parent companies domiciled or operating across "
                    "currency zones"
                ),
                "payer_profile": "",
                "notes": (
                    "Small niche but high-value relationships; FX decisions typically made at "
                    "multinational parent level but the local UK captive manager is often the "
                    "gatekeeper and warm introduction route"
                ),
            },
        ],
    },
]


# ── Generation function ─────────────────────────────────────────────────────

def generate_structural_niches() -> List[Niche]:
    """
    Expand the structural table into a flat list of Niche objects.

    Competition fields are left blank — they're populated separately by
    competition.check_competition_batch(), which may or may not be called
    in the same run.
    """
    niches: List[Niche] = []
    for mechanism in STRUCTURAL_TABLE:
        for entry in mechanism["niches"]:
            raw_vol = entry["effective_volume_raw"]
            niches.append(
                Niche(
                    niche=entry["niche"],
                    branch="structural",
                    mechanism=mechanism["mechanism"],
                    mechanism_display=mechanism["mechanism_display"],
                    mechanism_strength="confirmed",
                    evidence_type="business_model",
                    evidence_source=entry["evidence_source"],
                    payer_profile=entry.get("payer_profile", ""),
                    competition="",
                    competition_checked_at="",
                    effective_volume_raw=raw_vol,
                    effective_volume_bucket=bucket_volume(raw_vol),
                    call_style=derive_call_style("confirmed"),
                    fx_direction=entry["fx_direction"],
                    notes=entry.get("notes", ""),
                )
            )
    return niches
