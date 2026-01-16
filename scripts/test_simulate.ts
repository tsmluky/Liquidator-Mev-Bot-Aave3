import "dotenv/config";
import fs from "node:fs/promises";
import { simulateCmd } from "../src/commands/simulate.js";

function fail(msg: string): never {
  console.error(`[TEST_SIMULATE] FAIL: ${msg}`);
  process.exit(1);
}

async function exists(path: string): Promise<boolean> {
  try { await fs.stat(path); return true; } catch { return false; }
}

function parseCsv(csv: string): { header: string[]; rows: Record<string,string>[] } {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { header: [], rows: [] };

  const header = lines[0].split(",").map((s) => s.trim());
  const rows: Record<string,string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const r: Record<string,string> = {};
    for (let j = 0; j < header.length; j++) r[header[j]] = (cols[j] ?? "").trim();
    rows.push(r);
  }
  return { header, rows };
}

function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : Number.NaN;
}

function pickBest(rows: Record<string,string>[], pred: (r: any) => boolean) {
  const filtered = rows.filter(pred);
  filtered.sort((a,b) => num(b.netProfitUsd) - num(a.netProfitUsd));
  return filtered[0] ?? null;
}

async function main() {
  console.log("[TEST_SIMULATE] running simulateCmd() ...");
  await simulateCmd();

  const outPath = "./data/opportunities.csv";
  if (!(await exists(outPath))) fail(`Missing ${outPath} after simulateCmd()`);

  const csv = await fs.readFile(outPath, "utf8");
  const { header, rows } = parseCsv(csv);

  if (header.length === 0) fail("opportunities.csv has no header");

  const mustHave = [
    "ts","candidateId","marketId","borrower",
    "repayUsd","grossProfitUsd","estimatedTotalGasUsd","netProfitUsd",
    "quoteMode","isQuoted","passExec","passModel","pass",
  ];

  for (const k of mustHave) {
    if (!header.includes(k)) fail(`opportunities.csv missing header column: ${k}`);
  }

  console.log(`[TEST_SIMULATE] rows: ${rows.length}`);

  if (rows.length === 0) {
    console.warn("[TEST_SIMULATE] WARN: no rows in opportunities.csv");
    console.log("[TEST_SIMULATE] OK (empty)");
    return;
  }

  // Invariante: si passExec=1 => isQuoted=1
  for (const r of rows) {
    if (r.passExec === "1" && r.isQuoted !== "1") {
      fail(`Invariant broken: passExec=1 but isQuoted!=1 (candidateId=${r.candidateId})`);
    }
  }

  const bestOverall = pickBest(rows, () => true);
  if (!bestOverall) fail("Could not pick bestOverall");

  const bestExec = pickBest(rows, (r) => r.passExec === "1");

  console.log("[TEST_SIMULATE] best overall:");
  console.log({
    netProfitUsd: bestOverall.netProfitUsd,
    quoteMode: bestOverall.quoteMode,
    isQuoted: bestOverall.isQuoted,
    passExec: bestOverall.passExec,
    passModel: bestOverall.passModel,
    borrower: bestOverall.borrower,
    collateral: (bestOverall as any).collateral ?? "",
    loan: (bestOverall as any).loan ?? "",
  });

  if (bestExec) {
    console.log("[TEST_SIMULATE] best EXEC (passExec=1):");
    console.log({
      netProfitUsd: bestExec.netProfitUsd,
      quoteMode: bestExec.quoteMode,
      isQuoted: bestExec.isQuoted,
      passExec: bestExec.passExec,
      borrower: bestExec.borrower,
      collateral: (bestExec as any).collateral ?? "",
      loan: (bestExec as any).loan ?? "",
    });
  } else {
    console.warn("[TEST_SIMULATE] WARN: no passExec=1 rows (no executable quotes)");
  }

  console.log("[TEST_SIMULATE] OK");
}

main().catch((e: any) => {
  console.error("[TEST_SIMULATE] UNCAUGHT:", e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
