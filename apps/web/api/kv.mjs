// The site's private store on Cloudflare Workers KV, in the shape the handlers use:
//   {get(key, {type: "json" | "arrayBuffer"}), setJSON(key, value), set(key, bytes)}
// One KV namespace (binding FX_STORE) holds every store, keys prefixed "<store>/" — "fx-accounts/latest",
// "fx-accounts/contacted", "fx-leads/leads.json.gz", "fx-market/latest". The workflows write the same keys
// through Cloudflare's API (scripts/store.mjs).
export const BINDING = "FX_STORE";
export const kvKey = (store, key) => `${store}/${key}`;

// KV takes about one write a second to the same key: two quick saves on the page (a Contacted click, then a note)
// can be turned away, so a write is tried again after a short wait.
const WRITE_RETRIES = [1100, 2200];

async function put(namespace, key, value, waits = WRITE_RETRIES) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await namespace.put(key, value);
    } catch (error) {
      if (attempt >= waits.length) throw error;
      await new Promise((r) => setTimeout(r, waits[attempt]));
    }
  }
}

export function kvStore(namespace, store, { waits = WRITE_RETRIES } = {}) {
  if (!namespace) throw new Error(`the ${BINDING} KV binding is missing on the Pages project`);
  return {
    get: (key, { type = "text" } = {}) => namespace.get(kvKey(store, key), { type }),
    setJSON: (key, value) => put(namespace, kvKey(store, key), JSON.stringify(value), waits),
    set: (key, value) => put(namespace, kvKey(store, key), value, waits),
  };
}
