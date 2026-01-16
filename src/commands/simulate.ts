import { loadConfig } from "../config.js";
import { arbitrum } from "viem/chains";
import { logger } from "../logger.js";
import { writeCsv } from "../utils/io.js";
import fs from "node:fs/promises";
import { formatUnits, parseUnits, createPublicClient, http } from "viem";
import { getCode } from "../services/uniswapQuoterV2.js";
import { quoteBestExactInput } from "../services/quoteBest.js";
import { estimateL1CalldataFeeUsd } from "../services/arbGasInfo.js";
import { dataPath } from "../lib/data_dir";

type HotQueueItem = {
  rank: number;

  candidateId: string;
  marketId: string;
  borrower: string;

  collateralToken: `0x${string}`;
  loanToken: `0x${string}`;

  // NEW: needed for real liquidation Order
  oracle: `0x${string}` | null;
  irm: `0x${string}` | null;
  lltvWad: string | null;

  collateralSymbol?: string;
  loanSymbol?: string;

  collateralDecimals: number;
  loanDecimals: number;

  collateralPriceUsd: number | null;
  loanPriceUsd: number | null;

  borrowUsd: number | null;
  lltv: number | null;
  proximity: number | null;

  status: "below_watch" | "watch" | "exec_ready";
  reason: string;
  ts: string;
};

type EthPriceInfo = {
  usd: number;
  source: "chainlink" | "env";
  stale: boolean;
  ageSec: number;
  updatedAt: number;
  maxAgeSec: number;
};

function parseMaxAgeSec(): number {
  const raw =
    (process.env.ETH_USD_MAX_AGE_SEC ?? "").trim() ||
    (process.env.ETH_PRICE_MAX_AGE_SEC ?? "").trim() ||
    "180";

  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 180;
  return Math.floor(n);
}

function envEthPriceInfo(usd: number, opts?: Partial<EthPriceInfo>): EthPriceInfo {
  const maxAgeSec = parseMaxAgeSec();
  return {
    usd,
    source: "env",
    stale: opts?.stale ?? false,
    ageSec: opts?.ageSec ?? 0,
    updatedAt: opts?.updatedAt ?? 0,
    maxAgeSec: opts?.maxAgeSec ?? maxAgeSec,
  };
}

async function fetchEthPriceUsd(): Promise<EthPriceInfo> {
  const rpcUrl = process.env.ARB_RPC_URL;
  if (!rpcUrl) throw new Error("ARB_RPC_URL missing (needed for on-chain ETH/USD oracle)");

  const FEED = "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612" as const;

  const abi = [
    {
      type: "function",
      name: "decimals",
      stateMutability: "view",
      inputs: [],
      outputs: [{ name: "", type: "uint8" }],
    },
    {
      type: "function",
      name: "latestRoundData",
      stateMutability: "view",
      inputs: [],
      outputs: [
        { name: "roundId", type: "uint80" },
        { name: "answer", type: "int256" },
        { name: "startedAt", type: "uint256" },
        { name: "updatedAt", type: "uint256" },
        { name: "answeredInRound", type: "uint80" },
      ],
    },
  ] as const;

  const maxAgeSec = parseMaxAgeSec();

  const client = createPublicClient({ chain: arbitrum, transport: http(rpcUrl) });

  const decimals = await client.readContract({ address: FEED, abi, functionName: "decimals" });
  const [roundId, answer, , updatedAt] = await client.readContract({
    address: FEED,
    abi,
    functionName: "latestRoundData",
  });

  if (answer <= 0n) {
    throw new Error(`Invalid Chainlink ETH/USD answer=${answer.toString()} roundId=${roundId.toString()}`);
  }

  const updated = Number(updatedAt);
  if (!Number.isFinite(updated) || updated <= 0) throw new Error("Invalid Chainlink updatedAt");

  const ageSec = Math.floor(Date.now() / 1000) - updated;
  const stale = ageSec > maxAgeSec;

  if (stale) {
    logger.warn(
      { ageSec, maxAgeSec, updatedAt: updated },
      "Chainlink ETH/USD is stale; proceeding with DEGRADED pricing (execution should remain gated)"
    );
  }

  const scale = 10n ** BigInt(decimals);
  const px = Number(answer) / Number(scale);

  if (!Number.isFinite(px) || px <= 0) throw new Error("Invalid ETH price computed from Chainlink");

  return { usd: px, source: "chainlink", stale, ageSec, updatedAt: updated, maxAgeSec };
}

