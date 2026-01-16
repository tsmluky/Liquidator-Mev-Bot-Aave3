import "dotenv/config";
import fs from "node:fs/promises";
import { scanCmd } from "../src/commands/scan.js";

function fail(msg: string): never {
  console.error(`[TEST_SCAN] FAIL: ${msg}`);
  process.exit(1);
}

async function exists(path: string): Promise<boolean> {
  try { await fs.stat(path); return true; } catch { return false; }
}

async function main() {
  console.log("[TEST_SCAN] running scanCmd() ...");
  await scanCmd();

  const outPath = "./data/hot_queue.json";
  if (!(await exists(outPath))) fail(`Missing ${outPath} after scanCmd()`);

  const raw = await fs.readFile(outPath, "utf8");
  const json = JSON.parse(raw) as any;

  const n = Array.isArray(json?.hotQueue) ? json.hotQueue.length : null;
  if (n === null) fail("hot_queue.json missing hotQueue[]");

  console.log(`[TEST_SCAN] hotQueue items: ${n}`);
  console.log("[TEST_SCAN] OK");
}

main().catch((e: any) => {
  console.error("[TEST_SCAN] UNCAUGHT:", e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
