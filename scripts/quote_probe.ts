import "dotenv/config";
import { formatUnits } from "viem";

// IMPORTANTE: esto debe apuntar al MISMO módulo que usa simulate.ts
import { quoteExactInputSingle } from "../src/services/uniswapQuoterV2.js";

const RPC =
  process.env.ARB_RPC_URL ||
  process.env.ARBITRUM_RPC_URL ||
  process.env.RPC_URL;

if (!RPC) {
  console.error("Missing RPC url. Set one of: ARB_RPC_URL / ARBITRUM_RPC_URL / RPC_URL (in .env or env vars)");
  process.exit(1);
}

const thBILL = "0xfdd22ce6d1f66bc0ec89b20bf16ccb6670f55a5a";
const USDC   = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";

// amountInCollat (thBILL dec=6)
const amountIn = 10038093728n;

const fees = [100, 500, 3000, 10000];

async function main() {
  for (const fee of fees) {
    try {
      const q: any = await quoteExactInputSingle({
        rpcUrl: RPC,
        tokenIn: thBILL,
        tokenOut: USDC,
        fee,
        amountIn,
      });

      const out = BigInt(q.amountOut ?? q.amountOutLoan ?? q.out ?? q.amountOutRaw ?? 0n);
      console.log(`fee=${fee} OK out=${out.toString()} (${formatUnits(out, 6)} USDC)`);
    } catch (e: any) {
      console.log(`fee=${fee} FAIL -> ${e?.shortMessage ?? e?.message ?? String(e)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
