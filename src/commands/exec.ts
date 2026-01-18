import fs from "node:fs/promises";
import { logger } from "../logger";
import { loadConfig } from "../config";
import { createPublicClient, createWalletClient, http, Address } from "viem";
import { arbitrum, base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { dataPath } from "../lib/data_dir";
import { AaveScanner } from "../services/aaveScanner";
import { addToBlacklist } from "../lib/blacklist";

function truthyEnv(name: string, def = "0"): boolean {
  return ["1", "true", "yes", "y", "on"].includes(String(process.env[name] ?? def).toLowerCase());
}

function parseAddr(name: string): `0x${string}` {
  const v = String(process.env[name] ?? "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(v)) throw new Error(`exec: invalid ${name}=${v}`);
  return v as `0x${string}`;
}

// Aave V3 Executor Order
type ExecutorOrder = {
  debtAsset: Address;
  collateralAsset: Address;
  borrower: Address;
  repayAmount: bigint;
  uniPath: `0x${string}`;
  amountOutMin: bigint;
  minProfit: bigint;
  deadline: bigint;
  maxTxGasPrice: bigint;
  referralCode: number;
  nonce: bigint;
};

type PlanItem = {
  ts?: string;
  candidateId?: string;
  marketId: string; // Kept for reference or could be removed/renamed
  borrower: string;
  netProfitUsd: number;
  proximity: number | null;
  action: "WATCH" | "EXEC" | "SKIP";
  pass: boolean;
  note?: string;
  order?: ExecutorOrder; // Now using Aave order
};

type TxPlan = { items: PlanItem[]; generatedAt?: string };

const EXECUTOR_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "order",
        type: "tuple",
        components: [
          { name: "debtAsset", type: "address" },
          { name: "collateralAsset", type: "address" },
          { name: "borrower", type: "address" },
          { name: "repayAmount", type: "uint256" },
          { name: "uniPath", type: "bytes" },
          { name: "amountOutMin", type: "uint256" },
          { name: "minProfit", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "maxTxGasPrice", type: "uint256" },
          { name: "referralCode", type: "uint16" },
          { name: "nonce", type: "uint256" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

function classifyErr(e: any): { kind: "SKIP_HEALTHY" | "FAIL"; msg: string } {
  const msg = String(e?.shortMessage ?? e?.message ?? e ?? "");
  const m = msg.toLowerCase();
  // Aave specific reverts or generic health check fails
  if (m.includes("health factor") || m.includes("healthy") || m.includes("no collateral")) return { kind: "SKIP_HEALTHY", msg };
  return { kind: "FAIL", msg };
}

export async function execCmd() {
  const cfg = loadConfig();

  if (!truthyEnv("EXEC_ENABLED", "0")) {
    throw new Error("exec: blocked (set EXEC_ENABLED=1).");
  }
  if (!cfg.PRIVATE_KEY) {
    throw new Error("exec: PRIVATE_KEY missing in config/env.");
  }

  const EXECUTOR_ADDR = parseAddr("EXECUTOR_ADDR");
  const account = privateKeyToAccount(cfg.PRIVATE_KEY as `0x${string}`);

  // Select chain
  const chain = cfg.CHAIN_ID === 8453 ? base : arbitrum;

  const publicClient = createPublicClient({
    chain,
    transport: http(cfg.ARB_RPC_URL),
  });

  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(cfg.ARB_RPC_URL),
  });

  const planRaw = await fs.readFile(dataPath("tx_plan.json"), "utf8");
  const plan = JSON.parse(planRaw) as TxPlan;

  const execs = (plan.items ?? [])
    .filter((x) => x.action === "EXEC" && x.pass && x.order)
    .sort((a, b) => Number(b.netProfitUsd) - Number(a.netProfitUsd));

  if (execs.length === 0) {
    logger.info({ exec: 0 }, "exec: nothing to execute (no EXEC+pass items with order)");
    return;
  }

  const deadlineSec = Math.trunc(Number(process.env.ORDER_DEADLINE_SEC ?? "180"));
  const refreshedDeadline = BigInt(Math.floor(Date.now() / 1000) + Math.max(60, deadlineSec));

  let tried = 0;
  let skippedHealthy = 0;
  let failed = 0;

  const maxAgeSec = 90; // Increased to 90s to prevent stale plans on slow loops
  const planAge = (Date.now() - Date.parse(plan.generatedAt ?? "")) / 1000;
  if (planAge > maxAgeSec) {
    logger.error({ planAge, maxAgeSec }, "exec: plan is STALE (safety abort)");
    return;
  }

  const scanner = new AaveScanner(); // For forensic check

  for (const selected of execs) {
    tried++;

    // Safety: Gas Price Cap
    const currentGasPrice = await publicClient.getGasPrice();
    if (currentGasPrice > cfg.MAX_TX_GAS_PRICE_WEI) {
      logger.warn({ currentGasPrice: currentGasPrice.toString(), cap: cfg.MAX_TX_GAS_PRICE_WEI.toString() }, "exec: gas price too high (safety abort)");
      continue;
    }

    const selectedOrder = selected.order!;
    // Refresh deadline/nonce
    const refreshedNonce = BigInt(Date.now() + tried);

    const order: ExecutorOrder = {
      ...selectedOrder,
      repayAmount: BigInt(selectedOrder.repayAmount),
      amountOutMin: BigInt(selectedOrder.amountOutMin),
      minProfit: BigInt(selectedOrder.minProfit),
      maxTxGasPrice: BigInt(selectedOrder.maxTxGasPrice),
      deadline: refreshedDeadline,
      nonce: refreshedNonce,
    };

    try {
      // Re-Simulate
      const sim = await publicClient.simulateContract({
        account,
        address: EXECUTOR_ADDR,
        abi: EXECUTOR_ABI,
        functionName: "execute",
        args: [order],
      });

      // --- SMART FEE STRATEGY (The "Robin Hood" Logic) ---
      // We are willing to share 10% of the profit with the miner to get the transaction in.
      // But we strict CAP the bid to $2.00 because our wallet only has $10.

      const profitUsd = Number(selected.netProfitUsd || 0);

      // 1. Target Fee: 10% of profit (Aggressive)
      // e.g. Profit $10 -> Fee $1. Profit $50 -> Fee $5.
      let targetFeeUsd = profitUsd * 0.10;

      // 2. Safety Cap: Never pay more than $2.00
      if (targetFeeUsd > 2.0) targetFeeUsd = 2.0;

      // 3. Convert USD to Gwei (Approx for Arbitrum)
      // Assumption: 1 Gwei on Arb (~500k gas) costs ~$1.65 USD @ $3300 ETH
      // So $1 USD ~= 0.6 Gwei
      let priorityGwei = targetFeeUsd * 0.6;

      // 4. Sanity Floors
      if (priorityGwei < 0.1) priorityGwei = 0.1; // Min 0.1 gwei always

      const priorityFee = BigInt(Math.floor(priorityGwei * 1e9));

      logger.info({
        profitUsd,
        willingToPay$: targetFeeUsd.toFixed(2),
        bidGwei: priorityGwei.toFixed(4)
      }, "exec: ⚔️ Aggressive Bidding (10% Share)");

      // Broadcast
      const hash = await walletClient.writeContract({
        address: EXECUTOR_ADDR,
        abi: EXECUTOR_ABI,
        functionName: "execute",
        args: [order],
        account,
        gas: sim.request.gas,
        maxPriorityFeePerGas: priorityFee,
        chain,
      });

      const outPath = dataPath("tx_exec.json");
      const out = {
        generatedAt: new Date().toISOString(),
        executor: EXECUTOR_ADDR,
        selected: {
          candidateId: selected.candidateId,
          borrower: selected.borrower,
          netProfitUsd: selected.netProfitUsd,
          note: selected.note,
        },
        from: account.address,
        txHash: hash,
        note: "LIQUIDATION_SENT",
      };

      await fs.writeFile(outPath, JSON.stringify(out, null, 2), "utf8");
      logger.info({ ...out, out: outPath }, "exec: broadcasted liquidation");
      return;
    } catch (e: any) {
      const c = classifyErr(e);
      if (c.kind === "SKIP_HEALTHY") {
        skippedHealthy++;

        // --- FORENSIC ANALYSIS (Aave V3) ---
        try {
          logger.warn(
            { borrower: selected.borrower },
            "exec: skip (healthy or no collateral) - checking on-chain data..."
          );

          const health = await scanner.getUserHealth(selected.borrower as Address);
          if (health) {
            logger.info({
              borrower: health.user,
              HF: health.healthFactor,
              CollateralUSD: health.totalCollateralUSD,
              DebtUSD: health.totalDebtUSD
            }, "FORENSIC: User Health Status");
          } else {
            logger.warn("FORENSIC: Could not fetch user data");
          }

        } catch (err: any) {
          logger.error({ err: err.message }, "FORENSIC: Failed to run analysis");
        }
        // --- FORENSIC END ---

        // Blacklist purely healthy/dust skips too
        addToBlacklist(selected.borrower);
        continue;
      }
      failed++;
      logger.warn(
        { candidateId: selected.candidateId, err: c.msg.slice(0, 500) },
        "exec: simulate failed - trying next"
      );
      addToBlacklist(selected.borrower);
      continue;
    }
  }

  logger.info({ tried, skippedHealthy, failed }, "exec: no executable order found this cycle");
}

