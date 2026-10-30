import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

// Local dev only: the dashboard reads the pipeline's data/leads.json at /data/leads.json. Served by the dev server
// from the repo, never copied into public/ — so it can't end up in a build (names, phones and emails live only in
// the private store behind /api/leads).
const devLeads = {
  name: "dev-leads",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use("/data/leads.json", async (_req, res) => {
      try {
        res.setHeader("content-type", "application/json");
        res.end(await readFile(resolve(import.meta.dirname, "../../data/leads.json")));
      } catch {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  },
};

export default defineConfig({
  plugins: [react(), devLeads],
  base: "/",
  build: {
    rollupOptions: {
      // The event-led dashboard, the password-protected account list, and the day-to-day market moves.
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        accounts: resolve(import.meta.dirname, "accounts.html"),
        moves: resolve(import.meta.dirname, "moves.html"),
      },
    },
  },
});
