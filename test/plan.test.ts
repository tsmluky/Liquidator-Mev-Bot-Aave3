import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { planCmd } from "../src/commands/plan.js";

test("plan writes tx_plan.json and marks WATCH when proximity < 1", async () => {
  await fs.mkdir("./data", { recursive: true });

  const csv = [
    "ts,marketId,borrower,collateral,loan,lltv,proximity,repayUsd,lif,grossProfitUsd,estimatedGasUsd,flashFeeUsd,slippageUsd,netProfitUsd,requiredNetUsd,pass,note",
    "2026-01-01T00:00:00Z,0xmarket,0xborrower,WBTC,USDC,0.8,0.99,10000,1.05,100,5,1,1,93,0.5,1,fixture",
  ].join("\n");

  await fs.writeFile("./data/opportunities.csv", csv, "utf8");

  await planCmd();

  const planPath = path.resolve("./data/tx_plan.json");
  const plan = JSON.parse(await fs.readFile(planPath, "utf8"));

  assert.equal(plan.count, 1);
  assert.equal(plan.execCount, 0);
  assert.equal(plan.watchCount, 1);
  assert.equal(plan.items[0].action, "WATCH");
});
