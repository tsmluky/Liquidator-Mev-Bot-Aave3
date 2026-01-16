import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";

const ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut,uint160 sqrtPriceAfterX96,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);

// QuoterV2 on Arbitrum One (42161). Esto coincide con tu smoke test.
const DEFAULT_QUOTER_V2_ARBITRUM = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e" as const;

export type QuoteSingleArgs = {
  rpcUrl: string;
  quoter?: `0x${string}`; // opcional: si no lo pasás, usa default Arbitrum
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  fee: number; // uint24
  amountIn: bigint;
};

function assertRpcUrl(rpcUrl: string) {
  if (typeof rpcUrl !== "string" || rpcUrl.length < 8) {
    throw new Error(`Invalid rpcUrl: ${String(rpcUrl)}`);
  }
}

async function rpcCall(rpcUrl: string, method: string, params: any[]): Promise<any> {
  assertRpcUrl(rpcUrl);

  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`RPC ${method} failed: HTTP ${res.status} :: ${text.slice(0, 300)}`);

  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`RPC ${method} returned non-JSON: ${text.slice(0, 300)}`);
  }
  if (json?.error) throw new Error(`RPC ${method} error: ${JSON.stringify(json.error).slice(0, 300)}`);
  return json?.result;
}

export async function getCode(rpcUrl: string, addr: `0x${string}`): Promise<string> {
  return await rpcCall(rpcUrl, "eth_getCode", [addr, "latest"]);
}

export async function quoteExactInputSingle(args: QuoteSingleArgs): Promise<{
  amountOut: bigint;
  gasEstimate: bigint;
}> {
  const quoter = (args.quoter ?? (DEFAULT_QUOTER_V2_ARBITRUM as `0x${string}`));

  // Validación fuerte: si estás llamando a algo sin bytecode, o address basura, cortamos acá.
  const code = await getCode(args.rpcUrl, quoter);
  if (typeof code !== "string" || code === "0x") {
    throw new Error(`Quoter has no bytecode at ${quoter} (check UNISWAP_V3_QUOTER_V2 + chain/rpc)`);
  }

  const data = encodeFunctionData({
    abi: ABI,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: args.tokenIn,
        tokenOut: args.tokenOut,
        amountIn: args.amountIn,
        fee: args.fee,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });

  const result = await rpcCall(args.rpcUrl, "eth_call", [{ to: quoter, data }, "latest"]);

  const decoded = decodeFunctionResult({
    abi: ABI,
    functionName: "quoteExactInputSingle",
    data: result,
  }) as readonly [bigint, bigint, number, bigint];

  return {
    amountOut: decoded[0],
    gasEstimate: decoded[3],
  };
}
