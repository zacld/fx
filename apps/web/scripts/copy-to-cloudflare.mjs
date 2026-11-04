// The move from Netlify: copies each private key from Netlify Blobs to Cloudflare KV once — only while Cloudflare has
// nothing under that key, so it never overwrites what the new site has saved since (your Contacted marks and notes
// included). Run by the deploy workflow while both sets of secrets exist; counts only in the log.
import { KEY as ACCOUNTS, CONTACTED_KEY, NOTES_KEY, STORE as ACCOUNTS_STORE } from "../api/accounts.mjs";
import { KEY as LEADS, STORE as LEADS_STORE } from "../api/leads.mjs";
import { KEY as MARKET, STORE as MARKET_STORE } from "../api/market.mjs";
import { cloudflareConfigured, cloudflareStore, netlifyConfigured, netlifyStore } from "./store.mjs";

export const KEYS = [
  [ACCOUNTS_STORE, ACCOUNTS, "json"], [ACCOUNTS_STORE, CONTACTED_KEY, "json"], [ACCOUNTS_STORE, NOTES_KEY, "json"],
  [LEADS_STORE, LEADS, "bytes"], [MARKET_STORE, MARKET, "json"],
];

if (!cloudflareConfigured() || !netlifyConfigured()) {
  console.log("nothing to copy: needs both the Cloudflare and the old Netlify secrets");
  process.exit(0);
}
for (const [store, key, type] of KEYS) {
  const to = cloudflareStore(store);
  if ((await to.get(key, type)) !== null) {
    console.log(`${store}/${key}: already on Cloudflare, left as it is`);
    continue;
  }
  const value = await (await netlifyStore(store)).get(key, type).catch(() => null);
  if (value === null || value === undefined) {
    console.log(`${store}/${key}: nothing on Netlify`);
    continue;
  }
  await to.set(key, value);
  const size = type === "bytes" ? `${value.length.toLocaleString()} bytes`
    : value.rows ? `${value.rows.length} companies` : `${Object.keys(value).length} entries`;
  console.log(`${store}/${key}: copied from Netlify (${size})`);
}