function lifFromLltv(lltv: number): number {
  const beta = 0.3;
  const M = 1.15;
  if (!Number.isFinite(lltv) || lltv <= 0 || lltv >= 1.5) return 1.0;
  const lif = beta * (1 / lltv) + (1 - beta) * 1;
  return Math.min(M, Math.max(1.0, lif));
}

function parseHexWei(x: unknown): bigint {
  if (typeof x !== "string" || !x.startsWith("0x")) {
    throw new Error(`RPC gasPrice missing/invalid result: ${JSON.stringify(x)}`);
  }
  return BigInt(x);
}

function applyMultiplierWei(base: bigint, multiplier: number): bigint {
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    throw new Error(`Invalid GAS_PRICE_MULTIPLIER=${multiplier}`);
  }
  const m = BigInt(Math.round(multiplier * 1000));
  return (base * m) / 1000n;
}

function assertFiniteNumber(name: string, value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`Config ${name} missing/invalid: ${String(value)}`);
  }
  return n;
}

function toUnitsApprox(amount: number, decimals: number): bigint {
  const dp = Math.min(Math.max(decimals, 0), 18);
  const keep = Math.min(dp, 8);
  const s = amount.toFixed(keep);
  return parseUnits(s, dp);
}

export async function simulateCmd() {
  const cfg = loadConfig();
  const requiredNetUsd = cfg.MIN_PROFIT_NET_USD + cfg.SAFETY_BUFFER_USD;

  let ethPriceInfo: EthPriceInfo;

  const hasEnvEth =
    cfg.ETH_PRICE_USD !== undefined &&
    cfg.ETH_PRICE_USD !== null &&
    Number.isFinite(cfg.ETH_PRICE_USD) &&
    cfg.ETH_PRICE_USD > 0;

  if (hasEnvEth) {
    ethPriceInfo = envEthPriceInfo(cfg.ETH_PRICE_USD as number, { stale: false, ageSec: 0, updatedAt: 0 });
  } else {
    ethPriceInfo = await fetchEthPriceUsd();
  }

  const pricingDegraded = ethPriceInfo.stale === true;

  const hotQueueRaw = await fs.readFile(dataPath("hot_queue.json"), "utf8");
  const hotQueueJson = JSON.parse(hotQueueRaw) as { generatedAt: string; hotQueue: HotQueueItem[] };

  const items = hotQueueJson.hotQueue.filter((x) => x.reason === "ok" && x.status !== "below_watch");

  // --- RPC gas price ---
  const rpcRes = await fetch(cfg.ARB_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] }),
  });

  const rpcText = await rpcRes.text();
  if (!rpcRes.ok) throw new Error(`RPC gasPrice failed: HTTP ${rpcRes.status} :: ${rpcText.slice(0, 300)}`);

  let gasJson: any;
  try {
    gasJson = JSON.parse(rpcText);
  } catch {
    throw new Error(`RPC returned non-JSON for gasPrice: ${rpcText.slice(0, 300)}`);
  }

  if (gasJson?.error) throw new Error(`RPC gasPrice error: ${JSON.stringify(gasJson.error).slice(0, 300)}`);

  const gasPriceWei = parseHexWei(gasJson?.result);
  const gasPriceWeiAdj = applyMultiplierWei(gasPriceWei, cfg.GAS_PRICE_MULTIPLIER);

  const gasLimit = BigInt(cfg.GAS_LIMIT);
  const gasCostWei = gasPriceWeiAdj * gasLimit;
  const gasCostEth = Number(formatUnits(gasCostWei, 18));
  const estimatedGasUsd = gasCostEth * ethPriceInfo.usd;

  // Quoter ok?
  let quoterOk = false;
  if (cfg.QUOTE_ENABLED) {
    const code = await getCode(cfg.ARB_RPC_URL, cfg.UNISWAP_V3_QUOTER_V2 as `0x${string}`);
    quoterOk = typeof code === "string" && code !== "0x";
  }

  logger.info(
    {
      gasPriceWei: gasPriceWei.toString(),
      gasPriceWeiAdj: gasPriceWeiAdj.toString(),
      gasLimit: cfg.GAS_LIMIT,
      estimatedGasUsd,
      ethPriceUsd: ethPriceInfo.usd,
      ethPriceAgeSec: ethPriceInfo.ageSec,
      ethPriceMaxAgeSec: ethPriceInfo.maxAgeSec,
      pricingDegraded,
      requiredNetUsd,
      considered: items.length,
      quoteEnabled: cfg.QUOTE_ENABLED,
      quoterOk,
    },
    "simulate: inputs"
  );

  const rows: Record<string, unknown>[] = [];
  let skippedUnsupported = 0;

  const flashFeeBps = assertFiniteNumber("FLASHLOAN_FEE_BPS", cfg.FLASHLOAN_FEE_BPS);
  const slippageBps = assertFiniteNumber("SLIPPAGE_BPS", cfg.SLIPPAGE_BPS);

  // FIX: Use the global watch threshold. If we are watching it, we should quote it.
  const quoteProxCutoff = cfg.LIQ_PROX_THRESHOLD;

  const WETH_ARB = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1" as const;
  const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;
  const USDT_ARB = "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9" as const;
  const DAI_ARB = "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1" as const;

  const UNSUPPORTED_TOKENS = new Set<string>([
    "0xddb46999f8891663a8f2828d25298f70416d7610", // sUSDS
  ]);

  function uniqFees(fees: number[]): number[] {
    const out: number[] = [];
    const seen = new Set<number>();
    for (const f of fees ?? []) {
      const n = Number(f);
      if (!Number.isFinite(n) || n <= 0) continue;
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
    return out;
  }

  const allowExecWithDegradedPricing = process.env.ALLOW_EXEC_WITH_DEGRADED_PRICING === "1";

  // Helper for concurrency
  async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = [];
    const executing: Promise<void>[] = [];
    for (const item of items) {
      const p = Promise.resolve().then(() => fn(item));
      results.push(p as any);
      const e: Promise<void> = p.then(() => {
        executing.splice(executing.indexOf(e), 1);
      });
      executing.push(e);
      if (executing.length >= limit) {
        await Promise.race(executing);
      }
    }
    return Promise.all(results);
  }

  const concurrency = 5; // Moderate concurrency to avoid RPC rate limits

  const results = await mapLimit(items, concurrency, async (c) => {
    const borrowUsd = Number(c.borrowUsd);
    const lltv = Number(c.lltv);
    const proximity = Number(c.proximity);

    const collatAddr = c.collateralToken.toLowerCase();
    const loanAddr = c.loanToken.toLowerCase();

    const collatSym = (c.collateralSymbol ?? "").toLowerCase();
    const loanSym = (c.loanSymbol ?? "").toLowerCase();

    if (
      UNSUPPORTED_TOKENS.has(collatAddr) ||
      UNSUPPORTED_TOKENS.has(loanAddr) ||
      collatSym === "susds" ||
      loanSym === "susds"
    ) {
      skippedUnsupported++;
      return null;
    }

    // If oracle/irm missing => cannot build Order safely (keep observability anyway)
    const oracle = c.oracle ?? "";
    const irm = c.irm ?? "";

    const repayUsd = Number.isFinite(borrowUsd) ? Math.min(borrowUsd, 10_000) : 10_000;

    const lif = lifFromLltv(lltv);
    const bonusPct = lif - 1.0;

    const flashFeeUsd = repayUsd * (flashFeeBps / 10_000);

    let quoteMode = "model_bps";
    let amountInCollat = "";
    let amountOutLoan = "";
    let amountOutUsdAdj: number | null = null;

    // NEW: route bytes persisted here
    let uniPath = "";

    const canQuote =
      cfg.QUOTE_ENABLED &&
      !UNSUPPORTED_TOKENS.has(collatAddr) &&
      !UNSUPPORTED_TOKENS.has(loanAddr) &&
      quoterOk &&
      c.collateralPriceUsd !== null &&
      c.loanPriceUsd !== null &&
      Number.isFinite(c.collateralPriceUsd) &&
      Number.isFinite(c.loanPriceUsd) &&
      c.collateralPriceUsd > 0 &&
      c.loanPriceUsd > 0 &&
      proximity >= quoteProxCutoff;

    let grossProfitUsd: number;
    let slippageUsd: number;

    if (canQuote) {
      const seizedUsd = repayUsd * lif;
      const collatTokens = seizedUsd / c.collateralPriceUsd!;
      const amountIn = toUnitsApprox(collatTokens, c.collateralDecimals);

      const feesToTry = uniqFees([100, 500, 3000, 10000, ...(cfg.QUOTE_FEES ?? [])]);

      // Optimization: Try quoteBest
      let qb: any = null;
      try {
        qb = await quoteBestExactInput({
          rpcUrl: cfg.ARB_RPC_URL,
          quoter: cfg.UNISWAP_V3_QUOTER_V2 as `0x${string}`,
          tokenIn: c.collateralToken,
          tokenOut: c.loanToken,
          amountIn,
          fees: feesToTry,
          intermediates: [WETH_ARB, USDC_ARB, USDT_ARB, DAI_ARB],
          maxFeesPerLeg: 3,
        });
      } catch (err: any) {
        // Log individual failure but don't crash
        // logger.debug({ candidateId: c.candidateId, err: err.message }, "quoteBest failed");
      }

      // IMPORTANT: we persist route bytes if service provides them
      uniPath = String(qb?.path ?? qb?.uniPath ?? qb?.route ?? "");

      if (qb && qb.amountOut > 0n) {
        quoteMode = qb.mode ?? "quoted";

        const outLoan = Number(formatUnits(qb.amountOut, c.loanDecimals));
        const outUsd = outLoan * c.loanPriceUsd!;
        const outUsdAfterSlip = outUsd * (1 - slippageBps / 10_000);

        amountInCollat = amountIn.toString();
        amountOutLoan = qb.amountOut.toString();
        amountOutUsdAdj = outUsdAfterSlip;

        grossProfitUsd = outUsdAfterSlip - repayUsd;
        slippageUsd = outUsd - outUsdAfterSlip;
      } else {
        quoteMode = "no_route";
        amountInCollat = amountIn.toString();
        amountOutLoan = "";
        amountOutUsdAdj = null;

        grossProfitUsd = -1e9;
        slippageUsd = 0;
      }
    } else {
      grossProfitUsd = repayUsd * bonusPct;
      slippageUsd = repayUsd * (slippageBps / 10_000);
    }

    const netProfitUsd = grossProfitUsd - estimatedGasUsd - flashFeeUsd - slippageUsd;

    const isQuoted = quoteMode !== "model_bps" && quoteMode !== "no_route" && amountOutLoan !== "";

    const execOk = (!pricingDegraded || allowExecWithDegradedPricing) && isQuoted;

    const passQuoted = execOk && netProfitUsd >= requiredNetUsd;
    const pass = passQuoted;

    const note =
      pricingDegraded && !allowExecWithDegradedPricing
        ? "pricing_degraded: blocked for exec"
        : !isQuoted
          ? "v0: NO_QUOTE (not executable)"
          : passQuoted
            ? "v0: QUOTED_PASS"
            : "v0: QUOTED_FAIL";

    return {
      ts: new Date().toISOString(),
      candidateId: c.candidateId,
      marketId: c.marketId,
      borrower: c.borrower,

      // NEW: persist addrs for building LiquidationExecutor.Order
      collateralToken: c.collateralToken,
      loanToken: c.loanToken,
      oracle,
      irm,
      lltvWad: c.lltvWad ?? "",

      collateral: c.collateralSymbol ?? "",
      loan: c.loanSymbol ?? "",
      status: c.status,
      reason: c.reason,

      lltv: c.lltv,
      proximity: c.proximity,

      repayUsd,
      lif,
      grossProfitUsd,

      estimatedGasUsd,
      flashFeeUsd,
      slippageUsd,
      netProfitUsd,
      requiredNetUsd,

      quoteMode,
      uniPath, // NEW: route bytes
      amountInCollat,
      amountOutLoan,
      amountOutUsdAdj: amountOutUsdAdj ?? "",

      pass: pass ? 1 : 0,
      isQuoted: isQuoted ? 1 : 0,
      passQuoted: passQuoted ? 1 : 0,
      passExec: passQuoted ? 1 : 0,
      passModel: quoteMode === "model_bps" && netProfitUsd >= requiredNetUsd ? 1 : 0,
      note,
    };
  });

  for (const r of results) {
    if (r) rows.push(r);
  }

  rows.sort((a, b) => Number((b as any).netProfitUsd) - Number((a as any).netProfitUsd));

  await writeCsv(
    dataPath("opportunities.csv"),
    [
      "ts",
      "candidateId",
      "marketId",
      "borrower",

      // NEW
      "collateralToken",
      "loanToken",
      "oracle",
      "irm",
      "lltvWad",

      "collateral",
      "loan",
      "status",
      "reason",
      "lltv",
      "proximity",
      "repayUsd",
      "lif",
      "grossProfitUsd",
      "estimatedGasUsd",
      "flashFeeUsd",
      "slippageUsd",
      "netProfitUsd",
      "requiredNetUsd",
      "quoteMode",

      // NEW
      "uniPath",

      "isQuoted",
      "passQuoted",
      "passExec",
      "passModel",
      "amountInCollat",
      "amountOutLoan",
      "amountOutUsdAdj",
      "pass",
      "note",
    ],
    rows
  );

  const considered = items.length;
  const produced = rows.length;

  let bestQuotedNet = -Infinity;
  let bestQuotedMode = "none";
  let bestExecNet = -Infinity;
  let bestExecMode = "none";
  let passesQuoted = 0;
  let passesExec = 0;

  for (const r of rows) {
    const net = Number((r as any).netProfitUsd);
    const isQuoted = Number((r as any).isQuoted) === 1 || (r as any).isQuoted === true;
    const passQuoted = Number((r as any).passQuoted) === 1 || (r as any).passQuoted === true;
    const passExec = Number((r as any).passExec) === 1 || (r as any).passExec === true;
    const mode = String((r as any).quoteMode ?? "unknown");

    if (passQuoted) passesQuoted++;
    if (passExec) passesExec++;

    if (isQuoted && Number.isFinite(net) && net > bestQuotedNet) {
      bestQuotedNet = net;
      bestQuotedMode = mode;
    }
    if (passExec && Number.isFinite(net) && net > bestExecNet) {
      bestExecNet = net;
      bestExecMode = mode;
    }
  }

  logger.info(
    {
      considered,
      produced,
      skippedUnsupported,
      pricingDegraded,
      allowExecWithDegradedPricing,
      passesQuoted,
      passesExec,
      bestQuotedNet,
      bestQuotedMode,
      bestExecNet,
      bestExecMode,
    },
    "simulate: wrote data/opportunities.csv"
  );

  const txSim = {
    generatedAt: new Date().toISOString(),
    requiredNetUsd,
    quoteEnabled: cfg.QUOTE_ENABLED,
    quoterOk,
    estimatedGasUsd,
    ethPrice: ethPriceInfo,
    pricingDegraded,
    allowExecWithDegradedPricing,
    diagnostics: {
      passesQuoted,
      passesExec,
      diagExecPass: passesExec > 0 ? 1 : 0,
      bestQuotedNet: Number.isFinite(bestQuotedNet) ? bestQuotedNet : null,
      bestQuotedMode,
      bestExecNet: Number.isFinite(bestExecNet) ? bestExecNet : null,
      bestExecMode,
      skippedUnsupported,
      considered,
      produced,
    },
  };

  await fs.writeFile(dataPath("tx_sim.json"), JSON.stringify(txSim, null, 2), "utf8");
}
