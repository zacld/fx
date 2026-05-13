/**
 * schema.ts — THE data model for FX Discovery v2.
 *
 * zod schemas (runtime validation) + inferred TypeScript types (compile-time).
 * The pipeline stages take and return these; the dashboard reads them; the DB
 * tables mirror them. One definition — no more field drift.
 *
 * Faithful to the v1 lead/event shape (so the SQLite importer can ingest the
 * existing data/leads.json|events.json), but typed. Extra/legacy fields are
 * tolerated via .passthrough() on the top-level record schemas.
 */
import { z } from "zod";

// ── Enums ────────────────────────────────────────────────────────────────────
export const Priority = z.enum(["HOT", "WARM", "QUEUE", "SKIP"]);
export type Priority = z.infer<typeof Priority>;

export const WebsiteConfidence = z.enum(["high", "medium", "low", "confirmed", "none"]);
export type WebsiteConfidence = z.infer<typeof WebsiteConfidence>;

export const WebsiteSource = z.enum([
  "ddg_search", "bing_search", "domain_guess", "companies_house",
  "source_page", "manual", "collision_stripped", "unknown",
]);
export type WebsiteSource = z.infer<typeof WebsiteSource>;

export const DiscoveryPath = z.enum([
  "ddg", "bing", "ch_keyword", "ch_fallback", "domain_guess",
  "source_page_mined", "manual", "unknown",
]);
export type DiscoveryPath = z.infer<typeof DiscoveryPath>;

export const ExposureLevel = z.enum(["Very High", "High", "Medium", "Low"]);
export type ExposureLevel = z.infer<typeof ExposureLevel>;

export const EventBreadth = z.enum([
  "broad_currency", "broad_macro", "commodity", "tariff", "sector_specific",
]);
export type EventBreadth = z.infer<typeof EventBreadth>;

export const LeadType = z.enum(["trigger_exposed", "evergreen_saving", "both", "unknown"]);
export type LeadType = z.infer<typeof LeadType>;

export const Confidence3 = z.enum(["high", "medium", "low", "none"]);
export type Confidence3 = z.infer<typeof Confidence3>;

// ── Brain 2: micro-categories & segments ─────────────────────────────────────
export const MicroCategorySchema = z.object({
  name: z.string(),
  why: z.string().default(""),
  search_queries: z.array(z.string()).default([]),
  companies_house_terms: z.array(z.string()).default([]),
}).passthrough();
export type MicroCategory = z.infer<typeof MicroCategorySchema>;

export const SegmentSchema = z.object({
  segment_name: z.string(),
  business_model: z.string().default(""),
  exposure_level: z.union([ExposureLevel, z.literal("")]).default(""),
  exposure_type: z.string().default(""),
  likely_currency_pairs: z.array(z.string()).default([]),
  why_affected: z.string().default(""),
  why_financially_exposed: z.string().default(""),
  fx_payment_logic: z.string().default(""),
  margin_risk: z.string().default(""),
  payment_timing_risk: z.string().default(""),
  affected_payment_flow: z.string().default(""),
  ideal_company_profile: z.string().default(""),
  category_priority_score: z.number().int().min(0).max(100).optional(),
  micro_categories: z.array(MicroCategorySchema).default([]),
  high_intent_search_queries: z.array(z.string()).default([]),
  companies_house_terms: z.array(z.string()).default([]),
  website_validation_signals: z.array(z.string()).default([]),
  segment_signals: z.array(z.string()).default([]),
  avoid_segments: z.array(z.string()).default([]),
  sales_angle: z.string().default(""),
  exposure_thesis_template: z.string().default(""),
}).passthrough();
export type Segment = z.infer<typeof SegmentSchema>;

