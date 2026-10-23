/**
 * run.ts — tiny pipeline-run recorder. Writes a `runs` row in SQLite and a
 * timestamped JSON copy under data/runs/. (DB-backed version of the v1 run-summary
 * idea — see scripts/run_logger.py on the parallel branch; v2 stages call this so
 * QA can compare runs.)
 */
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { Run } from "@fx/core";

function gitCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

function runId(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

export class RunRecorder {
  readonly run: Run;
  private readonly start = Date.now();

  constructor(mode: string, config: Record<string, unknown> = {}) {
    this.run = {
      run_id: runId(), start_time: new Date().toISOString(), mode,
      git_commit: gitCommit(), config,
      events: [], segment_stats: {}, source_stats: {}, lead_stats: {},
      gate_stats: {}, contact_coverage: {}, top_leads: [], warnings: [], errors: [],
    };
  }

  /** Merge `data` into a record-valued section (lead_stats, source_stats, …). */
  section(name: "segment_stats" | "source_stats" | "lead_stats" | "gate_stats" | "contact_coverage" | "config", data: Record<string, unknown>): void {
    this.run[name] = { ...(this.run[name] as Record<string, unknown>), ...data };
  }
  warn(msg: string): void { this.run.warnings.push(msg); }
  error(msg: string): void { this.run.errors.push(msg); }
  topLeads(rows: Array<Record<string, unknown>>): void { this.run.top_leads = rows; }
  setEvents(rows: Array<Record<string, unknown>>): void { this.run.events = rows; }

  /** Finalise: stamp end time, write to the `runs` table and to data/runs/<id>.json. */
  finish(sqlite: Database.Database, runsDir = "data/runs"): Run {
    this.run.end_time = new Date().toISOString();
    this.run.runtime_seconds = Math.round((Date.now() - this.start) / 1000);
    sqlite.prepare(
      `INSERT OR REPLACE INTO runs (run_id, start_time, end_time, runtime_seconds, mode, git_commit, data)
       VALUES (@run_id, @start_time, @end_time, @runtime_seconds, @mode, @git_commit, @data)`,
    ).run({
      run_id: this.run.run_id, start_time: this.run.start_time, end_time: this.run.end_time ?? null,
      runtime_seconds: this.run.runtime_seconds ?? null, mode: this.run.mode, git_commit: this.run.git_commit,
      data: JSON.stringify(this.run),
    });
    try {
      mkdirSync(runsDir, { recursive: true });
      writeFileSync(join(runsDir, `${this.run.run_id}.json`), JSON.stringify(this.run, null, 2));
    } catch { /* non-fatal */ }
    return this.run;
  }
}
