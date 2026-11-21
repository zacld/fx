// Cloudflare Pages Function: /api/feed (api/feed.mjs) — the read-only Power Automate feed over the site's KV store.
import { handle } from "../../api/feed.mjs";
import { STORE } from "../../api/accounts.mjs";
import { BINDING, kvStore } from "../../api/kv.mjs";

export const onRequest = ({ request, env }) =>
  handle(request, { password: env.ACCOUNTS_PASSWORD || "", store: () => kvStore(env[BINDING], STORE) });
