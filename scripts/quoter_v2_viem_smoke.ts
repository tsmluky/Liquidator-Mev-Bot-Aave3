import "dotenv/config";
import { createPublicClient, http, parseAbi, formatUnits } from "viem";
import { arbitrum } from "viem/chains";

const RPC =
  process.env.ARB_RPC_URL ||
  process.env.ARBITRUM_RPC_URL ||
  process.env.RPC_URL;

if (!RPC) {
  console.error("Missing RPC url. Set ARB_RPC_URL / ARBITRUM_RPC_URL / RPC_URL");
  process.exit(1);
}

const client = createPublicClient({ chain: arbitrum, transport: http(RPC) });

// Uniswap V3 QuoterV2 on Arbitrum (42161)
const QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";

const ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)"
]);

const thBILL = "0xfdd22ce6d1f66bc0ec89b20bf16ccb6670f55a5a";
const USDC   = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";

// tu amountInCollat (thBILL dec=6)
const amountIn = 10038093728n;

// probamos fee=100 primero (tu pool_probe dice que es el que tiene liquidez real)
const fee = 100;

async function main() {
  const chainId = await client.getChainId();
  const code = await client.getBytecode({ address: QUOTER_V2 });
  console.log("chainId:", chainId);
  console.log("quoterV2 bytecode length:", code ? (code.length - 2) / 2 : 0);

  const sim = await client.simulateContract({
    address: QUOTER_V2,
    abi: ABI,
    functionName: "quoteExactInputSingle",
    args: [{
      tokenIn: thBILL,
      tokenOut: USDC,
      amountIn,
      fee,
      sqrtPriceLimitX96: 0n
    }]
  });

  const [amountOut, sqrtAfter, ticksCrossed, gasEstimate] = sim.result as any;
  console.log("amountOut raw:", amountOut.toString());
  console.log("amountOut:", formatUnits(amountOut, 6), "USDC");
  console.log("gasEstimate:", gasEstimate.toString());
  console.log("sqrtAfter:", sqrtAfter.toString(), "ticksCrossed:", ticksCrossed);
}

main().catch((e) => {
  console.error(e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
