import "dotenv/config";
import { createPublicClient, http, parseAbi, formatUnits } from "viem";
import { arbitrum } from "viem/chains";

const RPC =
  process.env.ARB_RPC_URL ||
  process.env.ARBITRUM_RPC_URL ||
  process.env.RPC_URL;

if (!RPC) {
  console.error("Missing RPC url. Set one of: ARB_RPC_URL / ARBITRUM_RPC_URL / RPC_URL");
  process.exit(1);
}

const client = createPublicClient({ chain: arbitrum, transport: http(RPC) });

// Official Uniswap V3 Factory on Arbitrum
const UNIV3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";

const factoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)"
]);

const poolAbi = parseAbi([
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function liquidity() external view returns (uint128)",
  "function slot0() external view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)"
]);

const erc20Abi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)"
]);

function priceFromSqrtX96(sqrtPriceX96: bigint): number {
  // price token1 per token0 (raw, without decimals adj)
  const Q96 = 2n ** 96n;
  const num = sqrtPriceX96 * sqrtPriceX96;
  // Use JS number (approx) – sufficient for sanity checks
  return Number(num) / Number(Q96 * Q96);
}

async function tokenMeta(addr: `0x${string}`) {
  const [sym, dec] = await Promise.all([
    client.readContract({ address: addr, abi: erc20Abi, functionName: "symbol" }).catch(() => "<?>"),
    client.readContract({ address: addr, abi: erc20Abi, functionName: "decimals" }).catch(() => 255),
  ]);
  return { sym: String(sym), dec: Number(dec) };
}

async function main() {
  const [tokenA, tokenB] = process.argv.slice(2) as (`0x${string}`)[];
  if (!tokenA || !tokenB) {
    console.error("Usage: pnpm tsx scripts/pool_probe.ts <tokenA> <tokenB>");
    process.exit(1);
  }

  const fees = [100, 500, 3000, 10000] as const;

  const metaA = await tokenMeta(tokenA);
  const metaB = await tokenMeta(tokenB);

  console.log(`tokenA=${tokenA} (${metaA.sym}, dec=${metaA.dec})`);
  console.log(`tokenB=${tokenB} (${metaB.sym}, dec=${metaB.dec})`);
  console.log("");

  for (const fee of fees) {
    const pool = await client.readContract({
      address: UNIV3_FACTORY,
      abi: factoryAbi,
      functionName: "getPool",
      args: [tokenA, tokenB, fee],
    });

    if (!pool || pool === "0x0000000000000000000000000000000000000000") {
      console.log(`fee=${fee}: no pool`);
      continue;
    }

    const [t0, t1, liq, slot0] = await Promise.all([
      client.readContract({ address: pool, abi: poolAbi, functionName: "token0" }),
      client.readContract({ address: pool, abi: poolAbi, functionName: "token1" }),
      client.readContract({ address: pool, abi: poolAbi, functionName: "liquidity" }),
      client.readContract({ address: pool, abi: poolAbi, functionName: "slot0" }),
    ]);

    const { sym: s0, dec: d0 } = await tokenMeta(t0 as `0x${string}`);
    const { sym: s1, dec: d1 } = await tokenMeta(t1 as `0x${string}`);

    const sqrtPriceX96 = (slot0 as any)[0] as bigint;
    const rawP = priceFromSqrtX96(sqrtPriceX96); // token1 per token0 raw
    // Adjust for decimals: token1/token0 * 10^(dec0-dec1)
    const adjP = rawP * Math.pow(10, d0 - d1);

    console.log(`fee=${fee}: pool=${pool}`);
    console.log(`  token0=${t0} (${s0}, dec=${d0})`);
    console.log(`  token1=${t1} (${s1}, dec=${d1})`);
    console.log(`  liquidity=${liq.toString()}`);
    console.log(`  spot price ~ ${adjP} ${s1}/${s0}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
