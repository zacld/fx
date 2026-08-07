/**
 * cache.ts — a generic TTL file cache. Pure local file I/O, no network.
 *
 * Generalisation of scripts/ch_cache.py — the v2 pipeline will use one of these
 * per external source (Companies House search, CH company, website fetches, …)
 * so repeat lookups within a run (and across runs, within TTL) cost nothing.
 *
 *   const cache = new FileCache("data/cache/companies_house.json");
 *   const { hit, value } = cache.lookup("wine importer|20", 7 * 86400);
 *   if (!hit) { const v = await fetchCh(...); cache.store("wine importer|20", v, v.length === 0); }
 *   ...later...
 *   cache.flush(14 * 86400);   // prune entries older than 14d, then write
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

interface Entry {
  ts: number;          // unix seconds
  key: string;
  value: unknown;
  empty?: boolean;     // was this a deliberately-cached empty/failed result?
  v?: number;          // schema version (entries with a different version are ignored)
}

interface CacheFile {
  __version?: number;
  __entries?: Record<string, Entry>;
  // legacy v0: keys are entry keys, values are Entry — accepted on load.
  [k: string]: unknown;
}

export const DEFAULT_TTL_SECONDS = 14 * 24 * 3600;

const now = () => Math.floor(Date.now() / 1000);

export class FileCache {
  private readonly path: string;
  private readonly version: number;
  private data: Record<string, Entry> = {};
  private loaded = false;
  private dirty = false;
  hits = 0;
  misses = 0;
  stores = 0;
  versionMismatches = 0;

  /**
   * @param path  JSON file location.
   * @param version  Schema version of the cached *values*. Bump this in the call
   *   site when the shape of stored values changes — stale entries from earlier
   *   versions are skipped on lookup and pruned on flush. Default 1.
   */
  constructor(path: string, version = 1) {
    this.path = path;
    this.version = version;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    try {
      if (existsSync(this.path)) {
        const parsed = JSON.parse(readFileSync(this.path, "utf8")) as CacheFile;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          // New layout: { __version, __entries }. Legacy layout: top-level keys are entries.
          if (parsed.__entries && typeof parsed.__entries === "object") {
            this.data = parsed.__entries as Record<string, Entry>;
          } else {
            // Migrate legacy in-memory: treat each top-level k → Entry. They'll get
            // `v` stamped on next store(); current-version reads still work as long
            // as the value shape is compatible.
            this.data = parsed as unknown as Record<string, Entry>;
          }
        }
      }
    } catch {
      this.data = {};
    }
    this.loaded = true;
  }

  /** Returns { hit, value }. `value` may be [] / null for a deliberately-cached empty result. */
  lookup(key: string, ttlSeconds: number = DEFAULT_TTL_SECONDS): { hit: boolean; value: unknown } {
    this.ensureLoaded();
    const k = String(key).trim().toLowerCase();
    const e = this.data[k];
    if (!e) { this.misses++; return { hit: false, value: undefined }; }
    if ((e.v ?? 0) !== this.version) { this.versionMismatches++; this.misses++; return { hit: false, value: undefined }; }
    if (now() - (e.ts ?? 0) >= ttlSeconds) { this.misses++; return { hit: false, value: undefined }; }
    this.hits++;
    return { hit: true, value: e.value };
  }

  store(key: string, value: unknown, empty = false): void {
    this.ensureLoaded();
    const k = String(key).trim().toLowerCase();
    this.data[k] = { ts: now(), key: k, value, empty, v: this.version };
    this.dirty = true;
    this.stores++;
  }

  /** Drop entries older than maxTtlSeconds or from a different schema version. Returns count removed. */
  prune(maxTtlSeconds: number = DEFAULT_TTL_SECONDS): number {
    this.ensureLoaded();
    const cutoff = now() - maxTtlSeconds;
    let removed = 0;
    for (const [k, e] of Object.entries(this.data)) {
      if ((e.ts ?? 0) <= cutoff || (e.v ?? 0) !== this.version) {
        delete this.data[k];
        removed++;
      }
    }
    if (removed) this.dirty = true;
    return removed;
  }

  /** Prune expired/stale entries, then write to disk if dirty. */
  flush(pruneTtlSeconds: number = DEFAULT_TTL_SECONDS): void {
    this.ensureLoaded();
    this.prune(pruneTtlSeconds);
    if (!this.dirty) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const payload: CacheFile = { __version: this.version, __entries: this.data };
    writeFileSync(this.path, JSON.stringify(payload, null, 2));
    this.dirty = false;
  }

  stats(): { entries: number; hits: number; misses: number; stores: number; versionMismatches: number } {
    this.ensureLoaded();
    return {
      entries: Object.keys(this.data).length,
      hits: this.hits, misses: this.misses, stores: this.stores,
      versionMismatches: this.versionMismatches,
    };
  }
}
