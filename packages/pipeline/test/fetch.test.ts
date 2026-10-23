import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileCache } from "@fx/core";
import { createCachedFetcher, withHostGate, _resetHostGatesForTests } from "../src/sources/fetch.js";

beforeEach(() => { _resetHostGatesForTests(); });

describe("withHostGate", () => {
  it("serialises calls to the same host with the configured spacing", async () => {
    const starts: number[] = [];
    const work = async () => { starts.push(Date.now()); await new Promise((r) => setTimeout(r, 20)); };

    await Promise.all([
      withHostGate("https://acme.co.uk/a", 200, work),
      withHostGate("https://acme.co.uk/b", 200, work),
      withHostGate("https://acme.co.uk/c", 200, work),
    ]);

    expect(starts.length).toBe(3);
    // Each subsequent call should start at least ~minInterval after the previous one
    // (minInterval is measured from when the previous call *finished* — work takes 20ms).
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(150);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(150);
  });

  it("different hosts run in parallel", async () => {
    const t0 = Date.now();
    const work = () => new Promise((r) => setTimeout(r, 50));
    await Promise.all([
      withHostGate("https://acme.co.uk/", 500, () => work()),
      withHostGate("https://bravo.co.uk/", 500, () => work()),
      withHostGate("https://charlie.co.uk/", 500, () => work()),
    ]);
    const elapsed = Date.now() - t0;
    // ~50ms in parallel, not 150ms+ serialised
    expect(elapsed).toBeLessThan(200);
  });
});

describe("createCachedFetcher", () => {
  it("hits the network once and serves the next caller from cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fxfetch-"));
    const cache = new FileCache(join(dir, "pages.json"));
    // Stub global fetch
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("<html><body>hi</body></html>", { status: 200, headers: { "content-type": "text/html" } }),
    );

    const f = createCachedFetcher({ cache, hostIntervalMs: 0 });
    const first = await f.fetch("https://acme.co.uk/");
    const second = await f.fetch("https://acme.co.uk/");

    expect(first?.html).toContain("hi");
    expect(second?.html).toContain("hi");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(f.stats()).toMatchObject({ hits: 1, misses: 1, networkOk: 1 });

    fetchSpy.mockRestore();
  });

  it("caches failures (negative cache) so retries don't hammer dead URLs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fxfetch-"));
    const cache = new FileCache(join(dir, "pages.json"));
    const fetchSpy = vi.spyOn(global, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const f = createCachedFetcher({ cache, hostIntervalMs: 0 });
    expect(await f.fetch("https://dead.example/")).toBeNull();
    expect(await f.fetch("https://dead.example/")).toBeNull();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(f.stats().networkFail).toBe(1);

    fetchSpy.mockRestore();
  });

  it("bypass: true skips read but still writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fxfetch-"));
    const cache = new FileCache(join(dir, "pages.json"));
    let body = "<html>v1</html>";
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () =>
      new Response(body, { status: 200, headers: { "content-type": "text/html" } }),
    );

    const f1 = createCachedFetcher({ cache, hostIntervalMs: 0 });
    await f1.fetch("https://acme.co.uk/");
    body = "<html>v2</html>";

    const f2 = createCachedFetcher({ cache, hostIntervalMs: 0, bypass: true });
    const got = await f2.fetch("https://acme.co.uk/");
    expect(got?.html).toContain("v2");
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // After bypass write, the next non-bypass caller should see v2
    const f3 = createCachedFetcher({ cache, hostIntervalMs: 0 });
    expect((await f3.fetch("https://acme.co.uk/"))?.html).toContain("v2");
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    fetchSpy.mockRestore();
  });

  it("truncates HTML over maxHtmlBytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fxfetch-"));
    const cache = new FileCache(join(dir, "pages.json"));
    const big = "x".repeat(2000);
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(big, { status: 200, headers: { "content-type": "text/html" } }),
    );

    const f = createCachedFetcher({ cache, hostIntervalMs: 0, maxHtmlBytes: 100 });
    const got = await f.fetch("https://acme.co.uk/");
    expect(got?.html.length).toBe(100);

    fetchSpy.mockRestore();
  });
});
