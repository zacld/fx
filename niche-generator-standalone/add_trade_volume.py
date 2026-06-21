"""
Adds trade_volume_gbp, trade_volume_source, trade_volume_confidence to niches_final.csv
Sources documented per row. Sorted by trade_volume_gbp descending (unverified rows at bottom).
"""
import csv, io

# ---------------------------------------------------------------------------
# Trade volume data keyed by EXACT sector_name from niches_final.csv
# Values: (trade_volume_gbp: int|None, trade_volume_source: str, confidence: str)
#
# Sources used:
#   - HMRC UK Trade in Food Feed and Drink 2024 (GOV.UK)            → hmrc_direct
#   - HMRC OTS via WSTA 2024 wine trade data                        → hmrc_direct (wine)
#   - UN COMTRADE / TrendEconomy HS-code lookups                    → ons_fallback
#   - IndexBox / Trading Economics citing COMTRADE 2024             → ons_fallback
#   - ONS UK trade with US 2024 (GOV.UK)                           → ons_fallback
#   - OEC World commodity profiles                                   → ons_fallback
#   - UKIE / Publishers Association / TDUK / Seafish industry data  → ons_fallback
# ---------------------------------------------------------------------------

TRADE_DATA: dict[str, tuple[int | None, str, str]] = {

    # ── Agriculture / Livestock ─────────────────────────────────────────────
    "Growing of grapes (SIC 1210)":
        (None, "", "volume_unverified"),
    "Growing of pome fruits and stone fruits (SIC 1240)":
        (None, "", "volume_unverified"),
    "Growing of other tree and bush fruits and nuts (SIC 1250)":
        (None, "", "volume_unverified"),
    "Plant propagation (SIC 1300)":
        (None, "", "volume_unverified"),
    "Raising of dairy cattle (SIC 1410)":
        (None, "", "volume_unverified"),
    "Raising of other cattle and buffaloes (SIC 1420)":
        (None, "", "volume_unverified"),
    "Raising of horses and other equines (SIC 1430)":
        (None, "", "volume_unverified"),

    # ── Food & Drink Manufacturing ───────────────────────────────────────────
    "Manufacture of prepared meals and dishes (SIC 10850)":
        (None, "", "volume_unverified"),
    "Manufacture of homogenized food preparations and dietetic food (SIC 10860)":
        (None, "", "volume_unverified"),
    # cocoa (HS 1801) 2023: $3.73bn → £3.0bn; coffee (HS 0901) 2023: ~£1.1bn; combined ~£4.0bn
    "Manufacture of other food products n.e.c. (SIC 10890)":
        (4000, "COMTRADE 2023: UK cocoa bean imports (HS 1801) $3.73bn → £3.0bn; coffee beans (HS 0901) ~£1.1bn; combined raw inputs £4.0bn", "ons_fallback"),
    "Manufacture of prepared feeds for farm animals (SIC 10910)":
        (None, "", "volume_unverified"),
    "Manufacture of prepared pet foods (SIC 10920)":
        (None, "", "volume_unverified"),
    # UK spirits imports (HS 2208): 2022 HMRC peak £988M; 2024 estimated ~£950M
    "Distilling, rectifying and blending of spirits (SIC 11010)":
        (950, "Statista citing HMRC OTS HS 2208 UK spirits/liqueurs imports: 2022 peak £988M; 2024 est £950M", "ons_fallback"),
    "Manufacture of wine from grape (SIC 11020)":
        (None, "", "volume_unverified"),
    # OEC World Hops (HS 1210) UK imports 2024: $72M → £56M at 1.279 USD/GBP
    "Manufacture of beer (SIC 11050)":
        (56, "OEC World / COMTRADE HS 1210 (hops) UK imports 2024: $72M → £56M at 1.279 GBP/USD", "ons_fallback"),

    # ── Paper & Packaging ────────────────────────────────────────────────────
    # UK paper+pulp+board imports: printing/writing paper alone $1.6bn (£1.25bn) + pulp + board ≈ £2.5bn
    "Manufacture of corrugated paper and paperboard, sacks and bags (SIC 17211)":
        (2500, "IndexBox: UK printing/writing paper imports 2024 $1.6bn → £1.25bn; total paper/pulp/board (HS 47-48) est £2.5bn", "ons_fallback"),
    "Manufacture of other paper and paperboard containers (SIC 17219)":
        (2500, "IndexBox: UK printing/writing paper imports 2024 $1.6bn → £1.25bn; total paper/pulp/board (HS 47-48) est £2.5bn", "ons_fallback"),
    "Manufacture of household and sanitary goods and of toilet requisites (SIC 17220)":
        (2500, "IndexBox: UK printing/writing paper imports 2024 $1.6bn → £1.25bn; total paper/pulp/board (HS 47-48) est £2.5bn", "ons_fallback"),
    "Printing of newspapers (SIC 18110)":
        (None, "", "volume_unverified"),
    "Reproduction of sound recording (SIC 18201)":
        (None, "", "volume_unverified"),

    # ── Petroleum & Chemicals ────────────────────────────────────────────────
    "Other treatment of petroleum products (excluding petrochemicals manufacture) (SIC 19209)":
        (None, "", "volume_unverified"),
    "Manufacture and processing of other glass, including technical glassware (SIC 23190)":
        (None, "", "volume_unverified"),
    "Manufacture of refractory products (SIC 23200)":
        (None, "", "volume_unverified"),

    # ── Metals ───────────────────────────────────────────────────────────────
    # Iron ore (HS 2601) 2023: $872M → £702M; coking coal (HS 2701) est £500M; combined £1.2bn
    "Manufacture of basic iron and steel and of ferro-alloys (SIC 24100)":
        (1200, "TrendEconomy COMTRADE HS 2601 UK iron ore imports 2023: $872M → £702M; coking coal (HS 2701) est £500M; combined £1.2bn", "ons_fallback"),
    # Gold (HS 7108) 2023: $48bn dominated by London through-trade; not a clean SME figure
    "Precious metals production (SIC 24410)":
        (None, "", "volume_unverified"),
    # COMTRADE 2024: UK aluminium imports 882,503 tonnes, $6.22bn → £4.86bn at 1.279 GBP/USD
    "Aluminium production (SIC 24420)":
        (4860, "UN COMTRADE 2024: UK aluminium imports (HS 7601) 882,503 tonnes, $6.22bn → £4.86bn at 1.279 GBP/USD", "ons_fallback"),
    "Manufacture of fasteners and screw machine products (SIC 25940)":
        (None, "", "volume_unverified"),

    # ── Electronics ──────────────────────────────────────────────────────────
    # IC imports (HS 8542): uktradeinfo.com Sep 2024 ~£126M/month → ~£1.5bn/year
    "Manufacture of electronic components (SIC 26110)":
        (1500, "uktradeinfo.com HS 8542 UK imports Sep 2024: £126M/month → annualised ~£1.5bn; semiconductor devices (HS 8541) additional", "ons_fallback"),
    "Manufacture of loaded electronic boards (SIC 26120)":
        (1500, "uktradeinfo.com HS 8542 UK imports Sep 2024: £126M/month → annualised ~£1.5bn; IC and component imports proxy", "ons_fallback"),
    # IndexBox citing HMRC: UK laptop+tablet imports 2024 $7.7bn → £6.02bn (HS 8471)
    "Manufacture of computers and peripheral equipment (SIC 26200)":
        (6020, "IndexBox citing HMRC: UK laptop and tablet computer imports 2024 $7.7bn → £6.02bn at 1.279 GBP/USD (HS 8471)", "ons_fallback"),
    "Manufacture of telegraph and telephone apparatus and equipment (SIC 26301)":
        (1500, "uktradeinfo.com HS 8542 UK imports Sep 2024: £126M/month → annualised ~£1.5bn; IC and sub-assembly imports proxy", "ons_fallback"),
    "Manufacture of communication equipment other than telegraph, and telephone apparatus and equipment (SIC 26309)":
        (1500, "uktradeinfo.com HS 8542 UK imports Sep 2024: £126M/month → annualised ~£1.5bn; electronic components proxy", "ons_fallback"),
    "Manufacture of consumer electronics (SIC 26400)":
        (1500, "uktradeinfo.com HS 8542 UK imports Sep 2024: £126M/month → annualised ~£1.5bn; components+displays+batteries broader market", "ons_fallback"),
    "Manufacture of taps and valves (SIC 28140)":
        (None, "", "volume_unverified"),

    # ── Wholesale / Agent Sectors ─────────────────────────────────────────────
    # UK total fuel imports 2024 ~£69.9bn: derived from ONS UK trade with US 2024 (US fuel £15.3bn = 21.9% of total)
    "Agents involved in the sale of fuels, ores, metals and industrial chemicals (SIC 46120)":
        (69900, "ONS UK trade with US 2024 (GOV.UK): US fuel imports £15.3bn = 21.9% of UK total → total UK fuel imports ~£69.9bn; metals additional", "ons_fallback"),
    "Agents involved in the sale of timber and building materials (SIC 46130)":
        (None, "", "volume_unverified"),
    # TrendEconomy HS ch.88 UK imports 2023: $15bn (aircraft $2.07bn + parts $11.9bn) → £12.1bn
    "Agents involved in the sale of machinery, industrial equipment, ships and aircraft (SIC 46140)":
        (12100, "TrendEconomy COMTRADE HS ch.88 UK aircraft+parts imports 2023: $15bn → £12.1bn at 1.243 GBP/USD (aircraft HS 8802: $2.07bn; parts HS 8807: $11.9bn)", "ons_fallback"),
    "Agents involved in the sale of textiles, clothing, fur, footwear and leather goods (SIC 46160)":
        (None, "", "volume_unverified"),
    # Same commodity pool as SIC 46370 coffee/tea/cocoa/spices £6bn
    "Agents involved in the sale of food, beverages and tobacco (SIC 46170)":
        (6000, "HMRC UK Trade in Food Feed and Drink 2024 (GOV.UK): coffee/tea/cocoa/spices imports £6.0bn; agents handle same commodity pool", "hmrc_direct"),
    "Wholesale of grain, unmanufactured tobacco, seeds and animal feeds (SIC 46210)":
        (None, "", "volume_unverified"),
    # HMRC UK Trade in Food Feed and Drink 2024: coffee/tea/cocoa/spices imports increased 13% to £6.0bn
    "Wholesale of coffee, tea, cocoa and spices (SIC 46370)":
        (6000, "HMRC UK Trade in Food Feed and Drink 2024 (GOV.UK): imports of coffee/tea/cocoa/spices +13% to £6.0bn in real terms in 2024", "hmrc_direct"),
    # Seafish 2024: UK seafood imports £3,839M; exotic fruits additional
    "Wholesale of other food, including fish, crustaceans and molluscs (SIC 46380)":
        (3839, "Seafish 2024 UK seafood trade data: total seafood imports £3,839M (+2%); exotic produce additional", "ons_fallback"),
    # Crude oil (HS 2709) 2023: $21bn = 4.04% of $791bn total UK imports (TrendEconomy COMTRADE)
    "Wholesale of petroleum and petroleum products (SIC 46711)":
        (16900, "TrendEconomy COMTRADE HS 2709 UK imports 2023: $21bn (4.04% of total $791bn) → £16.9bn at 1.243 GBP/USD", "ons_fallback"),
    "Wholesale of other fuels and related products (SIC 46719)":
        (None, "", "volume_unverified"),
    # Iron+steel (HS 72) 2024: $6.94bn → £5.4bn; aluminium (HS 76) 2024: $6.22bn → £4.86bn; combined £10.26bn
    "Wholesale of metals and metal ores (SIC 46720)":
        (10260, "Trading Economics: UK iron+steel imports 2024 $6.94bn → £5.4bn (HS ch.72); UN COMTRADE: aluminium 2024 $6.22bn → £4.86bn (HS ch.76); combined proxy £10.26bn", "ons_fallback"),
    "Wholesale of chemical products (SIC 46750)":
        (None, "", "volume_unverified"),
    "Wholesale of waste and scrap (SIC 46770)":
        (None, "", "volume_unverified"),

    # ── Retail / Services ────────────────────────────────────────────────────
    # IndexBox / COMTRADE HS 902140 UK hearing aid imports 2024: $263M → £206M at 1.279
    "Retail sale of hearing aids (SIC 47741)":
        (206, "IndexBox / UN COMTRADE HS 902140 UK hearing aid imports 2024: $263M → £206M at 1.279 GBP/USD", "ons_fallback"),
    "Retail sale in commercial art galleries (SIC 47781)":
        (None, "", "volume_unverified"),
    "Retail sale of antiques including antique books in stores (SIC 47791)":
        (None, "", "volume_unverified"),
    "Research and experimental development on biotechnology (SIC 72110)":
        (None, "", "volume_unverified"),
    "Other research and experimental development on natural sciences and engineering (SIC 72190)":
        (None, "", "volume_unverified"),
    "Renting and leasing of passenger water transport equipment (SIC 77341)":
        (None, "", "volume_unverified"),
    "Renting and leasing of freight water transport equipment (SIC 77342)":
        (None, "", "volume_unverified"),
    # TrendEconomy COMTRADE HS ch.88 UK aircraft+parts imports 2023: $15bn → £12.1bn
    "Renting and leasing of air passenger transport equipment (SIC 77351)":
        (12100, "TrendEconomy COMTRADE HS ch.88 UK aircraft+parts imports 2023: $15bn → £12.1bn at 1.243 GBP/USD (HS 8802 aircraft + HS 8807 parts)", "ons_fallback"),
    "Renting and leasing of freight air transport equipment (SIC 77352)":
        (12100, "TrendEconomy COMTRADE HS ch.88 UK aircraft+parts imports 2023: $15bn → £12.1bn at 1.243 GBP/USD (same dataset as passenger aircraft leasing)", "ons_fallback"),
    "Leasing of intellectual property and similar products, except copyright works (SIC 77400)":
        (None, "", "volume_unverified"),
    "Travel agency activities (SIC 79110)":
        (None, "", "volume_unverified"),
    "Other reservation service activities n.e.c. (SIC 79909)":
        (None, "", "volume_unverified"),
    "Activities of exhibition and fair organisers (SIC 82301)":
        (None, "", "volume_unverified"),
    "Activities of conference organisers (SIC 82302)":
        (None, "", "volume_unverified"),
    "Activities of collection agencies (SIC 82911)":
        (None, "", "volume_unverified"),
    "Other business support service activities n.e.c. security (SIC 82990)":
        (None, "", "volume_unverified"),
    "Support activities to performing arts (SIC 90020)":
        (None, "", "volume_unverified"),

    # ── Non-SIC rows (rows 65-73) ────────────────────────────────────────────
    # ADS: UK aerospace exports £20bn; aircraft+parts imports proxy £12.1bn (HS ch.88)
    "UK aerospace and defence equipment manufacturers":
        (12100, "TrendEconomy COMTRADE HS ch.88 UK aircraft+parts imports 2023: $15bn → £12.1bn; ADS Group: UK aerospace exports £20bn (2024 sector scale reference)", "ons_fallback"),
    "UK antiquarian and rare book dealers":
        (None, "", "volume_unverified"),
    # UKIE: UK video games consumer market 2024 £7.6bn; export receipts via global digital platforms USD/EUR denominated
    "UK video game publishers and developers":
        (6800, "UKIE: UK video games exports 2021 $8.8bn → £6.8bn; consumer market 2024 £7.6bn (most recent export figure is 2021)", "ons_fallback"),
    "UK specialty chemical manufacturers and importers":
        (None, "", "volume_unverified"),
    "UK optical lens and frame manufacturers":
        (None, "", "volume_unverified"),
    # ONS UK trade with US 2024: US fuel imports £15.3bn = 21.9% of UK total → total ~£69.9bn
    "UK fuel importers and oil product distributors":
        (69900, "ONS UK trade with US 2024 (GOV.UK): US fuel imports to UK £15.3bn = 21.9% of total UK fuel imports → total ~£69.9bn (crude+refined+products)", "ons_fallback"),
    # Publishers Association Annual Report 2024: total book exports £4.5bn; rights licensing £257M + coeditions £65M + secondary £23M = £345M
    "UK book publishers licensing international rights":
        (345, "Publishers Association Annual Report 2024: rights income £257M + coeditions £65M + secondary licensing £23M = £345M FX receipts; total book exports £4.5bn", "ons_fallback"),
    # TDUK: 2023 timber imports 7.3M m³; average price ~£246/m³ → ~£1.8bn
    "UK timber importers and merchants":
        (1800, "TDUK / Timber Trades Journal 2023: UK timber import volume ~7.3M m³ at average ~£246/m³ (softwood price) → est £1.8bn", "ons_fallback"),
    # HMRC OTS via WSTA/Vinetur: wine imports 2024 £3,910M; spirits (HS 2208) 2022 peak £988M est 2024 ~£850M
    "UK wine and spirits importers and wholesalers":
        (4760, "HMRC OTS via WSTA 2024: wine imports (HS 2204) £3,910M; spirits (HS 2208) 2022 HMRC peak £988M est 2024 ~£850M; combined ~£4.76bn", "hmrc_direct"),
}


