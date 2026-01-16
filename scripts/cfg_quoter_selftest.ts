import "dotenv/config";
import { loadConfig } from "../src/config.js";
import { getCode, quoteExactInputSingle } from "../src/services/uniswapQuoterV2.js";
import { formatUnits } from "viem";

async function main() {
  const cfg = loadConfig();

  console.log("ARB_RPC_URL set:", !!cfg.ARB_RPC_URL);
  console.log("UNISWAP_V3_QUOTER_V2:", cfg.UNISWAP_V3_QUOTER_V2);
  console.log("QUOTE_FEES:", cfg.QUOTE_FEES);

  const thBILL = "0xfdd22ce6d1f66bc0ec89b20bf16ccb6670f55a5a";
  const USDC   = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
  const amountIn = 10038093728n;

  // Nota: el servicio ahora valida bytecode y usa default QuoterV2 de Arbitrum si no pasas quoter.
  const q = await quoteExactInputSingle({
    rpcUrl: cfg.ARB_RPC_URL,
    tokenIn: thBILL,
    tokenOut: USDC,
    fee: 100,
    amountIn,
  });

  console.log("quote fee=100 amountOut:", q.amountOut.toString(), `(${formatUnits(q.amountOut, 6)} USDC)`);
  console.log("gasEstimate:", q.gasEstimate.toString());

  const code = await getCode(cfg.ARB_RPC_URL, "0x61fFE014bA17989E743c5F6cB21bF9697530B21e");
  console.log("known quoter bytecode len:", code ? (code.length - 2) / 2 : 0);
}

main().catch((e) => {
  console.error(e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
