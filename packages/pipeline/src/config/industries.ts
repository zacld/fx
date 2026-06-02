/**
 * config/industries.ts — runtime-configurable industry presets for Brain 3.
 *
 * Set INDUSTRY_PRESET to one of the preset IDs below to override which industry
 * the discover stage targets. When set, a synthetic segment is injected into
 * every event so discovery runs your chosen industry's keywords regardless of
 * (or in addition to) the AI-derived event segments.
 *
 * Preset IDs:
 *   fx_imports           — importers/exporters/wholesalers (default FX behaviour)
 *   it_technology        — managed services, cloud, cybersecurity, SaaS
 *   manufacturing        — precision engineering, component mfg, OEM, contract mfg
 *   logistics            — freight, haulage, 3PL, customs brokers, couriers
 *   professional_services — consultancy, accountancy, legal, recruitment, agencies
 *   custom               — fully configurable via env vars (see buildCustomPreset)
 *
 * Custom preset env vars:
 *   INDUSTRY_LABEL    — display name (default "Custom Industry")
 *   INDUSTRY_KEYWORDS — comma-separated search terms
 *   INDUSTRY_SIC_CODES — comma-separated SIC prefixes to match
 *   INDUSTRY_SIGNALS  — comma-separated website validation signals
 */

export interface IndustryPreset {
  id: string;
  /** Human-readable name shown in the dashboard and lead cards. */
  label: string;
  /** SIC code prefixes to match (partial prefix — "46" matches 4699, 4611, etc.). */
  sicCodes: string[];
  /** Search query terms injected as high_intent_search_queries in the synthetic segment. */
  keywords: string[];
  /** Website signals used to validate a company belongs to this industry. */
  websiteSignals: string[];
}

export const INDUSTRY_PRESETS: Record<string, IndustryPreset> = {
  fx_imports: {
    id: "fx_imports",
    label: "FX & Import/Export",
    sicCodes: ["46", "47", "50", "51", "52", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "30", "31", "32", "33"],
    keywords: [
      "UK importer distributor",
      "UK exporter wholesale",
      "import export company UK",
      "overseas supplier UK wholesale",
      "European supplier UK distributor",
      "global sourcing UK company",
    ],
    websiteSignals: ["import", "export", "overseas", "international supplier", "global sourcing", "foreign supplier", "currency", "FX"],
  },

  it_technology: {
    id: "it_technology",
    label: "IT & Technology",
    sicCodes: ["62", "63", "582", "465", "4651", "4652"],
    keywords: [
      "Microsoft Gold Partner UK IT services",
      "AWS partner managed services UK",
      "IT managed service provider UK mid-market",
      "cloud migration services UK business",
      "cybersecurity managed services UK SME",
      "Microsoft 365 reseller UK IT company",
      "Cisco partner UK IT infrastructure",
      "IT outsourcing company UK",
      "software reseller UK B2B",
      "VAR value added reseller UK IT",
    ],
    websiteSignals: ["managed services", "IT support", "cloud", "cybersecurity", "software", "SaaS", "technology solutions", "digital transformation", "Microsoft partner", "AWS", "infrastructure"],
  },

  manufacturing: {
    id: "manufacturing",
    label: "Manufacturing & Engineering",
    sicCodes: ["10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "30", "31", "32", "33"],
    keywords: [
      "UK manufacturer B2B",
      "precision engineering company UK",
      "industrial manufacturer UK",
      "component manufacturer UK",
      "OEM manufacturer UK",
      "contract manufacturing UK",
    ],
    websiteSignals: ["manufacturer", "manufacturing", "engineering", "components", "production", "machining", "fabrication", "assembly", "CNC"],
  },

  logistics: {
    id: "logistics",
    label: "Logistics & Freight",
    sicCodes: ["49", "50", "51", "52", "53"],
    keywords: [
      "freight forwarder UK",
      "logistics company UK",
      "haulage company UK",
      "3PL provider UK",
      "customs broker UK",
      "supply chain company UK",
    ],
    websiteSignals: ["freight", "logistics", "haulage", "transport", "courier", "supply chain", "customs", "shipping", "warehousing", "3PL"],
  },

  professional_services: {
    id: "professional_services",
    label: "Professional Services",
    sicCodes: ["69", "70", "71", "72", "73", "74", "78"],
    keywords: [
      "management consultancy UK B2B",
      "accountancy firm UK",
      "legal services firm UK",
      "recruitment agency UK",
      "marketing agency UK B2B",
      "professional services company UK",
    ],
    websiteSignals: ["consulting", "advisory", "accountancy", "legal", "recruitment", "agency", "professional services", "advisory services"],
  },
};

/**
 * Returns the IndustryPreset for the given id, or null if unknown/unset.
 * Pass process.env.INDUSTRY_PRESET as the argument.
 */
export function getIndustryPreset(id: string | undefined): IndustryPreset | null {
  if (!id) return null;
  if (id === "custom") return buildCustomPreset();
  return INDUSTRY_PRESETS[id] ?? null;
}

/** Builds a fully custom preset from env vars. Returns null if INDUSTRY_KEYWORDS is not set. */
function buildCustomPreset(): IndustryPreset | null {
  const keywords = (process.env.INDUSTRY_KEYWORDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!keywords.length) {
    console.warn("[industries] INDUSTRY_PRESET=custom but INDUSTRY_KEYWORDS is empty — no preset applied.");
    return null;
  }
  return {
    id: "custom",
    label: process.env.INDUSTRY_LABEL ?? "Custom Industry",
    sicCodes: (process.env.INDUSTRY_SIC_CODES ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    keywords,
    websiteSignals: (process.env.INDUSTRY_SIGNALS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
}
