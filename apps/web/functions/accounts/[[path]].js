// /accounts and /accounts/<company number>: the Accounts page (accounts.html), which reads the company number from
// the address itself. Served from the built files rather than a _redirects rewrite, which Pages doesn't do reliably
// for .html targets.
export const onRequest = ({ request, env }) => env.ASSETS.fetch(new URL("/accounts", request.url));
