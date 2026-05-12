/**
 * stages/enrich-contacts.ts — the "enrich-contacts" pipeline stage.
 *
 * For leads that have a website but no contact route yet (or --force), fetches the
 * homepage HTML (concurrently, with a TTL cache keyed by domain) and runs
 * @fx/core extractContactInfo → fills contact_phone / contact_phones /
 * contact_email / contact_emails_found / contact_page / about_page / team_page.
 * Then recomputes best_contact_route for *every* lead, writes leads back to the DB,
 * re-exports the {id:lead} JSON map, records a `runs` row.
 *
 * It is NOT a broad crawl: it only fetches the small set of leads that need it
 * (capped at --max), and re-uses cached results. The v2 `discover` stage will
 * eventually extract contacts inline during validation; this is the standalone
 * backfill (v2 equivalent of contacts.py being called from enrich_websites.py).
 *
 * CLI: tsx src/stages/enrich-contacts.ts [--db ...] [--out ...] [--runs ...]
 *        [--cache data/cache/website_html.json] [--limit 6] [--max 1000] [--force] [--timeout-ms 12000]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pLimit from "p-limit";

import {
  extractContactInfo, bestContactRoute, LeadSchema, FileCache,
  type Lead, type ContactInfo,
} from "@fx/core";
import { getDb, schema } from "@fx/core/db";
import { RunRecorder } from "../run.js";
import { fetchHtml as defaultFetchHtml, type HtmlFetcher } from "../sources/fetch.js";

export interface EnrichContactsOptions {
  dbPath?: string; outPath?: string; runsDir?: string; cachePath?: string;
  concurrency?: number; max?: number; force?: boolean; timeoutMs?: number;
  fetchHtml?: HtmlFetcher;   // injectable for tests
  persist?: boolean;
}
export interface EnrichContactsResult {
  totalLeads: number; needEnriching: number; fetched: number; ok: number; failed: number; cacheHits: number;
  withPhone: number; withEmail: number; withContactPage: number; withAnyRoute: number; runId: string;
}

function bareDomain(url: string | null | undefined): string {
  if (!url) return "";
  try { return new URL(url).hostname.toLowerCase().replace(/^www\d*\./, ""); } catch { return ""; }
}
function leadNeedsEnriching(l: Lead): boolean {
  return !!l.website && !(l.contact_phone || l.contact_email || (l.contact_emails_found?.length) || l.contact_page);
}
const CONTACT_KEYS = ["contact_phone", "contact_phones", "contact_email", "contact_emails_found", "contact_page", "about_page", "team_page"] as const;
function applyContactInfo(l: Lead, info: Partial<ContactInfo>): void {
  for (const k of CONTACT_KEYS) if (k in info) (l as Record<string, unknown>)[k] = (info as Record<string, unknown>)[k];
}

export async function runEnrichContactsStage(opts: EnrichContactsOptions = {}): Promise<EnrichContactsResult> {
  const root = process.cwd();
  const dbPath = opts.dbPath ?? resolve(root, "data/fx.db");
  const outPath = opts.outPath ?? resolve(root, "public/data/leads.json");
  const runsDir = opts.runsDir ?? resolve(root, "data/runs");
  const cachePath = opts.cachePath ?? resolve(root, "data/cache/website_html.json");
  const concurrency = opts.concurrency ?? 6;
  const max = opts.max ?? 1000;
  const force = !!opts.force;
  const timeoutMs = opts.timeoutMs ?? 12000;
  const fetcher = opts.fetchHtml ?? defaultFetchHtml;
  const persist = opts.persist ?? true;

  const { db, sqlite, close } = getDb(dbPath);
  const rec = new RunRecorder("enrich-contacts", { dbPath, outPath, concurrency, max, force });
  const cache = new FileCache(cachePath);          // caches extracted ContactInfo (or null on fetch failure), keyed by domain
  const TTL = 7 * 24 * 3600;

  try {
    const leads: Record<string, Lead> = {};
    for (const row of db.select().from(schema.leads).all()) {
      const p = LeadSchema.safeParse(row.data);
      leads[row.id] = p.success ? p.data : (row.data as Lead);
    }
    const candidates = Object.values(leads).filter((l) => (force ? !!l.website : leadNeedsEnriching(l))).slice(0, max);

    let fetched = 0, ok = 0, failed = 0, cacheHits = 0;
    const limit = pLimit(concurrency);
    await Promise.all(candidates.map((l) => limit(async () => {
      const dom = bareDomain(l.website);
      if (!force) {
        const { hit, value } = cache.lookup(`contact:${dom}`, TTL);
        if (hit) { cacheHits++; if (value && typeof value === "object") applyContactInfo(l, value as Partial<ContactInfo>); return; }
      }
      fetched++;
      const got = await fetcher(l.website!, timeoutMs);
      if (!got) { failed++; cache.store(`contact:${dom}`, null, true); return; }
      const info = extractContactInfo(got.html, got.finalUrl, dom);
      ok++;
      cache.store(`contact:${dom}`, info);
      applyContactInfo(l, info);
    })));

    for (const l of Object.values(leads)) l.best_contact_route = bestContactRoute(l);

    let withPhone = 0, withEmail = 0, withContactPage = 0, withAnyRoute = 0;
    for (const l of Object.values(leads)) {
      if (l.contact_phone) withPhone++;
      if (l.contact_email || l.contact_emails_found?.length) withEmail++;
      if (l.contact_page) withContactPage++;
      if (l.contact_phone || l.contact_email || l.contact_emails_found?.length || l.contact_page || l.director_name) withAnyRoute++;
    }

    if (persist) {
      const upd = sqlite.prepare(`UPDATE leads SET data=@data WHERE id=@id`);
      const tx = sqlite.transaction(() => { for (const l of Object.values(leads)) upd.run({ id: l.id, data: JSON.stringify(l) }); });
      tx();
      cache.flush(14 * 24 * 3600);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(leads, null, 2));
    }
    rec.section("contact_coverage", {
      total_leads: Object.keys(leads).length, need_enriching: candidates.length,
      fetched, ok, failed, cache_hits: cacheHits, with_phone: withPhone, with_email: withEmail,
      with_contact_page: withContactPage, with_any_route: withAnyRoute,
    });
    if (persist) rec.finish(sqlite, runsDir);

    return { totalLeads: Object.keys(leads).length, needEnriching: candidates.length, fetched, ok, failed, cacheHits, withPhone, withEmail, withContactPage, withAnyRoute, runId: rec.run.run_id };
  } finally {
    close();
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): EnrichContactsOptions {
  const o: EnrichContactsOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") o.dbPath = argv[++i];
    else if (a === "--out") o.outPath = argv[++i];
    else if (a === "--runs") o.runsDir = argv[++i];
    else if (a === "--cache") o.cachePath = argv[++i];
    else if (a === "--limit") o.concurrency = Number(argv[++i]);
    else if (a === "--max") o.max = Number(argv[++i]);
    else if (a === "--force") o.force = true;
    else if (a === "--timeout-ms") o.timeoutMs = Number(argv[++i]);
  }
  return o;
}
const isMain = (() => { try { return !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  runEnrichContactsStage(parseArgs(process.argv.slice(2))).then((r) => {
    console.log(`enrich-contacts: ${r.totalLeads} leads | needed ${r.needEnriching} | fetched ${r.fetched} (ok ${r.ok}, failed ${r.failed}, cache ${r.cacheHits})`);
    console.log(`  coverage: phone ${r.withPhone} | email ${r.withEmail} | contact-page ${r.withContactPage} | any-route ${r.withAnyRoute}`);
    console.log(`  run_id ${r.runId}`);
  }).catch((e) => { console.error("enrich-contacts failed:", e); process.exitCode = 1; });
}