// ── Brain 1: events ──────────────────────────────────────────────────────────
export const EventSchema = z.object({
  id: z.string(),
  headline: z.string(),
  source: z.string().default(""),
  source_url: z.string().default(""),
  detected_at: z.string().optional(),
  status: z.enum(["ready", "discovered", "low_relevance"]).default("ready"),
  event_type: z.string().default(""),
  event_breadth: z.union([EventBreadth, z.literal("")]).default("sector_specific"),
  currency_pairs: z.array(z.string()).default([]),
  urgency_score: z.number().int().min(0).max(10).default(0),
  commercial_relevance: z.number().int().min(0).max(10).default(0),
  commercial_relevance_reason: z.string().default(""),
  what_happened: z.string().default(""),
  what_changed_financially: z.string().default(""),
  who_pays_more: z.string().default(""),
  who_receives_less: z.string().default(""),
  affected_payment_flow: z.string().default(""),
  fx_payment_logic: z.string().default(""),
  margin_risk: z.string().default(""),
  payment_timing_risk: z.string().default(""),
  business_impact_summary: z.string().default(""),
  sales_angle: z.string().default(""),
  overall_sales_angle: z.string().default(""),
  summary: z.string().default(""),
  ai_provider: z.string().default(""),
  fallback_mode: z.boolean().default(false),
  target_segments: z.array(SegmentSchema).default([]),
  companies_house_terms: z.array(z.string()).default([]),
  all_search_queries: z.array(z.string()).default([]),
}).passthrough();
export type FxEvent = z.infer<typeof EventSchema>;

// ── Contact routes (from contacts.py) ────────────────────────────────────────
export const ContactFieldsSchema = z.object({
  contact_phone: z.string().nullable().default(null),
  contact_phones: z.array(z.string()).default([]),
  contact_email: z.string().nullable().default(null),
  contact_emails_found: z.array(z.string()).default([]),
  contact_page: z.string().nullable().default(null),
  about_page: z.string().nullable().default(null),
  team_page: z.string().nullable().default(null),
  best_contact_route: z.string().default(""),
});
export type ContactFields = z.infer<typeof ContactFieldsSchema>;

// ── Decision-maker enrichment (= scripts/legacy/enrich_decision_makers.py) ───
// Tier 1 = primary FX conversation targets (FD/CFO/MD/CEO/Owner).
// Tier 2 = secondary (Commercial/Ops/Procurement/Sales/Accounts Manager).
// Tier 3 = generic Director / Company Secretary / Non-Executive fallback.
export const PersonTier = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type PersonTier = z.infer<typeof PersonTier>;

export const EmailSource = z.enum([
  "website_page",          // explicit mailto: on the company's own pages
  "website_email_found",   // on-domain email whose local-part matches a known name
  "smtp_verified",         // SMTP RCPT verified one of the generated patterns
  "pattern_inferred",      // learned domain pattern (e.g. acme uses first.last@)
  "ch_director",           // surfaced via Companies House director → contact_email
]);
export type EmailSource = z.infer<typeof EmailSource>;

export const EmailGuessSchema = z.object({
  email: z.string(),
  pattern: z.string().default(""),       // e.g. "{first}.{last}@"
  smtp_verified: z.boolean().nullable().default(null),
  catch_all: z.boolean().default(false),
  pattern_confidence: z.number().min(0).max(1).default(0),   // domain-pattern inference
}).passthrough();
export type EmailGuess = z.infer<typeof EmailGuessSchema>;

export const DecisionMakerSchema = z.object({
  name: z.string(),
  first_name: z.string().default(""),
  last_name: z.string().default(""),
  role: z.string().default(""),
  tier: PersonTier.default(3),
  tier_label: z.enum(["Primary", "Secondary", "Fallback"]).default("Fallback"),
  appointed_on: z.string().nullable().default(null),
  email: z.string().nullable().default(null),
  email_source: EmailSource.nullable().default(null),
  email_verified: z.boolean().nullable().default(null),
  email_guesses: z.array(EmailGuessSchema).default([]),
  phone: z.string().nullable().default(null),
  linkedin_search: z.string().nullable().default(null),
  linkedin_name_only: z.string().nullable().default(null),
  google_email_search: z.string().nullable().default(null),
  source: z.enum(["companies_house", "website_only", "ch+website"]).default("companies_house"),
}).passthrough();
export type DecisionMaker = z.infer<typeof DecisionMakerSchema>;

export const RouteGrade = z.enum(["A", "B", "C", "D", "E", "F"]);
export type RouteGrade = z.infer<typeof RouteGrade>;

// ── Website intelligence (= scripts/legacy/enrich_website_intelligence.py) ───
export const WebsiteIntelSchema = z.object({
  fx_evidence_snippets: z.array(z.string()).default([]),
  country_evidence: z.array(z.string()).default([]),
  supplier_evidence: z.array(z.string()).default([]),
  import_export_evidence: z.array(z.string()).default([]),
  inferred_currency_pairs: z.array(z.string()).default([]),
  currency_reason: z.string().default(""),
  size_signals: z.array(z.string()).default([]),
  tech_signals: z.array(z.string()).default([]),     // Shopify, multi-currency switcher, etc.
  fx_likelihood_score: z.number().int().min(0).max(100).default(0),
  website_confidence_reason: z.string().default(""),
  // Social proof — surfaced by enrich-website-intel.
  trustpilot_reviews: z.number().int().nullable().default(null),
  trustpilot_score: z.number().nullable().default(null),
  trustpilot_search_url: z.string().nullable().default(null),
  press_search_url: z.string().nullable().default(null),
});
export type WebsiteIntel = z.infer<typeof WebsiteIntelSchema>;

