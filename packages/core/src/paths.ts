/**
 * paths.ts — locate the monorepo root so the pipeline stages resolve `data/…`
 * the same way no matter what cwd they're invoked from (repo root, a workspace
 * dir under `npm run -w`, a GitHub Action, etc.). The root is the nearest
 * ancestor directory whose package.json declares `workspaces`.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";

let cached: string | null = null;

export function repoRoot(): string {
  if (cached) return cached;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 16; i++) {
    const pj = resolve(dir, "package.json");
    if (existsSync(pj)) {
      try {
        const json = JSON.parse(readFileSync(pj, "utf8")) as { workspaces?: unknown };
        if (json.workspaces) return (cached = dir);
      } catch { /* not parseable — keep walking up */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return (cached = process.cwd());
}

/** Resolve a path relative to the monorepo root (e.g. `dataPath("data/fx.db")`). */
export function dataPath(...segments: string[]): string {
  return resolve(repoRoot(), ...segments);
}
