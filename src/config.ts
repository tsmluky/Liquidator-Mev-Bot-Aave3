import "dotenv/config";
import { getAddress } from "viem";

export type AppConfig = {
  // Arbitrum L1 fee model (rough)
  CALLDATA_BYTES: number;
  ARB_GASINFO_ADDR: string;
  // Chain / RPC
  CHAIN_ID: number;
  ARB_RPC_URL: string;
  PRIVATE_KEY?: string;

  // Morpho GraphQL
  MORPHO_API_URL: string;
  MAX_MARKETS: number;
  MAX_POSITIONS_PER_MARKET: number;
  HOT_QUEUE_SIZE: number;

  // Thresholds (watch/exec)
  LIQ_PROX_THRESHOLD: number;   // watch threshold (e.g. 0.98)
  EXEC_PROX_THRESHOLD: number;  // exec-ready threshold (e.g. 1.0)

  // Budgets / risk
  BUDGET_WEEKLY_USD: number;
  BUDGET_DAILY_USD: number;
  MAX_ATTEMPTS_PER_HOUR: number;
  MIN_PROFIT_NET_USD: number;
  SAFETY_BUFFER_USD: number;

  // Aave V3
  AAVE_UI_POOL_DATA_PROVIDER: string;
  AAVE_POOL_ADDRESS_PROVIDER: string;

  // Simulator
  GAS_LIMIT: number;
  GAS_PRICE_MULTIPLIER: number;
  SLIPPAGE_BPS: number;
  FLASHLOAN_FEE_BPS: number;
  ETH_PRICE_USD?: number;

  MAX_TX_GAS_PRICE_WEI: bigint; // strict cap
  TX_PRIORITY_FEE_WEI: bigint;  // miner tip


  // Morpho paging safety
  POSITIONS_FIRST: number;
  MORPHO_MAX_FIRST: number;

  // Uniswap
  UNISWAP_V3_SWAPROUTER02: string;
  UNISWAP_V3_QUOTER_V2: string;
  WETH_ADDRESS: string;

  // Quote behavior
  QUOTE_ENABLED: boolean;
  QUOTE_FEES: number[]; // try in order, e.g. [500,3000,10000]
};

function str(name: string, def?: string): string {
  const v = process.env[name]?.trim();
  if (v && v.length > 0) return v;
  if (def !== undefined) return def;
  throw new Error(`Missing env ${name}`);
}

function num(name: string, def: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid env ${name}=${raw}`);
  return n;
}

function optNum(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid env ${name}=${raw}`);
  return n;
}

function bool(name: string, def: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return def;
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  throw new Error(`Invalid env ${name}=${process.env[name]}`);
}

function listNums(name: string, def: number[]): number[] {
  const raw = process.env[name]?.trim();
  if (!raw) return def;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const arr = parts.map((p) => {
    const n = Number(p);
    if (!Number.isFinite(n)) throw new Error(`Invalid env ${name} item=${p}`);
    return Math.trunc(n);
  });
  if (!arr.length) return def;
  return arr;
}

function privateKey(): string | undefined {
  const v = process.env.PRIVATE_KEY?.trim();
  if (!v) return undefined;
  if (v.includes("REPLACE_ME")) return undefined;
  if (v === "0x" || v.length < 10) return undefined;
  return v;
}