// ── Decision-maker overlay applied to a lead ─────────────────────────────────
export const DecisionMakerFieldsSchema = z.object({
  decision_makers: z.array(DecisionMakerSchema).default([]),
  route_grade: RouteGrade.default("F"),
  contact_confidence: z.number().int().min(0).max(100).default(0),
  company_linkedin: z.string().nullable().default(null),
  company_name_clean: z.string().default(""),
});
export type DecisionMakerFields = z.infer<typeof DecisionMakerFieldsSchema>;

// ── Companies House extras (PSCs / filings / charges) ────────────────────────
export const PSCSchema = z.object({
  name: z.string(),
  kind: z.string().default(""),
  natures_of_control: z.array(z.string()).default([]),
  notified_on: z.string().nullable().default(null),
}).passthrough();
export type PSC = z.infer<typeof PSCSchema>;

export const ChExtrasSchema = z.object({
  psc: z.array(PSCSchema).default([]),
  recent_filings: z.array(z.object({
    type: z.string(),
    description: z.string().default(""),
    date: z.string().nullable().default(null),
  })).default([]),
  charges_count: z.number().int().default(0),
  charges_outstanding: z.number().int().default(0),
  accounts_turnover_band: z.string().default(""),   // "<1m" / "1-5m" / "5-25m" / "25m+" / ""
});
export type ChExtras = z.infer<typeof ChExtrasSchema>;

// ── Provenance / source-evidence ─────────────────────────────────────────────
export const LeadEvidenceSchema = z.object({
  website_source: z.union([WebsiteSource, z.string()]).optional(),
  discovery_path: z.union([DiscoveryPath, z.string()]).optional(),
  source_query: z.string().default(""),
  source_segment: z.string().default(""),
  source_micro_category: z.string().default(""),
  source_page_url: z.string().optional(),
}).passthrough();
export type LeadEvidence = z.infer<typeof LeadEvidenceSchema>;

// ── Leads ────────────────────────────────────────────────────────────────────
// Faithful to the v1 lead dict (discover.py / rescore.py / contacts.py). Almost
// everything is optional so the importer accepts existing data; the *scorer*
// (scoring.ts) reads a typed subset and is strict about that subset.
export const LeadSchema = z.object({
  id: z.string(),
  event_id: z.string().default(""),
  linked_event_ids: z.array(z.string()).default([]),
  created_at: z.string().optional(),
  rescored_at: z.string().optional(),

  // identity
  company_name: z.string().default("Unknown"),
  company_number: z.string().nullable().default(null),
  company_status: z.string().nullable().default(null),
  company_type: z.string().nullable().default(null),
  address: z.string().default(""),
  incorporated: z.string().nullable().default(null),
  sic_codes: z.array(z.string()).default([]),
  director_name: z.string().nullable().default(null),
  director_role: z.string().nullable().default(null),
  is_large_org: z.boolean().default(false),

  // website
  website: z.string().nullable().default(null),
  website_domain: z.string().default(""),
  website_confidence: z.union([WebsiteConfidence, z.string()]).nullable().default(null),
  website_source: z.union([WebsiteSource, z.string()]).nullable().default(null),
  discovery_path: z.union([DiscoveryPath, z.string()]).optional(),
  source_query: z.string().default(""),
  source_segment: z.string().default(""),
  source_page_url: z.string().optional(),
  website_snippet: z.string().default(""),
  duplicate_sources: z.array(LeadEvidenceSchema).default([]),

  // website evidence / signals
  fx_payment_signals: z.array(z.string()).default([]),
  fx_origin_hints: z.array(z.string()).default([]),
  b2b_signals: z.array(z.string()).default([]),
  secondary_signals: z.array(z.string()).default([]),
  segment_signals: z.array(z.string()).default([]),
  pays_fx_confirmed: z.boolean().default(false),
  signal_count: z.number().int().default(0),

  // segment / event context (Brain 2 / Brain 1)
  company_source: z.string().default("companies_house"),
  segment_name: z.string().default(""),
  segment_business_model: z.string().default(""),
  exposure_level: z.union([ExposureLevel, z.literal("")]).default(""),
  exposure_type: z.string().default(""),
  why_affected: z.string().default(""),
  why_financially_exposed: z.string().default(""),
  margin_risk: z.string().default(""),
  payment_timing_risk: z.string().default(""),
  affected_payment_flow: z.string().default(""),
  trigger_headline: z.string().default(""),
  event_type: z.string().default(""),
  business_impact_summary: z.string().default(""),
  fx_exposure: z.string().default(""),
  fx_payment_logic: z.string().default(""),
  fx_reason: z.string().default(""),
  exposure_thesis: z.string().default(""),
  exposure_confidence: Confidence3.default("none"),

  // scoring
  score: z.number().int().min(0).max(100).default(0),
  priority: Priority.default("QUEUE"),
  scoring_reasons: z.array(z.string()).default([]),
  lead_type: LeadType.default("unknown"),
  awareness_level: Confidence3.default("low"),
  saving_opportunity: Confidence3.default("low"),
  multi_event_trigger: z.boolean().default(false),
  multi_event_count: z.number().int().default(1),

  // sales context
  sales_angle: z.string().default(""),
  suggested_next_step: z.string().default(""),
  guessed_emails: z.array(z.object({ pattern: z.string(), email: z.string() })).default([]),
  generic_emails: z.array(z.object({ pattern: z.string(), email: z.string() })).default([]),

  status: z.string().default("new"),
})
  .merge(ContactFieldsSchema.partial())
  .merge(DecisionMakerFieldsSchema.partial())
  .merge(WebsiteIntelSchema.partial())
  .merge(ChExtrasSchema.partial())
  .passthrough();
