/**
 * stages/evergreen.ts — weekly evergreen prospect discovery.
 *
 * Inserts synthetic "evergreen" events (one per category group) into the DB and
 * then runs the discover stage on them. Designed for the weekly Sunday 2am run so
 * the candidate pool grows independently of daily news flow.
 *
 * Every lead produced gets lead_type = "evergreen_saving". The discover, score,
 * dedup, and generate-drafts stages all handle these identically to event-triggered
 * leads — they flow into HOT/WARM/QUEUE by the same gates.
 *
 * Idempotent: uses ISO year-week identifier as the event id suffix, so re-running
 * in the same week skips already-inserted events.
 *
 * CLI: tsx src/stages/evergreen.ts [--db path] [--force]
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { getDb } from "@fx/core/db";
import { repoRoot } from "@fx/core";
import type { Segment, FxEvent } from "@fx/core";
import { runDiscoverStage } from "./discover.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── ISO week helper ───────────────────────────────────────────────────────────
function isoWeek(): string {
  const now = new Date();
  const jan4 = new Date(now.getFullYear(), 0, 4);
  const startOfWeek1 = new Date(jan4);
  startOfWeek1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7));
  const diff = now.getTime() - startOfWeek1.getTime();
  const week = Math.floor(diff / (7 * 86_400_000)) + 1;
  return `${now.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

// ── Evergreen playbook ────────────────────────────────────────────────────────
// Each entry becomes a synthetic "ready" event. Segments mirror the Brain 2 schema.
// Keep category_priority_score ≥ 75 — these are pre-validated high-fit niches.

interface PlaybookEntry {
  headline: string;
  segments: Partial<Segment>[];
}

const PLAYBOOK: PlaybookEntry[] = [
  // ── FOOD & DRINK ─────────────────────────────────────────────────────────
  {
    headline: "Evergreen: UK wine, spirits & drinks importers",
    segments: [
      {
        segment_name: "Wine & Spirits Importers",
        exposure_level: "Very High",
        exposure_type: "import_costs",
        likely_currency_pairs: ["GBP/EUR"],
        affected_payment_flow: "GBP revenue / EUR supplier costs",
        why_affected: "Pay EUR invoices to European producers. GBP/EUR moves directly compress margin on every shipment.",
        category_priority_score: 95,
        sales_angle: "EUR invoice costs. Rate review on upcoming payments.",
        micro_categories: [
          { name: "Italian wine importers UK", why: "", search_queries: ["Italian wine importer UK wholesale", "wine importer Italy UK trade"], companies_house_terms: ["wine importer", "wine distributor"] },
          { name: "French wine & champagne importers UK", why: "", search_queries: ["French wine importer UK wholesale", "champagne importer UK trade"], companies_house_terms: ["wine importer", "champagne importer"] },
          { name: "Spirits & whisky importers UK", why: "", search_queries: ["spirits importer UK wholesale", "European spirits distributor UK"], companies_house_terms: ["spirits importer", "spirits distributor"] },
          { name: "Natural & independent wine importers UK", why: "", search_queries: ["natural wine importer UK", "independent wine merchant importer UK"], companies_house_terms: ["wine merchant", "wine importer"] },
        ],
      },
      {
        segment_name: "Specialty Beer & Craft Drinks Importers",
        exposure_level: "High",
        exposure_type: "import_costs",
        likely_currency_pairs: ["GBP/EUR"],
        affected_payment_flow: "GBP revenue / EUR supplier costs",
        why_affected: "Import craft beer and drinks from European breweries in EUR.",
        category_priority_score: 78,
        micro_categories: [
          { name: "Craft beer importers UK", why: "", search_queries: ["craft beer importer UK wholesale", "European beer importer UK"], companies_house_terms: ["beer importer", "beer distributor"] },
          { name: "Soft drinks & mixer importers UK", why: "", search_queries: ["soft drink importer UK wholesale", "premium mixer importer UK"], companies_house_terms: ["drinks importer", "beverage importer"] },
        ],
      },
    ],
  },
  {
    headline: "Evergreen: UK food importers & continental food distributors",
    segments: [
      {
        segment_name: "Italian & Continental Food Importers",
        exposure_level: "High",
        exposure_type: "import_costs",
        likely_currency_pairs: ["GBP/EUR"],
        affected_payment_flow: "GBP revenue / EUR supplier costs",
        why_affected: "Buy produce, deli goods, and specialty foods from Italian, French, Spanish producers in EUR.",
        category_priority_score: 90,
        micro_categories: [
          { name: "Italian food importers UK", why: "", search_queries: ["Italian food importer UK wholesale", "Italian deli food distributor UK"], companies_house_terms: ["food importer", "Italian food"] },
          { name: "European specialty food importers", why: "", search_queries: ["European food importer UK wholesale", "continental food importer UK"], companies_house_terms: ["specialty food importer", "food distributor"] },
          { name: "Charcuterie & cheese importers UK", why: "", search_queries: ["cheese importer UK wholesale", "charcuterie importer UK"], companies_house_terms: ["cheese importer", "charcuterie importer"] },
        ],
      },
      {
        segment_name: "Seafood & Fresh Produce Importers",
        exposure_level: "High",
        exposure_type: "import_costs",
        likely_currency_pairs: ["GBP/EUR", "GBP/NOK"],
        affected_payment_flow: "GBP revenue / EUR and NOK supplier costs",
        why_affected: "Import seafood and fresh produce from European and Norwegian sources in EUR/NOK.",
        category_priority_score: 82,
        micro_categories: [
          { name: "Seafood importers UK", why: "", search_queries: ["seafood importer UK wholesale", "fish importer UK trade"], companies_house_terms: ["seafood importer", "fish importer"] },
          { name: "Fresh produce importers UK", why: "", search_queries: ["fresh produce importer UK wholesale", "fruit vegetable importer UK"], companies_house_terms: ["produce importer", "fresh food importer"] },
        ],
      },
    ],
  },
  // ── MANUFACTURING & INDUSTRIAL ────────────────────────────────────────────
  {
    headline: "Evergreen: UK machinery, components & industrial importers",
    segments: [
      {
        segment_name: "Machinery & Industrial Components Distributors",
        exposure_level: "High",
        exposure_type: "import_costs",
        likely_currency_pairs: ["GBP/EUR", "GBP/USD"],
        affected_payment_flow: "GBP revenue / EUR-USD supplier costs",
        why_affected: "Source machinery and industrial components from European manufacturers in EUR. USD for US/Asian sources.",
        category_priority_score: 85,
        micro_categories: [
          { name: "Industrial machinery importers UK", why: "", search_queries: ["industrial machinery importer UK", "machinery distributor UK European"], companies_house_terms: ["machinery importer", "machinery distributor"] },
          { name: "Pneumatic & hydraulic components UK", why: "", search_queries: ["pneumatic components distributor UK", "hydraulic parts importer UK"], companies_house_terms: ["components distributor", "hydraulic importer"] },
          { name: "CNC & engineering components UK", why: "", search_queries: ["engineering components importer UK", "CNC tooling distributor UK"], companies_house_terms: ["engineering components", "tooling distributor"] },
          { name: "Pumps & valves importers UK", why: "", search_queries: ["pump importer UK distributor", "valve importer UK industrial"], companies_house_terms: ["pump distributor", "valve importer"] },
        ],
      },
      {
        segment_name: "Chemicals & Raw Materials Importers",
        exposure_level: "High",
        exposure_type: "import_costs",
        likely_currency_pairs: ["GBP/EUR", "GBP/USD"],
        affected_payment_flow: "GBP revenue / EUR-USD raw material costs",
        why_affected: "Buy chemicals and raw materials priced in EUR or USD from European and US producers.",
        category_priority_score: 80,
        micro_categories: [
          { name: "Specialty chemicals importers UK", why: "", search_queries: ["specialty chemical importer UK", "chemical distributor UK European"], companies_house_terms: ["chemical importer", "chemical distributor"] },
          { name: "Food ingredient importers UK", why: "", search_queries: ["food ingredient importer UK wholesale", "food additive importer UK"], companies_house_terms: ["food ingredient importer", "ingredient distributor"] },
          { name: "Plastics & polymer importers UK", why: "", search_queries: ["plastic raw material importer UK", "polymer distributor UK"], companies_house_terms: ["plastics importer", "polymer distributor"] },
        ],
      },
      {
        segment_name: "Packaging & Materials Importers",
        exposure_level: "Medium",
        exposure_type: "import_costs",
        likely_currency_pairs: ["GBP/EUR"],
        affected_payment_flow: "GBP revenue / EUR packaging costs",
        why_affected: "Source packaging materials from European suppliers in EUR.",
        category_priority_score: 75,
        micro_categories: [
          { name: "Packaging materials importers UK", why: "", search_queries: ["packaging importer UK wholesale", "packaging materials distributor UK European"], companies_house_terms: ["packaging importer", "packaging distributor"] },
          { name: "Glass & bottle importers UK", why: "", search_queries: ["glass bottle importer UK", "wine bottle supplier UK European"], companies_house_terms: ["bottle importer", "glass importer"] },
        ],
      },
    ],
  },
  // ── CONSUMER GOODS / RETAIL TRADE ────────────────────────────────────────
  {
    headline: "Evergreen: UK furniture, textiles & consumer goods importers",
    segments: [
      {
        segment_name: "Furniture & Interiors Importers",
        exposure_level: "High",
        exposure_type: "import_costs",
        likely_currency_pairs: ["GBP/EUR", "GBP/USD"],
        affected_payment_flow: "GBP revenue / EUR-USD sourcing costs",
        why_affected: "Source furniture and interiors from European or Asian manufacturers. Prices in EUR or USD.",
        category_priority_score: 80,
        micro_categories: [
          { name: "Contract furniture importers UK", why: "", search_queries: ["furniture importer UK wholesale trade", "contract furniture distributor UK European"], companies_house_terms: ["furniture importer", "furniture distributor"] },
          { name: "Lighting & home interiors importers UK", why: "", search_queries: ["lighting importer UK wholesale", "interiors importer UK trade"], companies_house_terms: ["lighting importer", "interiors importer"] },
        ],
      },
      {
        segment_name: "Textile & Clothing Importers",
        exposure_level: "High",
        exposure_type: "import_costs",
        likely_currency_pairs: ["GBP/EUR", "GBP/USD"],
        affected_payment_flow: "GBP revenue / EUR-USD sourcing costs",
        why_affected: "Source garments and fabrics from European or Asian manufacturers. EUR for EU mills, USD for Asia.",
        category_priority_score: 76,
        micro_categories: [
          { name: "Wholesale clothing importers UK", why: "", search_queries: ["clothing importer UK wholesale", "garment importer UK trade"], companies_house_terms: ["clothing importer", "garment importer"] },
          { name: "Fabric & textile importers UK", why: "", search_queries: ["fabric importer UK wholesale", "textile importer UK European"], companies_house_terms: ["textile importer", "fabric importer"] },
          { name: "Fashion & apparel distributors UK", why: "", search_queries: ["fashion importer UK wholesale trade", "apparel distributor UK European"], companies_house_terms: ["fashion importer", "apparel importer"] },
        ],
      },
    ],
  },
  // ── AUTOMOTIVE & ELECTRONICS ──────────────────────────────────────────────
  {
    headline: "Evergreen: UK automotive parts & electronics distributors",
    segments: [
      {
        segment_name: "Automotive Parts Distributors",
        exposure_level: "High",
        exposure_type: "import_costs",
        likely_currency_pairs: ["GBP/EUR"],
        affected_payment_flow: "GBP revenue / EUR parts costs",
        why_affected: "Source automotive parts from European manufacturers in EUR.",
        category_priority_score: 78,
        micro_categories: [
          { name: "Automotive parts importers UK", why: "", search_queries: ["automotive parts importer UK wholesale", "car parts distributor UK European"], companies_house_terms: ["automotive parts importer", "parts distributor"] },
          { name: "Commercial vehicle parts UK", why: "", search_queries: ["truck parts importer UK", "commercial vehicle parts distributor UK"], companies_house_terms: ["vehicle parts importer", "parts distributor"] },
        ],
      },
      {
        segment_name: "Electronics & Technology Distributors",
        exposure_level: "High",
        exposure_type: "import_costs",
        likely_currency_pairs: ["GBP/USD"],
        affected_payment_flow: "GBP revenue / USD component costs",
        why_affected: "Source electronics and components priced in USD from US or Asian suppliers.",
        category_priority_score: 76,
        micro_categories: [
          { name: "Electronic components distributors UK", why: "", search_queries: ["electronic components distributor UK", "electronics importer UK wholesale"], companies_house_terms: ["electronic components", "electronics distributor"] },
          { name: "AV & technology equipment importers UK", why: "", search_queries: ["AV equipment importer UK", "technology equipment distributor UK"], companies_house_terms: ["technology importer", "AV distributor"] },
        ],
      },
    ],
  },
  // ── IT & TECHNOLOGY ───────────────────────────────────────────────────────
  {
    headline: "Evergreen: UK Microsoft & cloud partners paying USD/EUR licensing costs",
    segments: [
      {
        segment_name: "Microsoft & Cloud Partners",
        exposure_level: "High",
        exposure_type: "import_costs",
        likely_currency_pairs: ["GBP/USD", "GBP/EUR"],
        affected_payment_flow: "GBP revenue / USD-EUR software licensing costs",
        why_affected: "Pay Microsoft, AWS, Google Cloud, and Cisco licensing fees in USD or EUR. Every GBP/USD move hits margin on renewals and resale.",
        category_priority_score: 88,
        sales_angle: "USD licensing cost review. Rate lock on upcoming Microsoft/AWS renewals.",
        micro_categories: [
          { name: "Microsoft Gold & Silver Partners UK", why: "Pay Microsoft licensing in USD; resell to SMEs in GBP", search_queries: ["Microsoft Gold Partner UK IT services", "Microsoft 365 reseller UK mid-market"], companies_house_terms: ["Microsoft partner", "IT solutions"] },
          { name: "AWS & Azure cloud partners UK", why: "AWS and Azure fees billed in USD; clients pay GBP", search_queries: ["AWS partner managed cloud services UK", "Azure partner UK IT mid-market"], companies_house_terms: ["cloud services", "IT managed services"] },
          { name: "Cisco & network infrastructure partners UK", why: "Cisco hardware and licensing costs in USD", search_queries: ["Cisco partner UK IT infrastructure", "Cisco reseller UK network solutions"], companies_house_terms: ["Cisco partner", "network solutions"] },
        ],
      },
      {
        segment_name: "IT Managed Service Providers",
        exposure_level: "High",
        exposure_type: "import_costs",
        likely_currency_pairs: ["GBP/USD", "GBP/EUR"],
        affected_payment_flow: "GBP monthly recurring revenue / USD-EUR vendor costs",
        why_affected: "MSPs pay monthly stack costs (RMM tools, security vendors, cloud) in USD. Margins squeezed when GBP/USD falls.",
        category_priority_score: 85,
        sales_angle: "Stack cost FX exposure — USD tool spend vs GBP contract revenue.",
        micro_categories: [
          { name: "IT managed service providers UK SME", why: "Monthly USD tool costs against GBP MRR", search_queries: ["IT managed service provider UK SME", "MSP UK managed IT support"], companies_house_terms: ["managed services", "IT support"] },
          { name: "Cybersecurity managed service providers UK", why: "US-priced security tools; GBP-billed clients", search_queries: ["cybersecurity managed services UK business", "cyber security MSP UK mid-market"], companies_house_terms: ["cybersecurity", "security services"] },
          { name: "IT outsourcing companies UK", why: "Offshore staff costs in USD/EUR; GBP client contracts", search_queries: ["IT outsourcing company UK B2B", "IT services outsourcing UK mid-market"], companies_house_terms: ["IT outsourcing", "managed IT"] },
        ],
      },
    ],
  },
  {
    headline: "Evergreen: UK software resellers & value-added resellers paying USD costs",
    segments: [
      {
        segment_name: "Software Resellers & VARs",
        exposure_level: "High",
        exposure_type: "import_costs",
        likely_currency_pairs: ["GBP/USD"],
        affected_payment_flow: "GBP revenue / USD software vendor costs",
        why_affected: "Buy software licences from US vendors in USD and resell in GBP to UK businesses. Every GBP/USD move changes margin on every deal.",
        category_priority_score: 86,
        sales_angle: "USD software cost hedging — rate review before renewal season.",
        micro_categories: [
          { name: "Value-added resellers UK IT", why: "Hardware + software bundles sourced in USD", search_queries: ["VAR value added reseller UK IT solutions", "IT reseller UK B2B mid-market"], companies_house_terms: ["IT reseller", "value added reseller"] },
          { name: "SaaS & cloud software resellers UK", why: "Resell US SaaS platforms to UK SMEs in GBP", search_queries: ["SaaS reseller UK B2B", "cloud software reseller UK business"], companies_house_terms: ["software reseller", "SaaS distributor"] },
          { name: "Enterprise software distributors UK", why: "Buy enterprise licences in USD; invoice clients in GBP", search_queries: ["enterprise software distributor UK", "software distributor UK B2B mid-market"], companies_house_terms: ["software distributor", "IT distributor"] },
        ],
      },
      {
        segment_name: "IT Hardware Distributors",
        exposure_level: "High",
        exposure_type: "import_costs",
        likely_currency_pairs: ["GBP/USD", "GBP/EUR"],
        affected_payment_flow: "GBP revenue / USD-EUR hardware procurement costs",
        why_affected: "Source servers, networking, and end-user devices from US and European manufacturers. Hardware priced in USD.",
        category_priority_score: 80,
        sales_angle: "Hardware procurement FX review — USD buying costs vs GBP contract bids.",
        micro_categories: [
          { name: "Server & storage distributors UK", why: "HPE, Dell, NetApp priced in USD", search_queries: ["server storage distributor UK mid-market", "HPE Dell reseller UK B2B"], companies_house_terms: ["server distributor", "IT hardware"] },
          { name: "Networking equipment distributors UK", why: "Cisco, Juniper, Palo Alto USD pricing", search_queries: ["networking equipment distributor UK", "network hardware reseller UK B2B"], companies_house_terms: ["networking distributor", "network reseller"] },
          { name: "Endpoint & device resellers UK", why: "Laptops, PCs, tablets sourced from US/Asian suppliers", search_queries: ["laptop device reseller UK B2B", "endpoint device distributor UK mid-market"], companies_house_terms: ["device reseller", "IT equipment"] },
        ],
      },
    ],
  },
  {
    headline: "Evergreen: UK ERP, CRM & enterprise software implementation partners",
    segments: [
      {
        segment_name: "ERP & Business Software Partners",
        exposure_level: "High",
        exposure_type: "import_costs",
        likely_currency_pairs: ["GBP/USD", "GBP/EUR"],
        affected_payment_flow: "GBP project revenue / USD-EUR software licensing costs",
        why_affected: "Pay SAP, Oracle, Sage, Microsoft Dynamics, NetSuite licence fees in USD or EUR; bill UK clients in GBP on fixed-price projects.",
        category_priority_score: 84,
        sales_angle: "ERP licence renewal FX review — USD cost lock before renewal window.",
        micro_categories: [
          { name: "Microsoft Dynamics & Business Central partners UK", why: "USD Dynamics licence costs; GBP-billed implementations", search_queries: ["Microsoft Dynamics partner UK SME", "Business Central implementation partner UK"], companies_house_terms: ["Dynamics partner", "ERP implementation"] },
          { name: "Sage & Xero implementation partners UK", why: "Pay USD/EUR platform fees; bill UK accountancy clients in GBP", search_queries: ["Sage implementation partner UK B2B", "Xero Gold partner UK accounting software"], companies_house_terms: ["Sage partner", "accounting software"] },
          { name: "Salesforce & CRM implementation partners UK", why: "Salesforce USD licensing passed to UK SME clients", search_queries: ["Salesforce partner UK SME B2B", "CRM implementation company UK mid-market"], companies_house_terms: ["Salesforce partner", "CRM consultancy"] },
          { name: "NetSuite & Oracle partners UK", why: "USD NetSuite/Oracle licensing costs; GBP project contracts", search_queries: ["NetSuite partner UK mid-market", "Oracle partner UK business software"], companies_house_terms: ["NetSuite partner", "Oracle partner"] },
        ],
      },
      {
        segment_name: "IT Recruitment & Staffing Agencies",
        exposure_level: "Medium",
        exposure_type: "multi_currency",
        likely_currency_pairs: ["GBP/USD", "GBP/EUR"],
        affected_payment_flow: "GBP revenue / USD-EUR contractor and overseas payroll costs",
        why_affected: "Pay offshore IT contractors in USD or EUR; bill UK tech clients in GBP. FX moves squeeze margins on offshore delivery models.",
        category_priority_score: 76,
        sales_angle: "Offshore contractor payroll FX review — USD/EUR cost hedging for recurring payments.",
        micro_categories: [
          { name: "IT staffing & technology recruitment agencies UK", why: "USD/EUR offshore IT contractor costs; GBP client billing", search_queries: ["IT recruitment agency UK technology staffing", "technology staffing company UK mid-market"], companies_house_terms: ["IT recruitment", "technology staffing"] },
          { name: "Nearshore software development companies UK", why: "EUR nearshore dev team costs; GBP client revenue", search_queries: ["nearshore software development company UK", "offshore software development UK mid-market"], companies_house_terms: ["software development", "nearshore development"] },
        ],
      },
    ],
  },
  {
    headline: "Evergreen: UK telecoms resellers & UCaaS providers with USD carrier costs",
    segments: [
      {
        segment_name: "Telecoms Resellers & UCaaS Providers",
        exposure_level: "High",
        exposure_type: "import_costs",
        likely_currency_pairs: ["GBP/USD", "GBP/EUR"],
        affected_payment_flow: "GBP subscription revenue / USD-EUR carrier and platform costs",
        why_affected: "Pay US carrier interconnect fees and UCaaS platform costs (Teams, Zoom, RingCentral) in USD; sell UK telecoms services in GBP on monthly contracts.",
        category_priority_score: 80,
        sales_angle: "Monthly USD carrier cost review — fix exchange rate on recurring telecoms carrier spend.",
        micro_categories: [
          { name: "Microsoft Teams direct routing & UC providers UK", why: "USD Teams/SBC carrier costs; GBP SME contract revenue", search_queries: ["Microsoft Teams direct routing provider UK", "Teams voice reseller UK B2B"], companies_house_terms: ["telecoms", "UC provider"] },
          { name: "VoIP & hosted phone system resellers UK", why: "Pay USD carrier interconnects; resell phone systems in GBP", search_queries: ["VoIP reseller UK business phone systems", "hosted phone system provider UK mid-market"], companies_house_terms: ["VoIP reseller", "telecoms reseller"] },
          { name: "Managed connectivity & SD-WAN providers UK", why: "International circuit costs in USD; GBP client contracts", search_queries: ["SD-WAN managed connectivity provider UK", "managed WAN services UK business"], companies_house_terms: ["connectivity provider", "network services"] },
          { name: "Broadband & SIP trunk resellers UK", why: "Wholesale SIP and broadband costs partially in USD/EUR", search_queries: ["SIP trunk reseller UK B2B", "business broadband reseller UK"], companies_house_terms: ["SIP reseller", "broadband reseller"] },
        ],
      },
      {
        segment_name: "Backup, DR & Data Centre Services",
        exposure_level: "High",
        exposure_type: "import_costs",
        likely_currency_pairs: ["GBP/USD"],
        affected_payment_flow: "GBP MRR / USD cloud storage and DR platform costs",
        why_affected: "Pay AWS S3, Azure Blob, Veeam, and Zerto licences in USD; bill UK clients monthly in GBP. Every GBP/USD move directly hits per-GB storage margins.",
        category_priority_score: 78,
        sales_angle: "USD cloud storage cost review — forward cover on AWS/Azure storage spend.",
        micro_categories: [
          { name: "Backup & disaster recovery service providers UK", why: "Veeam, Zerto, Datto USD licences; GBP-billed clients", search_queries: ["backup disaster recovery service provider UK", "managed backup services UK SME"], companies_house_terms: ["backup services", "DR provider"] },
          { name: "Data centre colocation providers UK", why: "Power and interconnect costs tied to USD wholesale prices", search_queries: ["data centre colocation UK mid-market", "co-location provider UK B2B"], companies_house_terms: ["data centre", "colocation"] },
        ],
      },
    ],
  },
  {
    headline: "Evergreen: UK cloud migration & digital transformation firms with USD exposure",
    segments: [
      {
        segment_name: "Cloud Migration & Digital Transformation",
        exposure_level: "Medium",
        exposure_type: "import_costs",
        likely_currency_pairs: ["GBP/USD"],
        affected_payment_flow: "GBP project revenue / USD cloud platform costs",
        why_affected: "Run client workloads on AWS/Azure during migration projects; cloud costs billed in USD against GBP fixed-price contracts.",
        category_priority_score: 78,
        sales_angle: "Cloud cost FX risk on fixed-price projects — USD overage vs GBP contract.",
        micro_categories: [
          { name: "Cloud migration consultancies UK", why: "AWS/Azure usage costs in USD during migration", search_queries: ["cloud migration services UK business", "AWS Azure migration company UK"], companies_house_terms: ["cloud migration", "cloud consultancy"] },
          { name: "Digital transformation agencies UK", why: "US platform and tooling costs vs GBP project budgets", search_queries: ["digital transformation company UK B2B", "digital transformation consultancy UK mid-market"], companies_house_terms: ["digital transformation", "technology consultancy"] },
          { name: "DevOps & platform engineering firms UK", why: "Cloud-native tooling in USD; GBP-billed client retainers", search_queries: ["DevOps consultancy UK B2B", "platform engineering company UK mid-market"], companies_house_terms: ["DevOps", "platform engineering"] },
        ],
      },
      {
        segment_name: "Cybersecurity Companies",
        exposure_level: "High",
        exposure_type: "import_costs",
        likely_currency_pairs: ["GBP/USD"],
        affected_payment_flow: "GBP revenue / USD security vendor costs",
        why_affected: "Buy US-priced security platforms (Palo Alto, CrowdStrike, SentinelOne, Fortinet) in USD; bill UK clients in GBP.",
        category_priority_score: 82,
        sales_angle: "USD security vendor cost review — rate lock before licence renewal.",
        micro_categories: [
          { name: "Cybersecurity resellers & MSSPs UK", why: "Palo Alto, CrowdStrike, Fortinet USD licensing", search_queries: ["managed security services UK mid-market", "MSSP UK cybersecurity company"], companies_house_terms: ["cybersecurity", "managed security"] },
          { name: "Penetration testing & security consultancies UK", why: "US tooling costs in USD; GBP-billed engagements", search_queries: ["penetration testing company UK B2B", "cybersecurity consultancy UK mid-market"], companies_house_terms: ["penetration testing", "security consultancy"] },
        ],
      },
    ],
  },
  // ── LOGISTICS & FREIGHT ───────────────────────────────────────────────────
  {
    headline: "Evergreen: UK freight forwarders & logistics companies with FX exposure",
    segments: [
      {
        segment_name: "Freight Forwarders & Logistics",
        exposure_level: "Medium",
        exposure_type: "multi_currency",
        likely_currency_pairs: ["GBP/EUR", "GBP/USD"],
        affected_payment_flow: "GBP revenue / multi-currency freight and port costs",
        why_affected: "Pay overseas port charges, agents, and carriers in EUR and USD. Also invoice clients in GBP for overseas shipments.",
        category_priority_score: 75,
        micro_categories: [
          { name: "UK freight forwarders", why: "", search_queries: ["freight forwarder UK import export", "customs broker UK trade"], companies_house_terms: ["freight forwarder", "customs broker"] },
          { name: "Shipping & logistics UK", why: "", search_queries: ["shipping agent UK import export", "logistics company UK overseas freight"], companies_house_terms: ["shipping agent", "logistics company"] },
        ],
      },
    ],
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────

export interface EvergreenOptions {
  dbPath?: string;
  runsDir?: string;
  force?: boolean;
}

export interface EvergreenResult {
  week: string;
  eventsInserted: number;
  eventsAlreadyPresent: number;
  discoverResult: Awaited<ReturnType<typeof runDiscoverStage>>;
}

export async function runEvergreenStage(opts: EvergreenOptions = {}): Promise<EvergreenResult> {
  const root = repoRoot();
  const dbPath = opts.dbPath ?? resolve(root, "data/fx.db");
  const runsDir = opts.runsDir ?? resolve(root, "data/runs");
  const force = !!opts.force;
  const week = isoWeek();

  const { sqlite, close } = getDb(dbPath);

  const insertEvent = sqlite.prepare(`
    INSERT OR IGNORE INTO events (id, status, data)
    VALUES (@id, @status, @data)
  `);

  let inserted = 0;
  let alreadyPresent = 0;

  sqlite.transaction(() => {
    for (let i = 0; i < PLAYBOOK.length; i++) {
      const entry = PLAYBOOK[i]!;
      const id = `evergreen-${week}-${i}`;

      if (!force) {
        const existing = sqlite.prepare("SELECT id FROM events WHERE id = ?").get(id) as { id: string } | undefined;
        if (existing) { alreadyPresent++; continue; }
      }

      const event: Partial<FxEvent> = {
        id,
        headline: entry.headline,
        source: "evergreen_playbook",
        source_url: "",
        detected_at: new Date().toISOString(),
        status: "ready",
        event_type: "evergreen",
        event_breadth: "broad_macro",
        trigger_strength: "strong",
        discovery_mode: "full",
        trigger_score: 80,
        recommended_query_budget: 20,
        urgency_score: 5,
        commercial_relevance: 8,
        commercial_relevance_reason: "evergreen_playbook",
        target_segments: entry.segments as Segment[],
        summary: entry.headline,
        business_impact_summary: "Recurring FX payment exposure — evergreen prospect discovery.",
        sales_angle: "Rate review on recurring foreign currency payments.",
        fallback_mode: false,
      };

      const row = sqlite.prepare("SELECT id FROM events WHERE id = ?").get(id) as { id: string } | undefined;
      if (row && force) {
        sqlite.prepare("UPDATE events SET status = @status, data = @data WHERE id = @id")
          .run({ id, status: "ready", data: JSON.stringify(event) });
        inserted++;
      } else if (!row) {
        insertEvent.run({ id, status: "ready", data: JSON.stringify(event) });
        inserted++;
      } else {
        alreadyPresent++;
      }
    }
  })();

  close();

  console.log(`evergreen: week=${week} | inserted=${inserted} | already_present=${alreadyPresent}`);

  // Run discover on the newly inserted evergreen events
  const discoverResult = await runDiscoverStage({
    dbPath,
    runsDir,
    // Use higher limits for evergreen — these are pre-validated high-fit categories
    maxSegments: 20,
    maxMicroCats: 4,
    maxQueriesPerMicroCat: 2,
    maxResultsPerQuery: 10,
    minScoreToScrape: 0, // all evergreen segments are pre-scored high
  });

  return { week, eventsInserted: inserted, eventsAlreadyPresent: alreadyPresent, discoverResult };
}

// CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const force = process.argv.includes("--force");
  runEvergreenStage({ force })
    .then((r) => {
      console.log(`evergreen done: ${r.discoverResult.leadsAdded} leads added`);
      process.exit(0);
    })
    .catch((e) => { console.error(e); process.exit(1); });
}
