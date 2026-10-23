"""
Adds trade_volume_gbp, trade_volume_source, trade_volume_confidence to niches_final.csv
Sources documented per row. Sorted by trade_volume_gbp descending (unverified rows at bottom).

Confidence tiers:
  hmrc_direct          — direct HMRC OTS publication or GOV.UK HMRC statistical release
  ons_or_industry_body — ONS publication, GOV.UK government statistics, or recognised
                         UK industry body (UKIE, Publishers Association, TDUK, Seafish,
                         uktradeinfo.com which is HMRC's own data portal)
  trade_data_aggregator — third-party aggregators relaying COMTRADE: TrendEconomy,
                          IndexBox, Trading Economics, OEC World, Statista, Grand View
                          Research; or UN COMTRADE accessed indirectly
  volume_unverified    — no citable figure found; structural FX exposure confirmed but
                         trade volume not quantifiable to acceptable accuracy

FX conversion rates (all rows using USD→GBP):
  Bank of England annual average 2023: £1 = $1.243
  Bank of England annual average 2024: £1 = $1.279

SHARED FLOW caveat: where multiple SIC rows draw on the same underlying commodity pool
or dataset, the figure is repeated for comparability but the rows are non-additive.
Adding them together would double- (or multi-) count the same trade flow.
"""
import csv, io