export type Lead = z.infer<typeof LeadSchema>;

// ── Run history (= Priority 3) ───────────────────────────────────────────────
export const RunSchema = z.object({
  run_id: z.string(),
  start_time: z.string(),
  end_time: z.string().optional(),
  runtime_seconds: z.number().optional(),
  mode: z.string().default("daily"),
  git_commit: z.string().default(""),
  config: z.record(z.string(), z.unknown()).default({}),
  events: z.array(z.record(z.string(), z.unknown())).default([]),
  segment_stats: z.record(z.string(), z.unknown()).default({}),
  source_stats: z.record(z.string(), z.unknown()).default({}),
  lead_stats: z.record(z.string(), z.unknown()).default({}),
  gate_stats: z.record(z.string(), z.unknown()).default({}),
  contact_coverage: z.record(z.string(), z.unknown()).default({}),
  top_leads: z.array(z.record(z.string(), z.unknown())).default([]),
  warnings: z.array(z.string()).default([]),
  errors: z.array(z.string()).default([]),
}).passthrough();
export type Run = z.infer<typeof RunSchema>;

// ── CRM / follow-up (= CLAUDE.md Priority 15) ────────────────────────────────
export const CrmStatus = z.enum([
  "new", "reviewed", "saved", "contacted", "follow_up_due", "followed_up",
  "replied", "meeting_booked", "not_relevant", "passed_to_closer", "nurture", "paused",
]);
export type CrmStatus = z.infer<typeof CrmStatus>;

export const ContactChannel = z.enum(["linkedin", "email", "phone", "in_person"]);
export type ContactChannel = z.infer<typeof ContactChannel>;

export const ResponseStatus = z.enum(["no_response", "replied", "booked", "not_interested"]);
export type ResponseStatus = z.infer<typeof ResponseStatus>;

export const CrmRecordSchema = z.object({
  lead_id: z.string(),
  status: CrmStatus.default("new"),
  last_contacted_at: z.string().nullable().default(null),
  contact_channel: ContactChannel.nullable().default(null),
  touch_count: z.number().int().default(0),
  next_follow_up_at: z.string().nullable().default(null),
  follow_up_reason: z.string().default(""),
  suggested_next_action: z.string().default(""),
  suggested_follow_up_ingredients: z.string().default(""),
  notes: z.string().default(""),
  response_status: ResponseStatus.default("no_response"),
}).passthrough();
export type CrmRecord = z.infer<typeof CrmRecordSchema>;

// Helpers
export function parseLead(raw: unknown): Lead {
  return LeadSchema.parse(raw);
}
export function safeParseLead(raw: unknown) {
  return LeadSchema.safeParse(raw);
}
