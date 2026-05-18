import { describe, it, expect } from "vitest";
import { buildSheetRows } from "../src/stages/export-sheets.js";
import { parseServiceAccount } from "../src/sources/google-sheets.js";
import type { Lead } from "@fx/core";

function lead(p: Partial<Lead>): Lead { return p as Lead; }

describe("buildSheetRows", () => {
  it("ranks HOT by ready_score, drops zero-ready, applies limit", () => {
    const leads = [
      lead({ priority: "HOT", ready_score: 80, score: 85, company_name: "Mid Importers Ltd" }),
      lead({ priority: "HOT", ready_score: 100, score: 95, company_name: "Top Importers Ltd" }),
      lead({ priority: "HOT", ready_score: 0,   score: 90, company_name: "Gated By READY Ltd" }),
      lead({ priority: "WARM", ready_score: 50, score: 70, company_name: "Should Be Excluded" }),
      lead({ priority: "HOT", ready_score: 60, score: 80, company_name: "Bottom Importers Ltd" }),
    ];
    const rows = buildSheetRows(leads, 25);
    expect(rows.length).toBe(3);
    expect(rows[0]?.[0]).toBe(1);
    expect(rows[0]?.[4]).toBe("Top Importers Ltd");
    expect(rows[2]?.[4]).toBe("Bottom Importers Ltd");
  });

  it("respects the limit", () => {
    const leads = Array.from({ length: 30 }, (_, i) =>
      lead({ priority: "HOT", ready_score: 100 - i, score: 90, company_name: `Lead ${i}` }));
    expect(buildSheetRows(leads, 5).length).toBe(5);
  });

  it("fills missing fields safely (no crashes on nulls)", () => {
    const rows = buildSheetRows([
      lead({ priority: "HOT", ready_score: 95, score: 90, company_name: "Sparse Ltd" }),
    ], 25);
    expect(rows.length).toBe(1);
    const [r] = rows;
    expect(r![0]).toBe(1);
    expect(r![13]).toBe(0); // fx signal count is numeric, not null
  });
});

describe("parseServiceAccount", () => {
  const fake = {
    client_email: "fx-bot@p.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\\nfoo\\n-----END PRIVATE KEY-----\\n",
    token_uri: "https://oauth2.googleapis.com/token",
  };

  it("parses raw JSON and unescapes \\n in the PEM body", () => {
    const sa = parseServiceAccount(JSON.stringify(fake));
    expect(sa.client_email).toBe("fx-bot@p.iam.gserviceaccount.com");
    expect(sa.private_key).toContain("\n");
    expect(sa.private_key).not.toContain("\\n");
  });

  it("parses a base64-encoded JSON blob (CI-friendly)", () => {
    const b64 = Buffer.from(JSON.stringify(fake), "utf8").toString("base64");
    const sa = parseServiceAccount(b64);
    expect(sa.client_email).toBe(fake.client_email);
  });

  it("throws on a malformed key", () => {
    expect(() => parseServiceAccount("{}")).toThrow(/missing client_email/);
  });
});
