/**
 * stages/generate-drafts.ts — rule-based outreach ingredient generator.
 *
 * Produces three copy-ready fields per lead — call_opener, email_draft,
 * linkedin_note — using only data already on the lead and its event.
 * Zero AI calls. Per CLAUDE.md Priority 1 (cost control) and Priority 13
 * (outreach ingredients are ingredients, not auto-sent messages).
 *
 * Tone rules:
 *  - "it looks like…" / "may be worth reviewing…" / "if relevant…"
 *  - No overclaiming ("I know you're exposed")
 *  - No scare tactics
 *  - No financial advice
 *  - Soft, natural, low-pressure
 *  - Comply with Zac's voice: direct, credible, brief
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { getDb, schema } from "@fx/core/db";
import { LeadSchema, repoRoot, type Lead } from "@fx/core";
import { RunRecorder } from "../run.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface GenerateDraftsOptions {
  dbPath?: string;
  outPath?: string;
  runsDir?: string;
  force?: boolean;
  max?: number;
}

export interface GenerateDraftsResult {
  totalLeads: number;
  generated: number;
  skipped: number;
  runId: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Common English words that appear in website-extracted "names" — skip them.
const NOT_A_NAME = new Set([
  "sourcing", "specialist", "general", "manager", "director", "marketing",
  "sales", "accounts", "admin", "support", "info", "contact", "team",
  "group", "services", "solutions", "international", "imports", "exports",
  "trading", "limited", "ltd", "consulting", "holdings", "partners",
]);

function isPlausibleFirstName(name: string): boolean {
  if (!name || name.length < 2 || name.length > 20) return false;
  if (NOT_A_NAME.has(name.toLowerCase())) return false;
  // Must look like a proper noun (starts with capital, rest lower)
  if (!/^[A-Z][a-z'-]+$/.test(name)) return false;
  return true;
}

function firstName(lead: Lead): string {
  const dms = lead.decision_makers ?? [];
  // Prefer CH-sourced DMs — they have real CH-registered names
  const chDms = dms.filter((d) => d.source === "companies_house" || d.source === "ch+website");
  const candidates = chDms.length > 0 ? chDms : dms;
  const sorted = [...candidates].sort((a, b) => a.tier - b.tier);
  for (const dm of sorted) {
    const fn = (dm.first_name ?? "").trim();
    if (isPlausibleFirstName(fn)) return fn;
  }
  return "";
}

function bestEmailCandidate(lead: Lead): string {
  const dms = lead.decision_makers ?? [];
  const best = dms.find((d) => d.tier === 1) ?? dms.find((d) => d.tier === 2) ?? dms[0];
  if (!best) return "";
  const rec = best as Record<string, unknown>;
  if (typeof rec.email_candidate === "string" && rec.email_candidate) return rec.email_candidate;
  if (best.email) return best.email;
  const guesses = best.email_guesses ?? [];
  return guesses[0]?.email ?? "";
}

// Fragments that read poorly in "I noticed you appear to work with X"
const FRAGMENT_PREFIXES = /^(from |to |and |or |in |at |by |with |via |the |a |an )/i;

/** Pull the best readable evidence phrase (15–80 chars, no bare fragments). */
function evidenceSnippet(lead: Lead): string {
  const isReadable = (s: string) =>
    s.length >= 15 && s.length <= 80 && !FRAGMENT_PREFIXES.test(s);

  const fxSigs = (lead.fx_payment_signals ?? []).filter(isReadable).slice(0, 2);
  if (fxSigs.length) return fxSigs.join(" and ");

  const allEv = [
    ...(lead.supplier_evidence ?? []),
    ...(lead.import_export_evidence ?? []),
  ].filter(isReadable);
  if (allEv.length) return allEv[0]!;

  return "";
}

/** One-liner describing the payment flow exposure in plain English. */
function paymentFlowLine(lead: Lead): string {
  const flow = lead.affected_payment_flow || lead.fx_exposure || "";
  if (flow) return flow.toLowerCase().replace(/\.$/, "");
  const pair = lead.currency_pair || "";
  if (pair) return `${pair} exposure`;
  return "foreign currency exposure";
}

/** Short event description — not the full summary. Never starts with "recent". */
function eventLine(lead: Lead): string {
  // Prefer the trigger headline (shorter) over the full event summary
  const h = (lead.trigger_headline || lead.event_headline || "").trim();
  if (h && h.length < 120) {
    return h.replace(/\.$/, "").replace(/^recent\s+/i, "");
  }
  // Fallback: derive from event type + currency
  const pair = lead.currency_pair || "GBP";
  const et = (lead.event_type || "").toLowerCase();
  if (et.includes("weaken")) return `${pair} weakening`;
  if (et.includes("strengthen")) return `${pair} strengthening`;
  if (et.includes("rate") || et.includes("interest")) return `interest rate movements affecting ${pair}`;
  if (pair && pair !== "GBP") return `${pair} rate movements`;
  return "recent currency market moves";
}

