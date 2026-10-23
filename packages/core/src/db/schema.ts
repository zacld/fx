/**
 * db/schema.ts — Drizzle SQLite table definitions for FX Discovery v2.
 *
 * Mirrors the zod schemas in ../schema.ts. The "rich" / rarely-queried fields are
 * stored as a `data` JSON column (the full validated object); the things we filter
 * / sort / join on get real columns. `lead_evidence` is fully columnar — it's the
 * dedup-by-JOIN table (Priority 4).
 *
 * The raw DDL that creates these tables lives in ./index.ts (ensureSchema) — kept
 * visually parallel with this file. Switch to drizzle-kit migrations later.
 */
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import type { FxEvent, Lead, Run } from "../schema.js";

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  headline: text("headline").notNull().default(""),
  status: text("status").notNull().default("ready"),
  event_type: text("event_type").notNull().default(""),
  event_breadth: text("event_breadth").notNull().default("sector_specific"),
  urgency_score: integer("urgency_score").notNull().default(0),
  commercial_relevance: integer("commercial_relevance").notNull().default(0),
  detected_at: text("detected_at"),
  data: text("data", { mode: "json" }).$type<FxEvent>().notNull(),
}, (t) => ({
  byStatus: index("idx_events_status").on(t.status),
}));

export const leads = sqliteTable("leads", {
  id: text("id").primaryKey(),
  event_id: text("event_id").notNull().default(""),
  company_number: text("company_number"),
  company_name: text("company_name").notNull().default("Unknown"),
  company_status: text("company_status"),
  website: text("website"),
  website_domain: text("website_domain").notNull().default(""),
  website_source: text("website_source"),
  website_confidence: text("website_confidence"),
  priority: text("priority").notNull().default("QUEUE"),
  score: integer("score").notNull().default(0),
  exposure_level: text("exposure_level").notNull().default(""),
  exposure_confidence: text("exposure_confidence").notNull().default("none"),
  lead_type: text("lead_type").notNull().default("unknown"),
  segment_name: text("segment_name").notNull().default(""),
  is_large_org: integer("is_large_org", { mode: "boolean" }).notNull().default(false),
  rescored_at: text("rescored_at"),
  data: text("data", { mode: "json" }).$type<Lead>().notNull(),
}, (t) => ({
  byPriority: index("idx_leads_priority").on(t.priority),
  byCompanyNumber: index("idx_leads_company_number").on(t.company_number),
  byEvent: index("idx_leads_event_id").on(t.event_id),
  byDomain: index("idx_leads_website_domain").on(t.website_domain),
}));

export const leadEvidence = sqliteTable("lead_evidence", {
  id: text("id").primaryKey(),                // sha(lead_id|website_source|source_query|event_id)
  lead_id: text("lead_id").notNull(),
  company_number: text("company_number"),
  event_id: text("event_id").notNull().default(""),
  website_source: text("website_source"),
  discovery_path: text("discovery_path"),
  source_query: text("source_query").notNull().default(""),
  source_segment: text("source_segment").notNull().default(""),
  source_micro_category: text("source_micro_category").notNull().default(""),
  source_page_url: text("source_page_url"),
}, (t) => ({
  byLead: index("idx_lead_evidence_lead_id").on(t.lead_id),
  byCompanyNumber: index("idx_lead_evidence_company_number").on(t.company_number),
}));

export const runs = sqliteTable("runs", {
  run_id: text("run_id").primaryKey(),
  start_time: text("start_time").notNull(),
  end_time: text("end_time"),
  runtime_seconds: integer("runtime_seconds"),
  mode: text("mode").notNull().default("daily"),
  git_commit: text("git_commit").notNull().default(""),
  data: text("data", { mode: "json" }).$type<Run>().notNull(),
});

export const crm = sqliteTable("crm", {
  lead_id: text("lead_id").primaryKey(),
  status: text("status").notNull().default("new"),
  last_contacted_at: text("last_contacted_at"),
  contact_channel: text("contact_channel"),
  touch_count: integer("touch_count").notNull().default(0),
  next_follow_up_at: text("next_follow_up_at"),
  follow_up_reason: text("follow_up_reason").notNull().default(""),
  suggested_next_action: text("suggested_next_action").notNull().default(""),
  suggested_follow_up_ingredients: text("suggested_follow_up_ingredients").notNull().default(""),
  notes: text("notes").notNull().default(""),
  response_status: text("response_status").notNull().default("no_response"),
});

export const allTables = { events, leads, leadEvidence, runs, crm };
