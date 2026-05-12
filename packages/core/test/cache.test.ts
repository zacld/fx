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
});