/** Segment or sector label — keeps the email specific. */
function sectorLabel(lead: Lead): string {
  return (lead.segment_name || lead.source_segment || "").replace(/_/g, " ").toLowerCase();
}

function companyShort(lead: Lead): string {
  return (lead.company_name_clean || lead.company_name || "").trim();
}

// ── Draft builders ────────────────────────────────────────────────────────────

function buildCallOpener(lead: Lead): string {
  const co = companyShort(lead);
  const flow = paymentFlowLine(lead);
  const event = eventLine(lead);
  const fname = firstName(lead);
  const greeting = fname ? `Hi, could I speak to ${fname} please? ` : "Hi, could I speak to whoever handles your FX or overseas payments? ";
  return `${greeting}I'm calling from a currency brokerage — it looks like ${co} may have ${flow}, and given ${event}, it might be worth a quick conversation about the rate you're getting on those payments.`;
}

function buildEmailDraft(lead: Lead): string {
  const co = companyShort(lead);
  const fname = firstName(lead);
  const greeting = fname ? `Hi ${fname},` : "Hi,";
  const event = eventLine(lead);
  const flow = paymentFlowLine(lead);
  const pair = lead.currency_pair || "FX";

  // Opening line — use payment flow (reliable) not raw website scraping
  const openLine = `I came across ${co} — it looks like you may have ${flow}.`;

  // Second paragraph — why this matters now, softened per spec
  const body2 = `Given ${event}, that may create margin pressure around upcoming ${pair} payments. `
    + `A lot of businesses in this space don't always realise there's often a better rate available outside their bank.`;

  const subject = `${co} — ${pair} exposure`;

  const body = [
    greeting,
    "",
    openLine,
    "",
    body2,
    "",
    "Worth a quick chat to see whether there's a better way to manage the rate or timing?",
    "",
    "Best,",
    "Zac",
  ].join("\n");

  return `Subject: ${subject}\n\n${body}`;
}

function buildLinkedinNote(lead: Lead): string {
  const co = companyShort(lead);
  const fname = firstName(lead);
  const greeting = fname ? `Hi ${fname}` : "Hi";
  const pair = lead.currency_pair || "FX";
  const event = eventLine(lead);

  // Must be ≤300 chars
  const note = `${greeting} — I came across ${co} and thought the ${event} might be relevant if you have ${pair} payments. Worth a quick chat? I work with a number of similar businesses on the rate side.`;

  if (note.length <= 300) return note;
  // Trim gracefully if over limit
  return note.slice(0, 297) + "…";
}

// ── Main stage ────────────────────────────────────────────────────────────────

export async function runGenerateDraftsStage(opts: GenerateDraftsOptions = {}): Promise<GenerateDraftsResult> {
  const root = repoRoot();
  const dbPath = opts.dbPath ?? resolve(root, "data/fx.db");
  const outPath = opts.outPath ?? resolve(root, "data/leads.json");
  const runsDir = opts.runsDir ?? resolve(root, "data/runs");
  const force = !!opts.force;
  const max = opts.max ?? 9999;

  const { db, sqlite, close } = getDb(dbPath);
  const rec = new RunRecorder("generate-drafts", { dbPath, outPath, force });

  try {
    const rows = db.select().from(schema.leads).all();
    const update = sqlite.prepare("UPDATE leads SET data = ? WHERE id = ?");

    let generated = 0;
    let skipped = 0;

    const toProcess = rows
      .map((row) => {
        const p = LeadSchema.safeParse(row.data);
        return { id: row.id, lead: p.success ? p.data : (row.data as Lead) };
      })
      .filter(({ lead }) => {
        if (force) return true;
        // Skip if all three drafts already exist
        const l = lead as Record<string, unknown>;
        return !(l.call_opener && l.email_draft && l.linkedin_note);
      })
      .slice(0, max);

    sqlite.transaction(() => {
      for (const { id, lead } of toProcess) {
        const l = lead as Record<string, unknown>;
        l.call_opener   = buildCallOpener(lead);
        l.email_draft   = buildEmailDraft(lead);
        l.linkedin_note = buildLinkedinNote(lead);
        update.run(JSON.stringify(l), id);
        generated++;
      }
      skipped = rows.length - generated;
    })();

    rec.finish(sqlite, runsDir);
    console.log(`generate-drafts: ${rows.length} leads | generated ${generated} | skipped ${skipped}`);
    console.log(`  run_id ${rec.run.run_id}`);

    return { totalLeads: rows.length, generated, skipped, runId: rec.run.run_id };
  } finally {
    close();
  }
}

// CLI entry point
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const force = process.argv.includes("--force");
  runGenerateDraftsStage({ force })
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
}