export function loadConfig(): AppConfig {
  // Compat: si alguien usa WATCH_PROX_THRESHOLD en vez de LIQ_PROX_THRESHOLD
  const watchTh = num("LIQ_PROX_THRESHOLD", num("WATCH_PROX_THRESHOLD", 0.94));
  const execTh = num("EXEC_PROX_THRESHOLD", 1.0);

  return {
    CHAIN_ID: Math.trunc(num("CHAIN_ID", 42161)),
    ARB_RPC_URL: str("ARB_RPC_URL", "https://arbitrum.llamarpc.com"),
    PRIVATE_KEY: privateKey(),

    MORPHO_API_URL: str("MORPHO_API_URL", "https://api.morpho.org/graphql"),
    MAX_MARKETS: Math.trunc(num("MAX_MARKETS", 50)),
    MAX_POSITIONS_PER_MARKET: Math.trunc(num("MAX_POSITIONS_PER_MARKET", 1000)),
    HOT_QUEUE_SIZE: Math.trunc(num("HOT_QUEUE_SIZE", 100)),

    LIQ_PROX_THRESHOLD: watchTh,
    EXEC_PROX_THRESHOLD: execTh,

    CALLDATA_BYTES: Math.trunc(num("CALLDATA_BYTES", 64)),
    ARB_GASINFO_ADDR: str("ARB_GASINFO_ADDR", "0x000000000000000000000000000000000000006C"),

    BUDGET_WEEKLY_USD: num("BUDGET_WEEKLY_USD", 10),
    BUDGET_DAILY_USD: num("BUDGET_DAILY_USD", 2),
    MAX_ATTEMPTS_PER_HOUR: Math.trunc(num("MAX_ATTEMPTS_PER_HOUR", 30)),
    // Removed duplicates, keeping safety overrides below


    GAS_LIMIT: Math.trunc(num("GAS_LIMIT", 1_200_000)),
    GAS_PRICE_MULTIPLIER: num("GAS_PRICE_MULTIPLIER", 1.5), // Aggressive bidding (was 1.15)
    SLIPPAGE_BPS: Math.trunc(num("SLIPPAGE_BPS", 50)),       // 0.5% max slippage
    FLASHLOAN_FEE_BPS: Math.trunc(num("FLASHLOAN_FEE_BPS", 5)),
    ETH_PRICE_USD: optNum("ETH_PRICE_USD"),

    // Safety / Risk Management (Strict Defaults)
    // Cap max gas price to 10 gwei (10e9) to prevent draining wallet during spikes
    MAX_TX_GAS_PRICE_WEI: BigInt(process.env.MAX_TX_GAS_PRICE_WEI ?? "10000000000"),
    // Ensure at least $2 net profit
    MIN_PROFIT_NET_USD: num("MIN_PROFIT_NET_USD", 2.0),
    // Buffer for estimation errors
    SAFETY_BUFFER_USD: num("SAFETY_BUFFER_USD", 2.0),

    // Aave V3
    AAVE_UI_POOL_DATA_PROVIDER: str(
      "AAVE_UI_POOL_DATA_PROVIDER",
      // Default to Arbitrum if not specified, or Base if chain ID matches (logic below)
      process.env.CHAIN_ID === "8453"
        ? getAddress("0xb84A20e848baE3e13897934bB4e74E2225f4546B") // Base (Canonical)
        : getAddress("0x13c833256BD767da2320d727a3691BAff3770E39") // Arbitrum (Canonical)
    ),
    AAVE_POOL_ADDRESS_PROVIDER: str(
      "AAVE_POOL_ADDRESS_PROVIDER",
      process.env.CHAIN_ID === "8453"
        ? getAddress("0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D") // Base (Canonical)
        : getAddress("0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb") // Arbitrum (Canonical)
    ),

    // Aggressive Gas Strategy: Priority Fee (Miner Tip)
    TX_PRIORITY_FEE_WEI: BigInt(process.env.TX_PRIORITY_FEE_WEI ?? "3000000000"), // Default 3 gwei


    POSITIONS_FIRST: Math.trunc(num("POSITIONS_FIRST", 1000)),
    MORPHO_MAX_FIRST: Math.trunc(num("MORPHO_MAX_FIRST", 1000)),

    UNISWAP_V3_SWAPROUTER02: str(
      "UNISWAP_V3_SWAPROUTER02",
      "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"
    ),
    UNISWAP_V3_QUOTER_V2: str(
      "UNISWAP_V3_QUOTER_V2",
      "0x61fFE014bA17989E743c5F6cB21bF9697530B21e"
    ),
    WETH_ADDRESS: str(
      "WETH_ADDRESS",
      "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"
    ),

    QUOTE_ENABLED: bool("QUOTE_ENABLED", true),
    QUOTE_FEES: listNums("QUOTE_FEES", [500, 3000, 10000]),
  };
}

