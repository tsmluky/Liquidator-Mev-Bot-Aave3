import "dotenv/config";
import { createPublicClient, http, getAddress, parseUnits, maxUint256 } from "viem";
import { arbitrum } from "viem/chains";
import fs from "node:fs";

function must<T>(v: T | undefined | null, msg: string): T {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) throw new Error(msg);
  return v;
}

function encodeV3Path(tokenIn: string, fee: number, tokenOut: string): `0x${string}` {
  const a = getAddress(tokenIn).slice(2);
  const b = getAddress(tokenOut).slice(2);
  const feeHex = fee.toString(16).padStart(6, "0");
  return (`0x${a}${feeHex}${b}`) as `0x${string}`;
}

function feeFromQuoteMode(mode: string): number {
  const m = /fee_(\d+)$/.exec(mode);
  if (!m) throw new Error(`Cannot parse fee from quoteMode=${mode}`);
  return Number(m[1]);
}

async function main() {
  const executorArg = process.argv[2];
  if (!executorArg) throw new Error("Usage: pnpm -s tsx scripts/dryrun_exec_all.ts <executorAddress>");

  const rpc = must(process.env.ARB_RPC_URL, "Missing env ARB_RPC_URL");
  const executor = getAddress(executorArg);
  const caller = getAddress(must(process.env.CALLER_ADDR, "Missing env CALLER_ADDR"));

  const morphoAddr = getAddress(process.env.MORPHO_ADDR ?? "0x6c247b1F6182318877311737BaC0844bAa518F5e");
  const maxTxGasPrice = BigInt(process.env.MAX_TX_GAS_PRICE_WEI ?? "0");
  const flashFeeBps = BigInt(Number(process.env.FLASHLOAN_FEE_BPS ?? "5"));
  const deadlineSec = Number(process.env.SWAP_DEADLINE_SEC ?? "120");

  const plan = JSON.parse(fs.readFileSync("./data/tx_plan.json", "utf8"));
  const execItems = (plan.items as any[]).filter((x) => x.action === "EXEC");
  if (!execItems.length) throw new Error("No EXEC items in data/tx_plan.json");

  const client = createPublicClient({ chain: arbitrum, transport: http(rpc) });

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

  const erc20Abi = [
    { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
    { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  ] as const;

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

  for (const it of execItems) {
    const marketId = it.marketId as `0x${string}`;
    const borrower = getAddress(it.borrower);
    const repayUsd = Number(it.repayUsd);
    const requiredNetUsd = Number(it.requiredNetUsd ?? 0.5);
    const quoteMode = String(it.quoteMode ?? "");
    const fee = feeFromQuoteMode(quoteMode);

    const [loanToken, collateralToken, oracle, irm, lltv] = (await client.readContract({
      address: morphoAddr,
      abi: morphoAbi,
      functionName: "idToMarketParams",
      args: [marketId],
    })) as readonly [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, bigint];

    const loanDecimals = await client.readContract({ address: getAddress(loanToken), abi: erc20Abi, functionName: "decimals" });
    const loanSymbol = await client.readContract({ address: getAddress(loanToken), abi: erc20Abi, functionName: "symbol" }).catch(() => "LOAN");
    const collSymbol = await client.readContract({ address: getAddress(collateralToken), abi: erc20Abi, functionName: "symbol" }).catch(() => "COLL");

    const repayAssets = parseUnits(repayUsd.toString(), Number(loanDecimals));
    const premium = (repayAssets * flashFeeBps) / 10000n;
    const minProfit = parseUnits(requiredNetUsd.toString(), Number(loanDecimals));
    const amountOutMin = repayAssets + premium + minProfit;

    const uniPath = encodeV3Path(collateralToken, fee, loanToken);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSec);

    const order = {
      market: { loanToken, collateralToken, oracle, irm, lltv },
      borrower,
      repayAssets,
      repaidShares: maxUint256,
      seizedAssets: 0n,
      uniPath,
      amountOutMin,
      minProfit,
      deadline,
      maxTxGasPrice,
      referralCode: 0,
      nonce: 0n,
    } as const;

    process.stdout.write(`\n--- EXEC CANDIDATE ---\n${marketId} | ${borrower} | repay=${repayUsd} ${loanSymbol} | coll=${collSymbol}\n`);

    try {
      const sim = await client.simulateContract({
        address: executor,
        abi: executorAbi,
        functionName: "execute",
        args: [order],
        account: caller,
      });
      console.log("SIMULATION: OK", { gas: sim.request.gas?.toString() });
    } catch (e: any) {
      console.log("SIMULATION: FAIL", e?.shortMessage ?? e?.message ?? e);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
