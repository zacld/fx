import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileCache } from "../src/cache.js";

describe("FileCache", () => {
  it("round-trips, is case/whitespace-insensitive, honours TTL, flushes to disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "fxcache-"));
    const path = join(dir, "ch.json");
    const c = new FileCache(path);

    expect(c.lookup("wine importer|20", 3600)).toEqual({ hit: false, value: undefined });

    c.store("wine importer|20", [{ company_number: "00123456" }]);
    const got = c.lookup("wine importer|20", 3600);
    expect(got.hit).toBe(true);
    expect(got.value).toEqual([{ company_number: "00123456" }]);

    // case/whitespace-insensitive key
    expect(c.lookup("  WINE IMPORTER|20 ", 3600).hit).toBe(true);

    // ttl=0 means everything is stale (strict <)
    expect(c.lookup("wine importer|20", 0).hit).toBe(false);

    // empty results can be cached deliberately
    c.store("no results|20", [], true);
    expect(c.lookup("no results|20", 3600)).toEqual({ hit: true, value: [] });

    c.flush();
    expect(existsSync(path)).toBe(true);

    // a fresh instance reads it back
    const c2 = new FileCache(path);
    expect(c2.lookup("wine importer|20", 3600).hit).toBe(true);
    expect(c2.stats().entries).toBe(2);
  });

  it("prune drops expired entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "fxcache-"));
    const c = new FileCache(join(dir, "x.json"));
    c.store("a", 1);
    c.store("b", 2);
    expect(c.prune(0)).toBe(2);          // ttl 0 → everything stale → removed
    expect(c.lookup("a", 3600).hit).toBe(false);
    expect(c.stats().entries).toBe(0);
  });

  it("tolerates a corrupt cache file", () => {
    const dir = mkdtempSync(join(tmpdir(), "fxcache-"));
    const path = join(dir, "bad.json");
    writeFileSync(path, "{ not valid json");
    const c = new FileCache(path);
    expect(c.lookup("anything", 3600).hit).toBe(false);
    c.store("ok", 42);
    c.flush();
    expect(new FileCache(path).lookup("ok", 3600)).toEqual({ hit: true, value: 42 });
  });

  it("version bump auto-invalidates entries written by the old version", () => {
    const dir = mkdtempSync(join(tmpdir(), "fxcache-"));
    const path = join(dir, "v.json");

    const v1 = new FileCache(path, 1);
    v1.store("k", { shape: "old" });
    v1.flush();
    expect(new FileCache(path, 1).lookup("k", 3600).hit).toBe(true);

    // Same file, version bumped — old entries are ignored, not returned with the wrong shape.
    const v2 = new FileCache(path, 2);
    expect(v2.lookup("k", 3600).hit).toBe(false);
    expect(v2.stats().versionMismatches).toBe(1);

    // Writing under v2 should overwrite cleanly.
    v2.store("k", { shape: "new" });
    v2.flush();
    expect(new FileCache(path, 2).lookup("k", 3600).value).toEqual({ shape: "new" });
  });

  it("reads legacy (pre-versioned) cache files without losing them", () => {
    // Pre-versioning, the file was just { <key>: Entry }. Those entries have no `v`,
    // so they should be treated as version 0 — invisible to a v1+ FileCache but
    // not lost (writing the file back uses the new layout).
    const dir = mkdtempSync(join(tmpdir(), "fxcache-"));
    const path = join(dir, "legacy.json");
    writeFileSync(path, JSON.stringify({
      "wine|20": { ts: Math.floor(Date.now() / 1000), key: "wine|20", value: [1, 2, 3] },
    }));

    const c = new FileCache(path, 1);
    // Legacy entry has no `v` → counts as mismatched.
    expect(c.lookup("wine|20", 3600).hit).toBe(false);
    expect(c.stats().versionMismatches).toBe(1);
  });
});
