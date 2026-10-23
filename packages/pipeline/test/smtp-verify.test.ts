import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSmtpVerifier, smtpProbeDisabledByDefault } from "../src/sources/smtp-verify.js";

beforeEach(() => {
  delete process.env.FX_SMTP_DISABLE;
  delete process.env.CI;
  delete process.env.GITHUB_ACTIONS;
  delete process.env.FX_EMAIL_VERIFIER_URL;
});

describe("smtpProbeDisabledByDefault", () => {
  it("disables when FX_SMTP_DISABLE=1", () => {
    process.env.FX_SMTP_DISABLE = "1";
    expect(smtpProbeDisabledByDefault()).toBe(true);
  });
  it("disables on CI", () => {
    process.env.GITHUB_ACTIONS = "true";
    expect(smtpProbeDisabledByDefault()).toBe(true);
  });
  it("does not disable on a normal local run", () => {
    expect(smtpProbeDisabledByDefault()).toBe(false);
  });
});

describe("createSmtpVerifier (HTTP verifier)", () => {
  it("hits the HTTP endpoint when FX_EMAIL_VERIFIER_URL is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smtpv-"));
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ smtp_verified: true, catch_all: false }), { status: 200 }),
    );
    const v = createSmtpVerifier({
      cachePath: join(dir, "c.json"),
      httpVerifierUrl: "https://verifier.example/check",
      httpVerifierToken: "tk",
    });
    const r = await v.verifyEmail("alice@acme.com");
    expect(r.smtp_verified).toBe(true);
    expect(r.source).toBe("http");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Second call should serve from cache, not hit the verifier again.
    const r2 = await v.verifyEmail("alice@acme.com");
    expect(r2.source).toBe("cache");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it("returns smtp_verified=null and source='mx_only' when SMTP disabled and no HTTP verifier", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smtpv-"));
    const v = createSmtpVerifier({
      cachePath: join(dir, "c.json"),
      disableSmtp: true,
    });
    // Use a domain whose MX lookup will deterministically fail or succeed —
    // pick a clearly-unroutable domain so we don't risk network in tests.
    const r = await v.verifyEmail("alice@nonexistent.example.invalid");
    // .invalid TLD → no MX → smtp_verified=false, source=mx_only
    expect(r.source).toBe("mx_only");
    expect(r.smtp_verified).toBe(false);
  });

  it("invalid local part / missing @ shorts out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smtpv-"));
    const v = createSmtpVerifier({ cachePath: join(dir, "c.json"), disableSmtp: true });
    expect((await v.verifyEmail("notanemail")).source).toBe("skipped");
  });
});
