// The Accounts data in a database (Cloudflare D1, SQLite) — the move off one-big-item key-value storage (Zac, 14 Nov
// 2026: "go ahead with the database move"). Stage 1: a mirror. The workflows' stores stay the source; after each
// writes, scripts/db-sync.mjs copies what changed into these tables (only rows whose content changed, so the free
// plan's daily writes go a long way). Stage 2 serves the Accounts page from here, a page at a time, ranked by SQL.
//
// Shared by the Pages Functions (binding DB_BINDING) and the workflows (scripts/d1.mjs, Cloudflare's HTTP API), and
// tested on Node's own SQLite. `query(sql, params) -> rows` is the one thing each side provides.
export const DB_NAME = "fx-dashboard-db";
export const DB_BINDING = "FX_DB";

export const SCHEMA = [
  // One row per company on either list: `row` is what the list shows (JSON), `details` the long text only the company
  // page needs; the columns are what the page sorts and filters on.
  `CREATE TABLE IF NOT EXISTS companies (
     number TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, section TEXT, group_key TEXT,
     lead_score INTEGER, turnover_gbp REAL, filed_fx_score INTEGER, fx_niche TEXT, qualified TEXT, ruled_out TEXT,
     first_seen TEXT, updated_at TEXT NOT NULL, hash TEXT NOT NULL, row TEXT NOT NULL, details TEXT)`,
  "CREATE INDEX IF NOT EXISTS companies_score ON companies (lead_score DESC)",
  "CREATE INDEX IF NOT EXISTS companies_group ON companies (group_key)",
  "CREATE INDEX IF NOT EXISTS companies_section ON companies (section)",
  // Every alert, deal and customs moment: what the lead score and the Alerts tab read.
  `CREATE TABLE IF NOT EXISTS signals (
     id TEXT PRIMARY KEY, number TEXT NOT NULL, kind TEXT NOT NULL, at TEXT, title TEXT, detail TEXT,
     hot INTEGER NOT NULL DEFAULT 0, tracked INTEGER NOT NULL DEFAULT 0, source TEXT, hash TEXT NOT NULL, data TEXT)`,
  "CREATE INDEX IF NOT EXISTS signals_number ON signals (number)",
  "CREATE INDEX IF NOT EXISTS signals_at ON signals (at DESC)",
  // Zac's own marks: contacted (follow-ups), notes, verdicts, CRM checks, email drafts — one row each per company.
  `CREATE TABLE IF NOT EXISTS marks (
     number TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, hash TEXT NOT NULL, updated_at TEXT,
     PRIMARY KEY (number, kind))`,
  "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)",
];
// Columns added after the tables were first made (applySchema adds any that are missing): stage 2's precomputed
// outreach inputs — held (a serious reason not to progress) and why, the timely reason (cold call v email), the hit
// list flag, the hard-to-broker sector, and the lead score's parts (JSON) for the cards' "why".
export const COLUMNS = {
  companies: [["held", "INTEGER NOT NULL DEFAULT 0"], ["held_reason", "TEXT"], ["timely", "TEXT"], ["hit", "INTEGER NOT NULL DEFAULT 0"],
    ["shy", "TEXT"], ["lead", "TEXT"]],
};

// FNV-1a over the JSON text: a change detector, not a security hash.
export function hashOf(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0") + text.length.toString(36);
}

const num = (v) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

// A company as a table row. `row`: the list fields; `details`: the long text; `extra`: source, lead score, group,
// niche, ruled-out reason and first seen, from the ranking.
export function companyRecord(row, { source, details = null, score = null, groupKey = "", niche = "", ruledOut = "", held = "",
  timely = "", hit = false, shy = "", lead = null } = {}) {
  const record = {
    number: String(row.company_number), name: row.company_name || "", source, section: row.section || "",
    group_key: groupKey || String(row.company_number), lead_score: score === null ? null : Math.round(score),
    turnover_gbp: num(row.turnover_gbp), filed_fx_score: num(row.filed_fx_score), fx_niche: niche || row.fx_niche || "",
    qualified: row.qualified || "", ruled_out: ruledOut || "", first_seen: row.first_seen || "",
    row: JSON.stringify(row), details: details && Object.keys(details).length ? JSON.stringify(details) : null,
    held: held ? 1 : 0, held_reason: held || "", timely: timely || "", hit: hit ? 1 : 0, shy: shy || "", lead: lead ? JSON.stringify(lead) : null,
  };
  record.hash = hashOf([record.row, record.details, record.lead_score, record.group_key, record.fx_niche, record.ruled_out, record.source,
    record.held_reason, record.timely, record.hit, record.shy, record.lead]);
  return record;
}

