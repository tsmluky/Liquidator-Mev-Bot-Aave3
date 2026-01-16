import fs from "node:fs";
import path from "node:path";

/**
 * DATA_DIR allows isolating runtime outputs from test outputs.
 * - default: "data"
 * - runtime: "data/runtime"
 * - tests:   "data/test"
 */
export function resolveDataDir(): string {
  const raw = (process.env.DATA_DIR ?? "").trim();
  return raw.length > 0 ? raw : "data";
}

export function ensureDataDir(dir: string = resolveDataDir()): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function dataPath(...parts: string[]): string {
  const dir = ensureDataDir();
  return path.join(dir, ...parts);
}
