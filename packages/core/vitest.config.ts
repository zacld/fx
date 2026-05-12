import { defineConfig } from "vitest/config";

// Own config so vitest doesn't pick up the repo-root vite.config.js (the React app).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
