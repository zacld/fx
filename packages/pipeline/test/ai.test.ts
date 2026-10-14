import { describe, it, expect, beforeEach } from "vitest";
import {
  analyseViaGroq, RateLimitError, getResolvedGroqModel, _resetGroqModelMemoForTests,
} from "../src/sources/ai.js";

const MODEL_NOT_FOUND_BODY = JSON.stringify({
  error: { message: "The model `llama-3.3-70b-versatile` does not exist or you do not have access to it.", type: "invalid_request_error", code: "model_not_found" },
});
const okBody = (text: unknown) => JSON.stringify({ choices: [{ message: { content: JSON.stringify(text) } }] });

function fakeFetch(responsesByModel: Record<string, { status: number; body: string }>) {
  const calls: string[] = [];
  const impl = (async (_url: string, init?: RequestInit) => {
    const model = JSON.parse(String(init?.body)).model as string;
    calls.push(model);
    const r = responsesByModel[model] ?? { status: 404, body: MODEL_NOT_FOUND_BODY };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => r.body,
      json: async () => JSON.parse(r.body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("analyseViaGroq — model fallback chain", () => {
  beforeEach(() => { _resetGroqModelMemoForTests(); });

  it("healthy path: configured model answers first try, exactly one request", async () => {
    const { impl, calls } = fakeFetch({ "llama-3.3-70b-versatile": { status: 200, body: okBody({ ok: true }) } });
    const result = await analyseViaGroq("h", "s", { apiKey: "k", fetchImpl: impl });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(["llama-3.3-70b-versatile"]);
    expect(getResolvedGroqModel()).toBe("llama-3.3-70b-versatile");
  });

  it("configured model 404s model_not_found — falls through to the first working fallback", async () => {
    const { impl, calls } = fakeFetch({
      "llama-3.1-8b-instant": { status: 200, body: okBody({ ok: true }) },
    });
    const result = await analyseViaGroq("h", "s", { apiKey: "k", model: "retired-model", fetchImpl: impl });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(["retired-model", "llama-3.1-8b-instant"]);
    expect(getResolvedGroqModel()).toBe("llama-3.1-8b-instant");
  });

  it("once a fallback is resolved, later calls this run skip straight to it (still one request)", async () => {
    const { impl, calls } = fakeFetch({ "llama-3.1-8b-instant": { status: 200, body: okBody({ ok: true }) } });
    await analyseViaGroq("h", "s", { apiKey: "k", model: "retired-model", fetchImpl: impl });
    calls.length = 0;
    const second = await analyseViaGroq("h2", "s2", { apiKey: "k", model: "retired-model", fetchImpl: impl });
    expect(second).toEqual({ ok: true });
    expect(calls).toEqual(["llama-3.1-8b-instant"]);
  });

  it("all candidates model_not_found — throws a combined error naming every model tried", async () => {
    const { impl } = fakeFetch({});
    await expect(analyseViaGroq("h", "s", { apiKey: "k", fetchImpl: impl })).rejects.toThrow(/no working model found/i);
  });

  it("a rate limit on the configured model throws RateLimitError immediately — no fallback fan-out", async () => {
    const { impl, calls } = fakeFetch({ "llama-3.3-70b-versatile": { status: 429, body: "rate limit" } });
    await expect(analyseViaGroq("h", "s", { apiKey: "k", fetchImpl: impl })).rejects.toThrow(RateLimitError);
    expect(calls).toEqual(["llama-3.3-70b-versatile"]); // never tried a fallback for a non-model_not_found error
  });

  it("a non-model_not_found 4xx/5xx on the configured model throws immediately — no fallback fan-out", async () => {
    const { impl, calls } = fakeFetch({ "llama-3.3-70b-versatile": { status: 500, body: "server error" } });
    await expect(analyseViaGroq("h", "s", { apiKey: "k", fetchImpl: impl })).rejects.toThrow(/Groq 500/);
    expect(calls).toEqual(["llama-3.3-70b-versatile"]);
  });
});
