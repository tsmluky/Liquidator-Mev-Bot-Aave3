import fs from "node:fs";
import { logger } from "../logger";
import { loadConfig } from "../config";
import { dataPath } from "../lib/data_dir";
import { Address, parseUnits } from "viem";

type PlanAction = "EXEC" | "WATCH" | "SKIP";

type AaveCandidate = {
  candidateId: string;
  borrower: Address;
  healthFactor: number;
  proximity: number | null;
  totalCollateralUSD: number;
  totalDebtUSD: number;
  bestDebt?: Address;
  bestCollateral?: Address;
  bestDebtAmount?: string; // serialized bigint
  status: string;
  ts: string;
};

// Aave Executor Order
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

type TxPlanItem = {
  ts: string;
  candidateId: string;
  borrower: string;
  netProfitUsd: number;
  proximity: number | null;
  action: PlanAction;
  pass: boolean;
  note: string;
  order?: ExecutorOrder;
};

function bigintReplacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}

export async function planCmd() {
  const cfg = loadConfig();
  const now = new Date().toISOString();

  const candFile = dataPath("candidates.jsonl");
  if (!fs.existsSync(candFile)) throw new Error(`Missing ${candFile}`);

  const candidates: AaveCandidate[] = [];
  const raw = fs.readFileSync(candFile, "utf-8").trim();
  if (raw) {
    raw.split(/\r?\n/).forEach(ln => {
      try { candidates.push(JSON.parse(ln)); } catch { }
    });
  }

  const items: TxPlanItem[] = [];
  let execBuilt = 0;

  // Defaults
  const referralCode = Number(process.env.AAVE_REFERRAL_CODE ?? "0");
  const maxTxGasPriceWei = BigInt(process.env.MAX_TX_GAS_PRICE_WEI ?? "0");
  const slippageBps = cfg.SLIPPAGE_BPS;

  for (const c of candidates) {
    // Basic filter
    if (c.status === "below_watch") continue;

    let action: PlanAction = "WATCH";
    let note = `HF=${c.healthFactor.toFixed(4)}`;
    let pass = false;
    let order: ExecutorOrder | undefined;

    // Filter Logic for Execution
    if (c.status === "exec_ready") {
      // Lazy load assets ONLY when we need to execute
      let bestDebt = c.bestDebt;
      let bestCollateral = c.bestCollateral;
      let bestDebtAmount = c.bestDebtAmount ? BigInt(c.bestDebtAmount) : 0n;

      // If assets not already fetched (all zeros), fetch them now
      if (!bestDebt || bestDebt === "0x0000000000000000000000000000000000000000") {
        const { getUserAssets } = await import("../lib/getUserAssets");
        const assets = await getUserAssets(c.borrower as Address, cfg.AAVE_POOL_ADDRESS_PROVIDER, cfg.AAVE_POOL_ADDRESS_PROVIDER);
        bestDebt = assets.bestDebt;
        bestCollateral = assets.bestCollateral;
        bestDebtAmount = assets.bestDebtAmount;
      }

      const TOP_RESERVES: Address[] = [
        "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // USDC
        "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", // USDT
        "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // WETH
        "0x912CE59144191C1204E64559FE8253a0e49E6548", // ARB
        "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", // WBTC
        "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", // DAI
      ];

      // Check if we have valid assets
      if (bestDebt && bestCollateral &&
        bestDebt !== "0x0000000000000000000000000000000000000000" &&
        bestCollateral !== "0x0000000000000000000000000000000000000000") {

        if (bestDebtAmount && bestDebtAmount > 0n) {
          const fullDebt = bestDebtAmount;
          // Aave Close Factor: 50% usually.
          // We'll try 50% to be safe.
          const repayAmount = fullDebt / 2n;

          // AmountOutMin (for swap collateral -> debt)
          // We don't have exact prices here to calculate expected output perfectly without RPC?
          // Actually exec.ts does re-simulation.
          // We need to provide a path.
          // "The Reaper" assumes multihop quoting via Uniswap.
          // We need to encode path: [Collateral, Fee, Debt].
          // Default Fee: 3000 (0.3%)? Or try keys from config.
          // Simple assumption: 3000 fee for now.
          // Protocol usually has 500, 3000, 10000.
          // We put a placeholder path. exec.ts might fail if path implies 0 liquidity.
          // Ideally we find the path.

          // Construct UniV3 Path (Mock)
          // Collateral -> 3000 -> Debt
          const fee = 3000;
          const pathStr = encodeV3Path([c.bestCollateral, c.bestDebt], [fee]);

          // amountOutMin: 0 for now (unsafe but enables simulation to run).
          // In production, MUST quote.
          const amountOutMin = 0n;

          const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
          const nonce = BigInt(Date.now());

          order = {
            debtAsset: c.bestDebt,
            collateralAsset: c.bestCollateral,
            borrower: c.borrower,
            repayAmount,
            uniPath: pathStr,
            amountOutMin,
            minProfit: 0n, // Miner tip usually covers it, strictly 0 here
            deadline,
            maxTxGasPrice: maxTxGasPriceWei,
            referralCode,
            nonce
          };

          action = "EXEC";
          note = "EXEC_READY_ORDER_BUILT";
          pass = true;
          execBuilt++;

        } else {
          note += " | ORDER_BUILD_SKIPPED (Missing debt amount)";
        }
      } else {
        note += " | Missing Best Assets";
      }
    }

    items.push({
      ts: now,
      candidateId: c.candidateId,
      borrower: c.borrower,
      netProfitUsd: 0, // todo
      proximity: c.proximity,
      action,
      pass,
      note,
      order
    });
  }

  const outFile = dataPath("tx_plan.json");
  fs.writeFileSync(outFile, JSON.stringify({ items, generatedAt: now, execBuilt }, bigintReplacer, 2));

  logger.info({ candidates: candidates.length, items: items.length, execBuilt }, "Plan generated");

  // --- RICH HUD (Plan Phase) ---
  // Show detailed token info for top 5 risky candidates.
  // This runs only in 'plan', keeping 'scan' fast.

  // Sort by proximity/HF
  const topRisk = candidates
    .filter(c => c.status === "watch" || c.status === "exec_ready")
    .sort((a, b) => a.healthFactor - b.healthFactor)
    .slice(0, 5);

  if (topRisk.length > 0) {
    console.log("");
    console.log("┌────────────────────────────────────────────────────────┐");
    console.log("│ 📝 STRATEGY PLANNER - TOP RISK TARGETS                  │");
    console.log("├────────────────────────────────────────────────────────┤");

    const TOKEN_MAP: Record<string, string> = {
      "0xaf88d065e77c8cC2239327C5EDb3A432268e5831": "USDC",
      "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9": "USDT",
      "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1": "WETH",
      "0x912CE59144191C1204E64559FE8253a0e49E6548": "ARB",
      "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f": "WBTC",
      "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1": "DAI"
    };

    // Lazy load as needed
    const { getUserAssets } = await import("../lib/getUserAssets");
    const poolAddr = cfg.AAVE_POOL_ADDRESS_PROVIDER;

    for (let i = 0; i < topRisk.length; i++) {
      const c = topRisk[i];

      // Allow fetching even if not exec_ready, just for display
      let debtSym = "???";
      let colSym = "???";
      let bestDebt = c.bestDebt;
      let bestCollateral = c.bestCollateral;

      // If missing (because scan is fast), fetch now
      if (!bestDebt || bestDebt === "0x0000000000000000000000000000000000000000") {
        try {
          const assets = await getUserAssets(c.borrower as Address, cfg.AAVE_POOL_ADDRESS_PROVIDER, poolAddr);
          bestDebt = assets.bestDebt;
          bestCollateral = assets.bestCollateral;
        } catch (e) { /* ignore */ }
      }

      debtSym = TOKEN_MAP[bestDebt] || "UNK";
      colSym = TOKEN_MAP[bestCollateral] || "UNK";

      const addr = c.borrower as string;
      const shortAddr = `${addr.slice(0, 10)}...${addr.slice(-8)}`;
      const collateral = `$${Math.round(c.totalCollateralUSD)}`.padStart(8);
      const debt = `$${Math.round(c.totalDebtUSD)}`.padStart(8);
      const estProfit = Math.round(c.totalDebtUSD * 0.5 * 0.05);

      console.log(`│ ${i + 1}. ${shortAddr}  HF: ${c.healthFactor.toFixed(4)} │`);
      console.log(`│    Col: ${collateral} (${colSym.padEnd(4)}) | Debt: ${debt} (${debtSym.padEnd(4)}) | Profit: ~$${estProfit} │`);
    }
    console.log("└────────────────────────────────────────────────────────┘");
    console.log("");
  }
}

function hexNo0x(h: string): string {
  return h.startsWith("0x") ? h.slice(2) : h;
}

function padFee3Bytes(fee: number): string {
  const f = Math.trunc(Number(fee));
  return f.toString(16).padStart(6, "0");
}

function encodeV3Path(tokens: Address[], fees: number[]): `0x${string}` {
  let out = "";
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = hexNo0x(tokens[i]);
    const b = hexNo0x(tokens[i + 1]);
    const feeHex = padFee3Bytes(fees[i]);
    if (i === 0) out += a;
    out += feeHex + b;
  }
  return ("0x" + out) as `0x${string}`;
}
