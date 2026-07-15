/**
 * google-sheets.ts — minimal Google Sheets v4 writer using a service-account JWT.
 *
 * No external SDK — Node's crypto.sign signs the JWT with RS256, then a single
 * POST exchanges it for an OAuth access token, and `values.update` writes the
 * range. Keeps @fx/pipeline lean (avoids the ~30 MB googleapis dep) and gives
 * us a tight blast-radius if Google changes anything: the surface is two HTTP
 * calls and a JWT.
 *
 * Service-account JSON shape (the file from console.cloud.google.com → IAM →
 * Service Accounts → Keys → Add Key → JSON):
 *
 *   { "client_email": "fx-bot@…iam.gserviceaccount.com",
 *     "private_key":  "-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n",
 *     "token_uri":    "https://oauth2.googleapis.com/token", … }
 *
 * Share the target spreadsheet with the service-account email as Editor.
 */
import { createSign } from "node:crypto";

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/** Parse a service-account JSON blob from either raw JSON or base64 (CI-friendly). */
export function parseServiceAccount(raw: string): ServiceAccount {
  const trimmed = raw.trim();
  const json = trimmed.startsWith("{") ? trimmed : Buffer.from(trimmed, "base64").toString("utf8");
  const obj = JSON.parse(json) as Partial<ServiceAccount>;
  if (!obj.client_email || !obj.private_key) {
    throw new Error("invalid service-account JSON — missing client_email or private_key");
  }
  // GitHub Actions secrets sometimes strip the literal newlines from PEM bodies.
  obj.private_key = obj.private_key.replace(/\\n/g, "\n");
  return obj as ServiceAccount;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Sign a JWT for the Google OAuth token exchange (RS256). */
function signJwt(sa: ServiceAccount, scope: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    iss: sa.client_email,
    scope,
    aud: sa.token_uri ?? "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  const sig = b64url(signer.sign(sa.private_key));
  return `${header}.${payload}.${sig}`;
}

/** Exchange a signed JWT for an OAuth access token. Throws on non-2xx. */
export async function getAccessToken(sa: ServiceAccount, scope = "https://www.googleapis.com/auth/spreadsheets"): Promise<string> {
  const assertion = signJwt(sa, scope);
  const res = await fetch(sa.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) throw new Error(`Google token exchange ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error(`Google token response missing access_token`);
  return data.access_token;
}

/** Overwrite a sheet range with a 2D values array. `range` is in A1 form ("Today!A1"). */
export async function updateRange(args: {
  accessToken: string; spreadsheetId: string; range: string; values: ReadonlyArray<ReadonlyArray<string | number | null>>;
}): Promise<void> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(args.spreadsheetId)}/values/${encodeURIComponent(args.range)}?valueInputOption=RAW`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { authorization: `Bearer ${args.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ range: args.range, majorDimension: "ROWS", values: args.values }),
  });
  if (!res.ok) throw new Error(`Sheets update ${res.status}: ${await res.text()}`);
}

/** Clear a sheet range (so a short export doesn't leave yesterday's trailing rows). */
export async function clearRange(args: { accessToken: string; spreadsheetId: string; range: string }): Promise<void> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(args.spreadsheetId)}/values/${encodeURIComponent(args.range)}:clear`;
  const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${args.accessToken}` } });
  if (!res.ok) throw new Error(`Sheets clear ${res.status}: ${await res.text()}`);
}
