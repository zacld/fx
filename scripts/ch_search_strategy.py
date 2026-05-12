"""
Companies House Search Strategy

CH free-text search matches company NAMES only — not what they do.
Most importers don't have "import" in their name.

Better strategy:
1. Search known brand/trading name keywords (Bibendum, Majestic, etc.) — NO
2. Search CH by SIC code (not available in free search) — NO
3. Search terms that appear in REAL company names:
   - Product/category words: "wines", "spirits", "seafood", "chemicals"
   - Trade words: "wholesale", "trading", "distribution", "supplies"
   - Qualifier words: "international", "foods", "merchants"
   - Combined: "wines wholesale", "food trading", "chemical supplies"
4. Cast wide, filter by website signals

KEY INSIGHT: Search broad product/trade terms, not "import" + product.
Real company names use: "Fine Wines Ltd", "Foods International Ltd",
"Chemical Supplies Ltd", "Seafood Trading Ltd" etc.
"""

# Search terms that match real UK importer/wholesaler company NAMES
# These are words that actually appear in registered company names

BROAD_SEARCH_TERMS = {

    # WINE AND SPIRITS IMPORTERS
    "wine_importers": [
        "wines wholesale",
        "wine merchant",
        "wines merchant",
        "fine wines",
        "wine trading",
        "wine agencies",
        "wines international",
        "wine distribution",
        "wine importers",
    ],
    "spirits_importers": [
        "spirits wholesale",
        "spirits international",
        "spirits trading",
        "distillery export",
        "whisky trading",
    ],

    # FOOD IMPORTERS
    "food_importers": [
        "food international",
        "foods international",
        "food trading",
        "foods trading",
        "food wholesale",
        "foods wholesale",
        "food distribution",
        "food imports",
        "speciality foods",
        "specialty foods",
        "gourmet foods",
        "deli foods",
    ],
    "italian_spanish_food": [
        "Italian food",
        "Italian foods",
        "Spanish food",
        "Mediterranean food",
        "European food",
        "continental foods",
    ],

    # SEAFOOD IMPORTERS
    "seafood_importers": [
        "seafood wholesale",
        "seafood trading",
        "fish wholesale",
        "fish trading",
        "seafood international",
        "fish merchants",
        "seafood merchants",
        "seafood supplies",
    ],

    # CHEMICAL IMPORTERS / DISTRIBUTORS
    "chemical_importers": [
        "chemicals wholesale",
        "chemical supplies",
        "chemical trading",
        "chemicals trading",
        "chemical distribution",
        "chemicals distribution",
        "industrial chemicals",
        "specialty chemicals",
    ],

    # PETROLEUM / FUEL
    "petroleum_importers": [
        "petroleum wholesale",
        "petroleum trading",
        "fuel trading",
        "lubricants wholesale",
        "oil trading",
        "petroleum distribution",
    ],

    # FURNITURE / HOMEWARE IMPORTERS
    "furniture_importers": [
        "furniture wholesale",
        "furniture trading",
        "furniture international",
        "home furnishings wholesale",
        "furniture imports",
    ],

    # CLOTHING / FASHION IMPORTERS
    "clothing_importers": [
        "clothing wholesale",
        "fashion wholesale",
        "garments wholesale",
        "textiles wholesale",
        "clothing trading",
        "fashion international",
    ],

    # ELECTRONICS IMPORTERS
    "electronics_importers": [
        "electronics wholesale",
        "electronics trading",
        "electronics distribution",
        "tech wholesale",
        "components wholesale",
    ],

    # CONSTRUCTION MATERIALS
    "construction_importers": [
        "building materials wholesale",
        "building supplies wholesale",
        "construction materials",
        "timber wholesale",
        "stone wholesale",
    ],

    # AUTOMOTIVE PARTS
    "automotive_importers": [
        "automotive parts wholesale",
        "vehicle parts wholesale",
        "car parts wholesale",
        "motor parts trading",
        "automotive wholesale",
    ],

    # MACHINERY / ENGINEERING
    "machinery_importers": [
        "machinery wholesale",
        "machinery trading",
        "engineering supplies",
        "industrial supplies",
        "equipment wholesale",
    ],

    # GENERAL IMPORTERS / EXPORTERS
    "general_importers": [
        "import export",
        "import trading",
        "trading international",
        "international trading",
        "global trading",
        "worldwide trading",
        "international distribution",
        "global distribution",
    ],
}

def get_search_terms_for_segment(segment_name: str, exposure_type: str) -> list:
    """
    Given a segment name and exposure type, return the best CH search terms.
    Merges specific segment terms with relevant broad terms.
    """
    terms = []
    name_lower = segment_name.lower()
    exp_lower  = exposure_type.lower()

    if any(x in name_lower for x in ["wine","spirits","whisky","gin","alcohol","drink"]):
        terms.extend(BROAD_SEARCH_TERMS["wine_importers"][:4])
        terms.extend(BROAD_SEARCH_TERMS["spirits_importers"][:3])

    if any(x in name_lower for x in ["food","deli","gourmet","speciality","specialty"]):
        terms.extend(BROAD_SEARCH_TERMS["food_importers"][:4])
        terms.extend(BROAD_SEARCH_TERMS["italian_spanish_food"][:3])

    if any(x in name_lower for x in ["seafood","fish","salmon","tuna"]):
        terms.extend(BROAD_SEARCH_TERMS["seafood_importers"][:4])

    if any(x in name_lower for x in ["chemical","petroleum","fuel","oil","lubricant"]):
        terms.extend(BROAD_SEARCH_TERMS["chemical_importers"][:4])
        terms.extend(BROAD_SEARCH_TERMS["petroleum_importers"][:3])

    if any(x in name_lower for x in ["furniture","homeware","furnishing"]):
        terms.extend(BROAD_SEARCH_TERMS["furniture_importers"][:4])

    if any(x in name_lower for x in ["clothing","fashion","garment","textile","apparel"]):
        terms.extend(BROAD_SEARCH_TERMS["clothing_importers"][:4])

    if any(x in name_lower for x in ["electronic","tech","component","semiconductor"]):
        terms.extend(BROAD_SEARCH_TERMS["electronics_importers"][:4])

    if any(x in name_lower for x in ["machinery","engineering","equipment","industrial"]):
        terms.extend(BROAD_SEARCH_TERMS["machinery_importers"][:4])

    if any(x in name_lower for x in ["automotive","vehicle","car","motor"]):
        terms.extend(BROAD_SEARCH_TERMS["automotive_importers"][:4])

    if any(x in name_lower for x in ["construction","building","material","timber"]):
        terms.extend(BROAD_SEARCH_TERMS["construction_importers"][:4])

    # Always add general importer terms for importers
    if any(x in exp_lower for x in ["import","supplier","overseas"]):
        terms.extend(BROAD_SEARCH_TERMS["general_importers"][:3])

    # Dedupe and return top 8
    return list(dict.fromkeys(terms))[:8]
