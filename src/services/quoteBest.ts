import { createPublicClient, http, encodeFunctionData, decodeFunctionResult, parseAbi } from "viem";
import { arbitrum } from "viem/chains";

export type QuoteFail = {
  fee: number;
  leg: "single" | "hop1" | "hop2";
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountIn: string;
  msg: string;
};

export type QuoteBestResult = {
  amountOut: bigint;
  mode: string;   // e.g. "quoterV2_fee_500" | "quoterV2_2hop_usdt_500_3000"
  route: string;  // e.g. "single" | "tokenIn->MID->tokenOut"

  // NEW: Uniswap V3 path bytes for SwapRouter02.exactInput
  path: `0x${string}`;

  attempts: number;
  fails: number;
  firstFail: QuoteFail | null;
};

type Args = {
  rpcUrl: string;
  quoter: `0x${string}`;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountIn: bigint;
  fees: number[];
  intermediates: `0x${string}`[];
  maxFeesPerLeg?: number; // default 3
};

const ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut,uint160 sqrtPriceAfterX96,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);

function takeFirstN<T>(arr: T[], n: number): T[] {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, Math.max(0, n));
}

function normAddr(a: `0x${string}`): string {
  return a.toLowerCase();
}

function hexNo0x(h: string): string {
  return h.startsWith("0x") ? h.slice(2) : h;
}

function padFee3Bytes(fee: number): string {
  // fee is uint24
  const f = Math.trunc(Number(fee));
  if (!Number.isFinite(f) || f < 0 || f > 1_000_000) throw new Error(`Invalid fee tier: ${fee}`);
  return f.toString(16).padStart(6, "0");
}

function encodeV3Path(tokens: `0x${string}`[], fees: number[]): `0x${string}` {
  if (tokens.length < 2) throw new Error("encodeV3Path: need at least 2 tokens");
  if (fees.length !== tokens.length - 1) throw new Error("encodeV3Path: fees length mismatch");

  let out = "";
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = hexNo0x(tokens[i]);
    const b = hexNo0x(tokens[i + 1]);
    if (a.length !== 40 || b.length !== 40) throw new Error("encodeV3Path: bad token address length");
    const feeHex = padFee3Bytes(fees[i]);
    if (i === 0) out += a;
    out += feeHex + b;
  }
  return ("0x" + out) as `0x${string}`;
}

