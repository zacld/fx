import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
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
