export * from "./schema.js";
export * from "./signals.js";
export * from "./scoring.js";
export * from "./contacts.js";
export * from "./cache.js";
export { repoRoot, dataPath } from "./paths.js";
export { importJson } from "./db/import-json.js";
export type { ImportResult, ImportOptions } from "./db/import-json.js";
export { exportJson } from "./db/export-json.js";
export type { ExportResult, ExportOptions } from "./db/export-json.js";
// DB tables / connection under a namespace to keep top-level exports tidy:
//   core.db.getDb(), core.db.leads, core.db.ensureSchema, ...
export * as db from "./db/index.js";
