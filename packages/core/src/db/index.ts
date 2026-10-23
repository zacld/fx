/**
 * db/index.ts — open / create the SQLite database.
 *
 *   const { db, sqlite } = getDb("data/fx.db");   // or ":memory:" in tests
 *   db.select().from(schema.leads)...              // type-safe Drizzle queries
 *
 * ensureSchema runs CREATE TABLE IF NOT EXISTS — kept visually parallel with
 * ./schema.ts. (Move to drizzle-kit migrations once the schema settles.)
 */
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export { schema };
export * from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;
export interface DbHandle {
  db: Db;
  sqlite: Database.Database;
  close(): void;
}

const DDL = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  headline TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ready',
  event_type TEXT NOT NULL DEFAULT '',
  event_breadth TEXT NOT NULL DEFAULT 'sector_specific',
  urgency_score INTEGER NOT NULL DEFAULT 0,
  commercial_relevance INTEGER NOT NULL DEFAULT 0,
  detected_at TEXT,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL DEFAULT '',
  company_number TEXT,
  company_name TEXT NOT NULL DEFAULT 'Unknown',
  company_status TEXT,
  website TEXT,
  website_domain TEXT NOT NULL DEFAULT '',
  website_source TEXT,
  website_confidence TEXT,
  priority TEXT NOT NULL DEFAULT 'QUEUE',
  score INTEGER NOT NULL DEFAULT 0,
  exposure_level TEXT NOT NULL DEFAULT '',
  exposure_confidence TEXT NOT NULL DEFAULT 'none',
  lead_type TEXT NOT NULL DEFAULT 'unknown',
  segment_name TEXT NOT NULL DEFAULT '',
  is_large_org INTEGER NOT NULL DEFAULT 0,
  rescored_at TEXT,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_priority ON leads(priority);
CREATE INDEX IF NOT EXISTS idx_leads_company_number ON leads(company_number);
CREATE INDEX IF NOT EXISTS idx_leads_event_id ON leads(event_id);
CREATE INDEX IF NOT EXISTS idx_leads_website_domain ON leads(website_domain);

CREATE TABLE IF NOT EXISTS lead_evidence (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  company_number TEXT,
  event_id TEXT NOT NULL DEFAULT '',
  website_source TEXT,
  discovery_path TEXT,
  source_query TEXT NOT NULL DEFAULT '',
  source_segment TEXT NOT NULL DEFAULT '',
  source_micro_category TEXT NOT NULL DEFAULT '',
  source_page_url TEXT
);
CREATE INDEX IF NOT EXISTS idx_lead_evidence_lead_id ON lead_evidence(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_evidence_company_number ON lead_evidence(company_number);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  start_time TEXT NOT NULL,
  end_time TEXT,
  runtime_seconds INTEGER,
  mode TEXT NOT NULL DEFAULT 'daily',
  git_commit TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS crm (
  lead_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'new',
  last_contacted_at TEXT,
  contact_channel TEXT,
  touch_count INTEGER NOT NULL DEFAULT 0,
  next_follow_up_at TEXT,
  follow_up_reason TEXT NOT NULL DEFAULT '',
  suggested_next_action TEXT NOT NULL DEFAULT '',
  suggested_follow_up_ingredients TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  response_status TEXT NOT NULL DEFAULT 'no_response'
);
`;

export function ensureSchema(sqlite: Database.Database): void {
  sqlite.exec(DDL);
}

export function getDb(path = "data/fx.db"): DbHandle {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  ensureSchema(sqlite);
  const db = drizzle(sqlite, { schema });
  return { db, sqlite, close: () => sqlite.close() };
}