export function signalRecord(s, source) {
  const record = {
    id: String(s.id || `${s.kind}:${s.company_number}:${s.at || ""}`), number: String(s.company_number), kind: s.kind || "",
    at: s.at || "", title: s.title || "", detail: s.detail ? String(s.detail) : "", hot: s.hot ? 1 : 0, tracked: s.tracked ? 1 : 0,
    source, data: JSON.stringify(s),
  };
  record.hash = hashOf(record.data);
  return record;
}

export function markRecord(number, kind, value) {
  const text = JSON.stringify(value);
  return { number: String(number), kind, value: text, hash: hashOf(text), updated_at: value?.at || "" };
}

// Batches of records, each batch's JSON under maxBytes (one bound parameter: D1 caps a value at 2 MB).
export function batches(records, maxBytes = 900_000) {
  const out = [];
  let cur = [];
  let size = 2;
  for (const r of records) {
    const n = JSON.stringify(r).length + 1;
    if (cur.length && size + n > maxBytes) { out.push(cur); cur = []; size = 2; }
    cur.push(r);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

const TABLES = {
  companies: { key: ["number"], cols: ["number", "name", "source", "section", "group_key", "lead_score", "turnover_gbp", "filed_fx_score",
    "fx_niche", "qualified", "ruled_out", "first_seen", "updated_at", "hash", "row", "details", "held", "held_reason", "timely", "hit", "shy", "lead"] },
  signals: { key: ["id"], cols: ["id", "number", "kind", "at", "title", "detail", "hot", "tracked", "source", "hash", "data"] },
  marks: { key: ["number", "kind"], cols: ["number", "kind", "value", "hash", "updated_at"] },
};

// INSERT … SELECT from one JSON array parameter (json_each): a whole batch in one statement, whatever its size in
// rows, within D1's 100-parameter limit.
export function upsertSql(table) {
  const { key, cols } = TABLES[table];
  const pick = cols.map((c) => `j.value ->> '$.${c}'`).join(", ");
  const set = cols.filter((c) => !key.includes(c)).map((c) => `${c} = excluded.${c}`).join(", ");
  return `INSERT INTO ${table} (${cols.join(", ")}) SELECT ${pick} FROM json_each(?1) AS j WHERE true ` +
    `ON CONFLICT (${key.join(", ")}) DO UPDATE SET ${set}`;
}

const keyOf = (table, r) => TABLES[table].key.map((k) => r[k]).join("\u0001");

// Makes `table` hold exactly `records`: writes the new and changed ones (by hash) and deletes the ones gone.
// {written, deleted, unchanged, total}. `scope` (SQL condition on the table) limits what a sync owns and may delete.
export async function syncTable(query, table, records, { now = new Date().toISOString(), scope = "", maxBytes } = {}) {
  const have = new Map((await query(`SELECT ${TABLES[table].key.join(", ")}, hash FROM ${table}${scope ? ` WHERE ${scope}` : ""}`))
    .map((r) => [keyOf(table, r), r.hash]));
  const seen = new Set();
  const changed = [];
  for (const r of records) {
    const k = keyOf(table, r);
    if (seen.has(k)) continue;
    seen.add(k);
    if (have.get(k) !== r.hash) changed.push(table === "companies" ? { ...r, updated_at: now } : r);
  }
  for (const b of batches(changed, maxBytes)) await query(upsertSql(table), [JSON.stringify(b)]);
  const gone = [...have.keys()].filter((k) => !seen.has(k));
  const { key } = TABLES[table];
  for (const b of batches(gone.map((k) => k.split("\u0001")), maxBytes)) {
    const match = key.map((c, i) => `${c} = j.value ->> '$[${i}]'`).join(" AND ");
    await query(`DELETE FROM ${table} WHERE EXISTS (SELECT 1 FROM json_each(?1) AS j WHERE ${match})`, [JSON.stringify(b)]);
  }
  return { written: changed.length, deleted: gone.length, unchanged: seen.size - changed.length, total: seen.size };
}

export async function applySchema(query) {
  for (const sql of SCHEMA) await query(sql, []);
  for (const [table, cols] of Object.entries(COLUMNS)) {
    const have = new Set((await query(`SELECT name FROM pragma_table_info('${table}')`, [])).map((c) => c.name));
    for (const [name, type] of cols) if (!have.has(name)) await query(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`, []);
  }
  await query("CREATE INDEX IF NOT EXISTS companies_outreach ON companies (held, lead_score DESC)", []);
}

// One of Zac's marks written as the page saves it (the store stays the source until stage 3); null deletes it.
export async function setMark(query, number, kind, value) {
  if (value === null || value === undefined) return query("DELETE FROM marks WHERE number = ?1 AND kind = ?2", [String(number), kind]);
  const m = markRecord(number, kind, value);
  return query("INSERT INTO marks (number, kind, value, hash, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) " +
    "ON CONFLICT (number, kind) DO UPDATE SET value = excluded.value, hash = excluded.hash, updated_at = excluded.updated_at",
    [m.number, m.kind, m.value, m.hash, m.updated_at]);
}

// The Outreach tab from the database: every lead not contacted (nor any company in its group), not ruled out,
// qualified out or marked Not a fit, and with no serious reason not to progress; one per group (its best lead);
// ranked by lead score. The top `letters` are the letter; past them, cold call when there's a timely reason, else the
// email sequence. {rows: [{…row, outreach_rank, why_now, lead, group_members}], count (in this list), total (ranked)}.
export async function outreachPage(query, { list = "letter", offset = 0, limit = 50, letters = 40 } = {}) {
  const live = `SELECT c.number, c.name, c.group_key, c.lead_score, c.timely, c.row, c.lead,
      ROW_NUMBER() OVER (PARTITION BY c.group_key ORDER BY c.lead_score DESC, c.name) AS in_group
    FROM companies c
    WHERE c.held = 0 AND c.ruled_out = '' AND c.qualified != 'Out'
      AND NOT EXISTS (SELECT 1 FROM marks m WHERE m.number = c.number AND m.kind = 'verdict' AND m.value ->> '$.verdict' = 'not_fit')
      AND NOT EXISTS (SELECT 1 FROM marks m JOIN companies c2 ON c2.number = m.number WHERE m.kind = 'contacted' AND c2.group_key = c.group_key)`;
  const ranked = `WITH live AS (${live}), ranked AS (SELECT *, ROW_NUMBER() OVER (ORDER BY lead_score DESC, name) AS pos FROM live WHERE in_group = 1)`;
  const where = list === "letter" ? "pos <= ?1" : list === "call" ? "pos > ?1 AND timely != ''" : "pos > ?1 AND timely = ''";
  const rows = await query(`${ranked}
    SELECT r.pos, r.number, r.timely, r.row, r.lead,
      (SELECT json_group_array(json_object('company_number', m.number, 'company_name', m.name)) FROM live m
         WHERE m.group_key = r.group_key AND m.number != r.number) AS members
    FROM ranked r WHERE ${where} ORDER BY r.pos LIMIT ?2 OFFSET ?3`, [letters, limit, offset]);
  const [counts] = await query(`${ranked} SELECT COUNT(*) AS total, SUM(pos <= ?1) AS letter,
      SUM(pos > ?1 AND timely != '') AS call, SUM(pos > ?1 AND timely = '') AS email,
      (SELECT COUNT(*) FROM companies WHERE held = 1 AND ruled_out = '' AND qualified != 'Out') AS held FROM ranked`, [letters]);
  const [synced] = await query("SELECT value FROM meta WHERE key = 'synced'");
  return {
    rows: rows.map((r) => {
      const lead = r.lead ? JSON.parse(r.lead) : {};
      const members = JSON.parse(r.members || "[]");
      return { ...JSON.parse(r.row), lead_score: lead.score ?? null, lead_parts: lead.parts || [], lead_flags: lead.flags || {},
               why_now: r.timely || "", outreach_rank: Number(r.pos), ...(members.length ? { group_members: members } : {}) };
    }),
    counts: { letter: Number(counts?.letter || 0), call: Number(counts?.call || 0), email: Number(counts?.email || 0), held: Number(counts?.held || 0) },
    total: Number(counts?.total || 0),
    synced_at: synced ? JSON.parse(synced.value).at || "" : "",
  };
}

// The binding inside a Pages Function as `query`.
export const d1Query = (db) => async (sql, params = []) => (await db.prepare(sql).bind(...params).all()).results || [];