# ---------------------------------------------------------------------------
# Trade volume data keyed by EXACT sector_name from niches_final.csv
# Values: (trade_volume_gbp: int|None, trade_volume_source: str, confidence: str)
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
    # UK bovine semen imports 2023 (HS 0511 sub-code): $33.8M → £27M
    "Raising of dairy cattle (SIC 1410)":
        (27,
         "COMTRADE 2023 via Grand View Research: UK bovine semen imports $33.8M → £27M; UK 3rd largest importer globally; Bank of England annual average 2023: £1=$1.243",
         "trade_data_aggregator"),
    # Same bovine semen/embryo import commodity as SIC 1410; SHARED FLOW — non-additive
    "Raising of other cattle and buffaloes (SIC 1420)":
        (27,
         "COMTRADE 2023 via Grand View Research: UK bovine semen imports $33.8M → £27M; SHARED FLOW with SIC 1410 dairy cattle (same commodity pool); Bank of England annual average 2023: £1=$1.243",
         "trade_data_aggregator"),
    "Raising of horses and other equines (SIC 1430)":
        (None, "", "volume_unverified"),

    # ── Food & Drink Manufacturing ───────────────────────────────────────────
    "Manufacture of prepared meals and dishes (SIC 10850)":
        (None, "", "volume_unverified"),
    "Manufacture of homogenized food preparations and dietetic food (SIC 10860)":
        (None, "", "volume_unverified"),
    # cocoa beans (HS 1801) 2023: $3.73bn → £3.0bn; coffee beans (HS 0901) ~£1.1bn; combined ~£4.0bn
    "Manufacture of other food products n.e.c. (SIC 10890)":
        (4000,
         "COMTRADE 2023: UK cocoa bean imports (HS 1801) $3.73bn → £3.0bn; coffee beans (HS 0901) ~£1.1bn; combined raw inputs £4.0bn; Bank of England annual average 2023: £1=$1.243",
         "trade_data_aggregator"),
    "Manufacture of prepared feeds for farm animals (SIC 10910)":
        (None, "", "volume_unverified"),
    "Manufacture of prepared pet foods (SIC 10920)":
        (None, "", "volume_unverified"),
    # UK spirits/liqueurs imports (HS 2208): 2022 HMRC peak £988M; 2024 est ~£950M
    "Distilling, rectifying and blending of spirits (SIC 11010)":
        (950,
         "Statista citing HMRC OTS HS 2208 UK spirits/liqueurs imports: 2022 peak £988M; 2024 est £950M",
         "trade_data_aggregator"),
    "Manufacture of wine from grape (SIC 11020)":
        (None, "", "volume_unverified"),
    # OEC World / COMTRADE Hops (HS 1210) UK imports 2024: $72M → £56M
    "Manufacture of beer (SIC 11050)":
        (56,
         "OEC World / COMTRADE HS 1210 (hops) UK imports 2024: $72M → £56M; Bank of England annual average 2024: £1=$1.279",
         "trade_data_aggregator"),

    # ── Paper & Packaging ────────────────────────────────────────────────────
    # UK paper+pulp+board imports: printing/writing paper alone $1.6bn (£1.25bn) + pulp + board ≈ £2.5bn
    # SHARED FLOW: SIC 17211, SIC 17219, SIC 17220 all draw on same paper/pulp commodity pool — non-additive
    "Manufacture of corrugated paper and paperboard, sacks and bags (SIC 17211)":
        (2500,
         "IndexBox: UK printing/writing paper imports 2024 $1.6bn → £1.25bn; total paper/pulp/board (HS 47-48) est £2.5bn; Bank of England annual average 2024: £1=$1.279; SHARED FLOW: SIC 17211, SIC 17219, SIC 17220 draw on same paper/pulp commodity pool; non-additive",
         "trade_data_aggregator"),
    "Manufacture of other paper and paperboard containers (SIC 17219)":
        (2500,
         "IndexBox: UK printing/writing paper imports 2024 $1.6bn → £1.25bn; total paper/pulp/board (HS 47-48) est £2.5bn; Bank of England annual average 2024: £1=$1.279; SHARED FLOW: SIC 17211, SIC 17219, SIC 17220 draw on same paper/pulp commodity pool; non-additive",
         "trade_data_aggregator"),
    "Manufacture of household and sanitary goods and of toilet requisites (SIC 17220)":
        (2500,
         "IndexBox: UK printing/writing paper imports 2024 $1.6bn → £1.25bn; total paper/pulp/board (HS 47-48) est £2.5bn; Bank of England annual average 2024: £1=$1.279; SHARED FLOW: SIC 17211, SIC 17219, SIC 17220 draw on same paper/pulp commodity pool; non-additive",
         "trade_data_aggregator"),
    # Newsprint (HS 4801) UK imports 2023: $271M → £218M
    "Printing of newspapers (SIC 18110)":
        (218,
         "IndexBox / OEC World COMTRADE HS 4801 (newsprint) UK imports 2023: $271M → £218M; Bank of England annual average 2023: £1=$1.243",
         "trade_data_aggregator"),
    # Polycarbonate granules (HS 3907 sub-code) UK imports 2024: 61K tonnes × $2,908/tonne = $177M → £138M
    "Reproduction of sound recording (SIC 18201)":
        (138,
         "IndexBox: UK polycarbonate (HS 3907) imports 2024: 61K tonnes at avg $2,908/tonne = $177M → £138M; Bank of England annual average 2024: £1=$1.279",
         "trade_data_aggregator"),

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
        (1200,
         "TrendEconomy COMTRADE HS 2601 UK iron ore imports 2023: $872M → £702M; coking coal (HS 2701) est £500M; combined £1.2bn; Bank of England annual average 2023: £1=$1.243",
         "trade_data_aggregator"),
    # Gold (HS 7108) 2023: $48bn dominated by London through-trade — not a clean SME input figure
    "Precious metals production (SIC 24410)":
        (None, "", "volume_unverified"),
    # COMTRADE 2024: UK aluminium imports (HS 7601) 882,503 tonnes, $6.22bn → £4.86bn
    "Aluminium production (SIC 24420)":
        (4860,
         "UN COMTRADE 2024: UK aluminium imports (HS 7601) 882,503 tonnes, $6.22bn → £4.86bn; Bank of England annual average 2024: £1=$1.279",
         "trade_data_aggregator"),
    "Manufacture of fasteners and screw machine products (SIC 25940)":
        (None, "", "volume_unverified"),

    # ── Electronics ──────────────────────────────────────────────────────────
    # IC imports (HS 8542): uktradeinfo.com Sep 2024 ~£126M/month → ~£1.5bn/year
    # SHARED FLOW: SIC 26110, 26120, 26301, 26309, 26400 all annualise from same uktradeinfo Sep 2024 monthly IC figure — non-additive
    "Manufacture of electronic components (SIC 26110)":
        (1500,
         "uktradeinfo.com HS 8542 UK IC imports Sep 2024: £126M/month → annualised ~£1.5bn; semiconductor devices (HS 8541) additional; SHARED FLOW: SIC 26110, 26120, 26301, 26309, 26400 all annualise from same uktradeinfo Sep 2024 monthly IC figure; non-additive",
         "ons_or_industry_body"),
    "Manufacture of loaded electronic boards (SIC 26120)":
        (1500,
         "uktradeinfo.com HS 8542 UK IC imports Sep 2024: £126M/month → annualised ~£1.5bn; IC and component imports proxy; SHARED FLOW: SIC 26110, 26120, 26301, 26309, 26400 all annualise from same uktradeinfo Sep 2024 monthly IC figure; non-additive",
         "ons_or_industry_body"),
    # IndexBox citing HMRC: UK laptop+tablet imports 2024 $7.7bn → £6.02bn (HS 8471)
    "Manufacture of computers and peripheral equipment (SIC 26200)":
        (6020,
         "IndexBox citing HMRC: UK laptop and tablet computer imports 2024 $7.7bn → £6.02bn (HS 8471); Bank of England annual average 2024: £1=$1.279",
         "trade_data_aggregator"),
    "Manufacture of telegraph and telephone apparatus and equipment (SIC 26301)":
        (1500,
         "uktradeinfo.com HS 8542 UK IC imports Sep 2024: £126M/month → annualised ~£1.5bn; IC and sub-assembly imports proxy; SHARED FLOW: SIC 26110, 26120, 26301, 26309, 26400 all annualise from same uktradeinfo Sep 2024 monthly IC figure; non-additive",
         "ons_or_industry_body"),
    "Manufacture of communication equipment other than telegraph, and telephone apparatus and equipment (SIC 26309)":
        (1500,
         "uktradeinfo.com HS 8542 UK IC imports Sep 2024: £126M/month → annualised ~£1.5bn; electronic components proxy; SHARED FLOW: SIC 26110, 26120, 26301, 26309, 26400 all annualise from same uktradeinfo Sep 2024 monthly IC figure; non-additive",
         "ons_or_industry_body"),
    "Manufacture of consumer electronics (SIC 26400)":
        (1500,
         "uktradeinfo.com HS 8542 UK IC imports Sep 2024: £126M/month → annualised ~£1.5bn; components+displays+batteries broader market; SHARED FLOW: SIC 26110, 26120, 26301, 26309, 26400 all annualise from same uktradeinfo Sep 2024 monthly IC figure; non-additive",
         "ons_or_industry_body"),
    "Manufacture of taps and valves (SIC 28140)":
        (None, "", "volume_unverified"),

    # ── Wholesale / Agent Sectors ─────────────────────────────────────────────
    # UK total fuel imports ~£69.9bn: derived from ONS UK trade with US 2024 (GOV.UK)
    # SHARED FLOW: SIC 46120 and UK fuel importers draw on same ONS-derived total; SIC 46711 is a SUBSET
    "Agents involved in the sale of fuels, ores, metals and industrial chemicals (SIC 46120)":
        (69900,
         "ONS UK trade with US 2024 (GOV.UK): US fuel imports £15.3bn = 21.9% of UK total → total UK fuel imports ~£69.9bn; metals additional; SHARED FLOW: SIC 46120 and UK fuel importers row draw on same ONS-derived total; non-additive",
         "ons_or_industry_body"),
    "Agents involved in the sale of timber and building materials (SIC 46130)":
        (None, "", "volume_unverified"),
    # TrendEconomy HS ch.88 UK aircraft+parts imports 2023: $15bn → £12.1bn
    # SHARED FLOW: SIC 46140, SIC 77351, SIC 77352, UK aerospace all use same TrendEconomy HS ch.88 dataset — non-additive
    "Agents involved in the sale of machinery, industrial equipment, ships and aircraft (SIC 46140)":
        (12100,
         "TrendEconomy COMTRADE HS ch.88 UK aircraft+parts imports 2023: $15bn → £12.1bn (aircraft HS 8802: $2.07bn; parts HS 8807: $11.9bn); Bank of England annual average 2023: £1=$1.243; SHARED FLOW: SIC 46140, SIC 77351, SIC 77352, UK aerospace all use same TrendEconomy HS ch.88 dataset; non-additive",
         "trade_data_aggregator"),
    # UK raw cotton (HS 5201) imports 2024: $237.65M → £186M
    "Agents involved in the sale of textiles, clothing, fur, footwear and leather goods (SIC 46160)":
        (186,
         "COMTRADE 2024 via Trading Economics: UK raw cotton (HS 5201) imports $237.65M → £186M; Bank of England annual average 2024: £1=$1.279",
         "trade_data_aggregator"),
    # HMRC UK Trade in Food Feed and Drink 2024: coffee/tea/cocoa/spices imports £6.0bn
    # SHARED FLOW: SIC 46170 and SIC 46370 both apply the same £6.0bn HMRC figure — non-additive
    "Agents involved in the sale of food, beverages and tobacco (SIC 46170)":
        (6000,
         "HMRC UK Trade in Food Feed and Drink 2024 (GOV.UK): coffee/tea/cocoa/spices imports £6.0bn; SHARED FLOW: SIC 46170 and SIC 46370 apply the same £6.0bn HMRC figure; non-additive",
         "hmrc_direct"),
    "Wholesale of grain, unmanufactured tobacco, seeds and animal feeds (SIC 46210)":
        (None, "", "volume_unverified"),
    # HMRC UK Trade in Food Feed and Drink 2024: coffee/tea/cocoa/spices +13% to £6.0bn
    # SHARED FLOW: SIC 46370 and SIC 46170 both apply the same £6.0bn HMRC figure — non-additive
    "Wholesale of coffee, tea, cocoa and spices (SIC 46370)":
        (6000,
         "HMRC UK Trade in Food Feed and Drink 2024 (GOV.UK): imports of coffee/tea/cocoa/spices +13% to £6.0bn in real terms in 2024; SHARED FLOW: SIC 46370 and SIC 46170 apply the same £6.0bn HMRC figure; non-additive",
         "hmrc_direct"),
    # Seafish 2024: UK seafood imports £3,839M
    "Wholesale of other food, including fish, crustaceans and molluscs (SIC 46380)":
        (3839,
         "Seafish 2024 UK seafood trade data: total seafood imports £3,839M (+2%); exotic produce additional",
         "ons_or_industry_body"),
    # Crude oil (HS 2709) 2023: $21bn → £16.9bn
    # SHARED FLOW: this crude oil figure is a SUBSET of the £69.9bn total in SIC 46120 / UK fuel importers
    "Wholesale of petroleum and petroleum products (SIC 46711)":
        (16900,
         "TrendEconomy COMTRADE HS 2709 UK crude oil imports 2023: $21bn → £16.9bn; Bank of England annual average 2023: £1=$1.243; SHARED FLOW: this crude oil figure is a SUBSET of the £69.9bn total fuel imports in SIC 46120 and UK fuel importers rows; non-additive",
         "trade_data_aggregator"),
    "Wholesale of other fuels and related products (SIC 46719)":
        (None, "", "volume_unverified"),
    # Iron+steel (HS ch.72) 2024: $6.94bn → £5.4bn; aluminium (HS ch.76) 2024: $6.22bn → £4.86bn; combined proxy £10.26bn
    "Wholesale of metals and metal ores (SIC 46720)":
        (10260,
         "Trading Economics: UK iron+steel imports 2024 $6.94bn → £5.4bn (HS ch.72); UN COMTRADE: aluminium 2024 $6.22bn → £4.86bn (HS ch.76); combined proxy £10.26bn; Bank of England annual average 2024: £1=$1.279",
         "trade_data_aggregator"),
    "Wholesale of chemical products (SIC 46750)":
        (None, "", "volume_unverified"),
    # UK ferrous scrap (HS 7204) exports 2023: $3.23bn → £2.60bn (sector RECEIVES USD as exporter)
    "Wholesale of waste and scrap (SIC 46770)":
        (2600,
         "TrendEconomy COMTRADE HS 7204 UK ferrous scrap exports 2023: $3.23bn → £2.60bn (UK is net exporter; sector receives USD); Bank of England annual average 2023: £1=$1.243",
         "trade_data_aggregator"),

    # ── Retail / Services ────────────────────────────────────────────────────
    # IndexBox / COMTRADE HS 902140 UK hearing aid imports 2024: $263M → £206M
    "Retail sale of hearing aids (SIC 47741)":
        (206,
         "IndexBox / UN COMTRADE HS 902140 UK hearing aid imports 2024: $263M → £206M; Bank of England annual average 2024: £1=$1.279",
         "trade_data_aggregator"),
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
    # SHARED FLOW: SIC 46140, SIC 77351, SIC 77352, UK aerospace all use same TrendEconomy HS ch.88 dataset
    "Renting and leasing of air passenger transport equipment (SIC 77351)":
        (12100,
         "TrendEconomy COMTRADE HS ch.88 UK aircraft+parts imports 2023: $15bn → £12.1bn (HS 8802 aircraft + HS 8807 parts); Bank of England annual average 2023: £1=$1.243; SHARED FLOW: SIC 46140, SIC 77351, SIC 77352, UK aerospace all use same TrendEconomy HS ch.88 dataset; non-additive",
         "trade_data_aggregator"),
    "Renting and leasing of freight air transport equipment (SIC 77352)":
        (12100,
         "TrendEconomy COMTRADE HS ch.88 UK aircraft+parts imports 2023: $15bn → £12.1bn (same dataset as passenger aircraft leasing); Bank of England annual average 2023: £1=$1.243; SHARED FLOW: SIC 46140, SIC 77351, SIC 77352, UK aerospace all use same TrendEconomy HS ch.88 dataset; non-additive",
         "trade_data_aggregator"),
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
    # TrendEconomy HS ch.88 UK aircraft+parts imports 2023: $15bn → £12.1bn
    # SHARED FLOW: same dataset as SIC 46140, SIC 77351, SIC 77352
    "UK aerospace and defence equipment manufacturers":
        (12100,
         "TrendEconomy COMTRADE HS ch.88 UK aircraft+parts imports 2023: $15bn → £12.1bn; ADS Group: UK aerospace exports £20bn (2024 sector scale reference); Bank of England annual average 2023: £1=$1.243; SHARED FLOW: SIC 46140, SIC 77351, SIC 77352, UK aerospace all use same TrendEconomy HS ch.88 dataset; non-additive",
         "trade_data_aggregator"),
    "UK antiquarian and rare book dealers":
        (None, "", "volume_unverified"),
    # UKIE: UK video games exports 2021 $8.8bn → £6.8bn; consumer market 2024 £7.6bn
    "UK video game publishers and developers":
        (6800,
         "UKIE: UK video games exports 2021 $8.8bn → £6.8bn; consumer market 2024 £7.6bn (most recent export figure is 2021)",
         "ons_or_industry_body"),
    "UK specialty chemical manufacturers and importers":
        (None, "", "volume_unverified"),
    "UK optical lens and frame manufacturers":
        (None, "", "volume_unverified"),
    # ONS UK trade with US 2024 (GOV.UK); SHARED FLOW: same total as SIC 46120
    "UK fuel importers and oil product distributors":
        (69900,
         "ONS UK trade with US 2024 (GOV.UK): US fuel imports to UK £15.3bn = 21.9% of total UK fuel imports → total ~£69.9bn (crude+refined+products); SHARED FLOW: SIC 46120 and UK fuel importers row draw on same ONS-derived total; non-additive",
         "ons_or_industry_body"),
    # Publishers Association Annual Report 2024
    "UK book publishers licensing international rights":
        (345,
         "Publishers Association Annual Report 2024: rights income £257M + coeditions £65M + secondary licensing £23M = £345M FX receipts; total book exports £4.5bn",
         "ons_or_industry_body"),
    # TDUK / Timber Trades Journal 2023
    "UK timber importers and merchants":
        (1800,
         "TDUK / Timber Trades Journal 2023: UK timber import volume ~7.3M m³ at average ~£246/m³ (softwood price) → est £1.8bn",
         "ons_or_industry_body"),
    # HMRC OTS figures sourced via WSTA (industry body) and Statista; reclassified from
    # hmrc_direct → ons_or_industry_body as access was via WSTA / Statista intermediaries
    "UK wine and spirits importers and wholesalers":
        (4760,
         "HMRC OTS via WSTA 2024: wine imports (HS 2204) £3,910M; spirits (HS 2208) 2022 HMRC peak £988M est 2024 ~£850M; combined ~£4.76bn",
         "ons_or_industry_body"),
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

    verified   = sum(1 for r in rows if r["trade_volume_gbp"])
    unverified = len(rows) - verified
    tiers: dict[str, int] = {}
    for r in rows:
        t = r["trade_volume_confidence"]
        tiers[t] = tiers.get(t, 0) + 1
    print(f"Written {len(rows)} rows ({verified} with trade volume, {unverified} unverified) → {out_path}")
    for tier, count in sorted(tiers.items()):
        print(f"  {tier}: {count}")


if __name__ == "__main__":
    main()
