import { describe, expect, it } from "vitest";
import { handle } from "../netlify/functions/market.mjs";

describe("/api/market", () => {
  it("serves the latest moves, never cached; 404 before the first run", async () => {
    const data = { as_of: "2026-10-21", currencies: [] };
    const ok = await handle(new Request("https://x/api/market"), { store: () => ({ get: async () => data }) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect((await ok.json()).as_of).toBe("2026-10-21");
    expect((await handle(new Request("https://x/api/market"), { store: () => ({ get: async () => null }) })).status).toBe(404);
  });
});