export async function quoteBestExactInput(args: Args): Promise<QuoteBestResult | null> {
  const maxFeesPerLeg = Number.isFinite(args.maxFeesPerLeg) ? Number(args.maxFeesPerLeg) : 3;
  const feesMulti = takeFirstN(args.fees, Math.max(1, Math.trunc(maxFeesPerLeg)));

  // 1. Build all calls (Single Hop + 2-Hop)
  type CallMeta = {
    type: "single" | "hop1" | "hop2";
    tokenIn: `0x${string}`;
    tokenOut: `0x${string}`;
    fee: number;
    mid?: `0x${string}`;
    fee1?: number; // for hop2, reference to parent fee
    hop1Index?: number; // for hop2, index of the hop1 call
  };

  // We need to do this in two passes or effectively flat list.
  // For 2-hop, we technically need the Output of Hop1 to be the Input of Hop2. 
  // Standard Multicall doesn't support chaining outputs (unless we use a specific aggregator contract).
  // ARBITRUM ONE supports standard Multicall3.
  // LIMITATION: We cannot do pure 1-request 2-hop because we don't know the amountOut of hop1 to pass as amountIn to hop2.
  // 
  // OPTIMIZATION STRATEGY "CHAINED BATCH":
  // Batch 1: All Single Hops + All Hop1 legs (TokenIn -> Mid)
  // Batch 2: All Hop2 legs (Mid -> TokenOut) using the results from Batch 1.
  // 
  // This reduces N calls to 2 calls. Still massive improvement over 50.

  const client = createPublicClient({
    chain: arbitrum,
    transport: http(args.rpcUrl),
    batch: { multicall: true } // Viem handles auto-batching if we use it, but we'll do explicit multicall
  });

  // --- STAGE 1: Single Hops & Leg 1 of 2-Hops ---

  const callsStage1: any[] = [];
  const metaStage1: CallMeta[] = [];

  // A) Single Hops
  for (const fee of args.fees) {
    callsStage1.push({
      address: args.quoter,
      abi: ABI,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn: args.tokenIn, tokenOut: args.tokenOut, amountIn: args.amountIn, fee, sqrtPriceLimitX96: 0n }]
    });
    metaStage1.push({ type: "single", tokenIn: args.tokenIn, tokenOut: args.tokenOut, fee });
  }

  // B) Leg 1 of 2-Hops
  const intermediates = args.intermediates.filter(m =>
    normAddr(m) !== normAddr(args.tokenIn) && normAddr(m) !== normAddr(args.tokenOut)
  );

  for (const mid of intermediates) {
    for (const fee of feesMulti) {
      callsStage1.push({
        address: args.quoter,
        abi: ABI,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn: args.tokenIn, tokenOut: mid, amountIn: args.amountIn, fee, sqrtPriceLimitX96: 0n }]
      });
      metaStage1.push({ type: "hop1", tokenIn: args.tokenIn, tokenOut: mid, fee, mid });
    }
  }

  // EXECUTE STAGE 1
  const results1 = await client.multicall({ contracts: callsStage1 });

  let bestOut: bigint | null = null;
  let bestSingleRes: QuoteBestResult | null = null;
  let attempts = 0;
  let fails = 0;
  let firstFail: QuoteFail | null = null;

  // Process Stage 1 Results
  const validHop1: { mid: `0x${string}`; amountOut: bigint; fee1: number }[] = [];

  results1.forEach((res, idx) => {
    attempts++;
    const meta = metaStage1[idx];

    if (res.status === "success") {
      // decoded[0] is amountOut
      const out = (res.result as any)[0] as bigint;

      if (meta.type === "single") {
        if (bestOut === null || out > bestOut) {
          bestOut = out;
          bestSingleRes = {
            amountOut: out,
            mode: `quoterV2_fee_${meta.fee}`,
            route: "single",
            path: encodeV3Path([args.tokenIn, args.tokenOut], [meta.fee]),
            attempts: 0, // aggregate later
            fails: 0,
            firstFail: null
          };
        }
      } else if (meta.type === "hop1") {
        if (out > 0n) {
          validHop1.push({ mid: meta.mid!, amountOut: out, fee1: meta.fee });
        }
      }
    } else {
      fails++;
      if (!firstFail) firstFail = {
        fee: meta.fee,
        leg: meta.type,
        tokenIn: meta.tokenIn,
        tokenOut: meta.tokenOut,
        amountIn: args.amountIn.toString(),
        msg: "Reverted" // We don't get exact msg in standard multicall easily without iterating
      };
    }
  });

  // --- STAGE 2: Leg 2 of 2-Hops ---
  // Only for successful leg1s

  if (validHop1.length === 0) {
    // No need for stage 2
    return fillStats(bestSingleRes, attempts, fails, firstFail);
  }

  const callsStage2: any[] = [];
  const metaStage2: CallMeta[] = [];

  for (const h1 of validHop1) {
    for (const fee2 of feesMulti) {
      callsStage2.push({
        address: args.quoter,
        abi: ABI,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn: h1.mid, tokenOut: args.tokenOut, amountIn: h1.amountOut, fee: fee2, sqrtPriceLimitX96: 0n }]
      });
      metaStage2.push({
        type: "hop2",
        tokenIn: h1.mid,
        tokenOut: args.tokenOut,
        fee: fee2,
        fee1: h1.fee1,
        mid: h1.mid
      });
    }
  }

  if (callsStage2.length > 0) {
    const results2 = await client.multicall({ contracts: callsStage2 });

    results2.forEach((res, idx) => {
      attempts++;
      const meta = metaStage2[idx];

      if (res.status === "success") {
        const out = (res.result as any)[0] as bigint;
        if (bestOut === null || out > bestOut) {
          bestOut = out;

          const midName = getMidName(meta.mid!);
          bestSingleRes = { // reusing variable calling it 'winner'
            amountOut: out,
            mode: `quoterV2_2hop_${midName}_${meta.fee1}_${meta.fee}`,
            route: `${args.tokenIn}->${meta.mid}->${args.tokenOut}`,
            path: encodeV3Path([args.tokenIn, meta.mid!, args.tokenOut], [meta.fee1!, meta.fee]),
            attempts: 0,
            fails: 0,
            firstFail: null
          };
        }
      } else {
        fails++;
      }
    });
  }

  return fillStats(bestSingleRes, attempts, fails, firstFail);
}

function fillStats(res: QuoteBestResult | null, attempts: number, fails: number, firstFail: QuoteFail | null) {
  if (res) {
    res.attempts = attempts;
    res.fails = fails;
    res.firstFail = firstFail;
  }
  return res;
}

function getMidName(addr: string): string {
  const lower = addr.toLowerCase();
  if (lower.includes("82af4944")) return "weth";
  if (lower.includes("af88d065")) return "usdc";
  if (lower.includes("fd086bc7")) return "usdt";
  if (lower.includes("da10009")) return "dai";
  return "mid";
}

