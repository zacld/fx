// Cloudflare Pages Function: /api/accounts (api/accounts.mjs) over the site's KV store.
import { STORE, handle } from "../../api/accounts.mjs";
import { BINDING, kvStore } from "../../api/kv.mjs";
import { DB_BINDING, d1Query } from "../../api/db.mjs";

export const onRequest = ({ request, env }) =>
  handle(request, { password: env.ACCOUNTS_PASSWORD || "", store: () => kvStore(env[BINDING], STORE),
    db: env[DB_BINDING] ? d1Query(env[DB_BINDING]) : null });
