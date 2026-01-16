import "dotenv/config";
import { createPublicClient, http, getAddress, parseUnits, maxUint256 } from "viem";
import { arbitrum } from "viem/chains";
import fs from "node:fs";

function must<T>(v: T | undefined | null, msg: string): T {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) throw new Error(msg);
  return v;
}

function encodeV3Path(tokenIn: string, fee: number, tokenOut: string): `0x${string}` {
  // Uniswap V3 path: tokenIn (20) + fee (3) + tokenOut (20)
  const a = getAddress(tokenIn).slice(2);
  const b = getAddress(tokenOut).slice(2);
  const feeHex = fee.toString(16).padStart(6, "0");
  return (`0x${a}${feeHex}${b}`) as `0x${string}`;
}

function feeFromQuoteMode(mode: string): number {
  // Example: "quoterV2_fee_100" => 100
  const m = /fee_(\d+)$/.exec(mode);
  if (!m) throw new Error(`Cannot parse fee from quoteMode=${mode}`);
  return Number(m[1]);
}

async function main() {
  const executorArg = process.argv[2];
  if (!executorArg) {
    throw new Error("Usage: pnpm -s tsx scripts/dryrun_top_exec.ts <executorAddress>");
  }

  const rpc = must(process.env.ARB_RPC_URL, "Missing env ARB_RPC_URL");
  const executor = getAddress(executorArg);

  // Caller for eth_call context (msg.sender). Prefer explicit CALLER_ADDR.
  const caller = getAddress(must(process.env.CALLER_ADDR, "Missing env CALLER_ADDR (use your EOA, e.g. owner/treasury)"));

  const planRaw = fs.readFileSync("./data/tx_plan.json", "utf8");
  const plan = JSON.parse(planRaw);

  const execItem = (plan.items as any[]).find((x) => x.action === "EXEC");
  if (!execItem) throw new Error("No EXEC items found in data/tx_plan.json (execCount=0).");

  const marketId = execItem.marketId as `0x${string}`;
  const borrower = getAddress(execItem.borrower);
  const repayUsd = Number(execItem.repayUsd);
  const requiredNetUsd = Number(execItem.requiredNetUsd ?? 0.5);
  const quoteMode = String(execItem.quoteMode ?? "");

  // Morpho Blue core (from your deployed executor check). Override via MORPHO_ADDR if needed.
  const morphoAddr = getAddress(process.env.MORPHO_ADDR ?? "0x6c247b1F6182318877311737BaC0844bAa518F5e");

  const client = createPublicClient({ chain: arbitrum, transport: http(rpc) });

  // Morpho: idToMarketParams(bytes32) -> (loanToken, collateralToken, oracle, irm, lltv)
  const morphoAbi = [
    {
      type: "function",
      name: "idToMarketParams",
      stateMutability: "view",
      inputs: [{ name: "id", type: "bytes32" }],
      outputs: [
        { name: "loanToken", type: "address" },
        { name: "collateralToken", type: "address" },
        { name: "oracle", type: "address" },
        { name: "irm", type: "address" },
        { name: "lltv", type: "uint256" },
      ],
    },
  ] as const;

  const [loanToken, collateralToken, oracle, irm, lltv] = (await client.readContract({
    address: morphoAddr,
    abi: morphoAbi,
    functionName: "idToMarketParams",
    args: [marketId],
  })) as readonly [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, bigint];

  // ERC20 decimals/symbol
  const erc20Abi = [
    { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
    { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  ] as const;

  const [loanDecimals, loanSymbol, collSymbol] = await Promise.all([
    client.readContract({ address: getAddress(loanToken), abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address: getAddress(loanToken), abi: erc20Abi, functionName: "symbol" }).catch(() => "LOAN"),
    client.readContract({ address: getAddress(collateralToken), abi: erc20Abi, functionName: "symbol" }).catch(() => "COLL"),
  ]);

  // repayUsd in plan is assumed to be "loan token units" (OK for USDC-like loans)
  const repayAssets = parseUnits(repayUsd.toString(), Number(loanDecimals));

  // Aave flashloan premium (default 5 bps unless you changed)
  const flashFeeBps = BigInt(Number(process.env.FLASHLOAN_FEE_BPS ?? "5"));
  const premium = (repayAssets * flashFeeBps) / 10000n;

  const minProfit = parseUnits(requiredNetUsd.toString(), Number(loanDecimals));

  // Conservative: require repay + premium + minProfit out of swap
  const amountOutMin = repayAssets + premium + minProfit;

  const fee = feeFromQuoteMode(quoteMode);
  const uniPath = encodeV3Path(collateralToken, fee, loanToken);

  // IMPORTANT: default disable gasPrice guardrail unless you explicitly set it.
  const maxTxGasPrice = BigInt(process.env.MAX_TX_GAS_PRICE_WEI ?? "0");

  const nowSec = Math.floor(Date.now() / 1000);
  const deadline = BigInt(nowSec + Number(process.env.SWAP_DEADLINE_SEC ?? "120"));

  // ABI MUST MATCH Solidity struct order exactly:
  // market, borrower, repayAssets, repaidShares, seizedAssets, uniPath, amountOutMin, minProfit, deadline, maxTxGasPrice, referralCode, nonce
  const executorAbi = [
    {
      type: "function",
      name: "execute",
      stateMutability: "nonpayable",
      inputs: [
        {
          name: "order",
          type: "tuple",
          components: [
            {
              name: "market",
              type: "tuple",
              components: [
                { name: "loanToken", type: "address" },
                { name: "collateralToken", type: "address" },
                { name: "oracle", type: "address" },
                { name: "irm", type: "address" },
                { name: "lltv", type: "uint256" },
              ],
            },
            { name: "borrower", type: "address" },
            { name: "repayAssets", type: "uint256" },
            { name: "repaidShares", type: "uint256" },
            { name: "seizedAssets", type: "uint256" },
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

  const order = {
    market: { loanToken, collateralToken, oracle, irm, lltv },
    borrower,
    repayAssets,
    repaidShares: maxUint256, // close-factor capping inside Morpho via repaidShares
    seizedAssets: 0n,
    uniPath,
    amountOutMin,
    minProfit,
    deadline,
    maxTxGasPrice,
    referralCode: 0,
    nonce: 0n,
  } as const;

  console.log(JSON.stringify({
    picked: { marketId, borrower, plan: { repayUsd, requiredNetUsd, quoteMode } },
    marketParams: { loanToken, loanSymbol, loanDecimals: Number(loanDecimals), collateralToken, collSymbol, oracle, irm, lltv: lltv.toString() },
    order: {
      repayAssets: repayAssets.toString(),
      premium: premium.toString(),
      amountOutMin: amountOutMin.toString(),
      minProfit: minProfit.toString(),
      deadline: deadline.toString(),
      maxTxGasPrice: maxTxGasPrice.toString(),
      fee,
      uniPath,
      repaidShares: "MAX_UINT256",
      seizedAssets: "0",
    },
    caller,
    executor,
    morphoAddr,
  }, null, 2));

  try {
    const sim = await client.simulateContract({
      address: executor,
      abi: executorAbi,
      functionName: "execute",
      args: [order],
      account: caller,
    });

    console.log("\nSIMULATION: OK");
    console.log(JSON.stringify({ gas: sim.request.gas?.toString() }, null, 2));
  } catch (e: any) {
    console.error("\nSIMULATION: REVERT / ERROR");
    console.error(e?.shortMessage ?? e?.message ?? e);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
