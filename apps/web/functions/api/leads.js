// Cloudflare Pages Function: /api/leads (api/leads.mjs) over the site's KV store.
import { STORE, handle } from "../../api/leads.mjs";
import { BINDING, kvStore } from "../../api/kv.mjs";

export const onRequest = ({ request, env }) =>
  handle(request, { password: env.ACCOUNTS_PASSWORD || "", store: () => kvStore(env[BINDING], STORE) });