def main() -> None:
    in_path  = "niches_final.csv"
    out_path = "niches_final.csv"          # overwrite in-place

    with open(in_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)

    # Attach trade volume fields
    for row in rows:
        name = row["sector_name"]
        if name not in TRADE_DATA:
            print(f"WARNING: no trade data entry for: {name!r}")
            row["trade_volume_gbp"]        = ""
            row["trade_volume_source"]     = ""
            row["trade_volume_confidence"] = "volume_unverified"
            continue
        vol, src, conf = TRADE_DATA[name]
        row["trade_volume_gbp"]        = str(vol) if vol is not None else ""
        row["trade_volume_source"]     = src
        row["trade_volume_confidence"] = conf

    # Sort: verified rows descending by trade_volume_gbp, then unverified
    def sort_key(r):
        v = r["trade_volume_gbp"]
        return (0, -int(v)) if v else (1, 0)

    rows.sort(key=sort_key)

    fieldnames = ["sector_name", "mechanism", "filter_reason",
                  "trade_volume_gbp", "trade_volume_source", "trade_volume_confidence"]

    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=fieldnames, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)

    with open(out_path, "w", encoding="utf-8", newline="") as f:
        f.write(buf.getvalue())

    verified = sum(1 for r in rows if r["trade_volume_gbp"])
    print(f"Written {len(rows)} rows ({verified} with trade volume, {len(rows)-verified} unverified) → {out_path}")


if __name__ == "__main__":
    main()
