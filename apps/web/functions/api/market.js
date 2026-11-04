// Cloudflare Pages Function: /api/market (api/market.mjs) over the site's KV store.
import { STORE, handle } from "../../api/market.mjs";
import { BINDING, kvStore } from "../../api/kv.mjs";

export const onRequest = ({ request, env }) => handle(request, { store: () => kvStore(env[BINDING], STORE) });
