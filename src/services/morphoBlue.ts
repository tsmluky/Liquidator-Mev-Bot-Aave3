import { createPublicClient, getAddress, http } from "viem";
import { arbitrum } from "viem/chains";

// Morpho Blue core contract view ABI (minimal).
// Struct layouts are from Morpho Blue core contract interface (Morpho.sol).
export const MORPHO_BLUE_ABI = [
  {
    type: "function",
    name: "market",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "totalSupplyAssets", type: "uint128" },
      { name: "totalSupplyShares", type: "uint128" },
      { name: "totalBorrowAssets", type: "uint128" },
      { name: "totalBorrowShares", type: "uint128" },
      { name: "lastUpdate", type: "uint128" },
      { name: "fee", type: "uint128" }
    ]
  },
  {
    type: "function",
    name: "position",
    stateMutability: "view",
    inputs: [
      { name: "id", type: "bytes32" },
      { name: "user", type: "address" }
    ],
    outputs: [
      { name: "supplyShares", type: "uint256" },
      { name: "borrowShares", type: "uint128" },
      { name: "collateral", type: "uint128" }
    ]
  }
] as const;

export type MarketTotals = {
  totalSupplyAssets: bigint;
  totalSupplyShares: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  lastUpdate: bigint;
  fee: bigint;
};

export type Position = {
  supplyShares: bigint;
  borrowShares: bigint;
  collateral: bigint;
};

export function defaultMorphoAddr(): `0x${string}` {
  // Morpho Blue core (override with MORPHO_ADDR env)
  return getAddress(process.env.MORPHO_ADDR ?? "0x6c247b1F6182318877311737BaC0844bAa518F5e");
}

export function getClient(rpcUrl: string) {
  return createPublicClient({ chain: arbitrum, transport: http(rpcUrl) });
}

export async function readMarketTotals(rpcUrl: string, marketId: `0x${string}`, morphoAddr?: `0x${string}`): Promise<MarketTotals> {
  const client = getClient(rpcUrl);
  const addr = morphoAddr ? getAddress(morphoAddr) : defaultMorphoAddr();

  const out = await client.readContract({
    address: addr,
    abi: MORPHO_BLUE_ABI,
    functionName: "market",
    args: [marketId]
  });

  const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee] = out as readonly [
    bigint, bigint, bigint, bigint, bigint, bigint
  ];

  return { totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee };
}

export async function readPosition(rpcUrl: string, marketId: `0x${string}`, user: `0x${string}`, morphoAddr?: `0x${string}`): Promise<Position> {
  const client = getClient(rpcUrl);
  const addr = morphoAddr ? getAddress(morphoAddr) : defaultMorphoAddr();

  const out = await client.readContract({
    address: addr,
    abi: MORPHO_BLUE_ABI,
    functionName: "position",
    args: [marketId, user]
  });

  const [supplyShares, borrowShares, collateral] = out as readonly [bigint, bigint, bigint];
  return { supplyShares, borrowShares, collateral };
}

// assets -> shares rounding UP
export function assetsToSharesUp(assets: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  if (assets <= 0n) return 0n;
  if (totalAssets === 0n || totalShares === 0n) throw new Error("assetsToSharesUp: zero totals");
  return (assets * totalShares + totalAssets - 1n) / totalAssets;
}

// shares -> assets rounding DOWN (for borrow amount / collateral value)
export function sharesToAssetsDown(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  if (shares <= 0n) return 0n;
  if (totalShares === 0n) return 0n; // safe fallback
  return (shares * totalAssets) / totalShares;
}

// shares -> assets rounding UP (conservative debt calc)
export function sharesToAssetsUp(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  if (shares <= 0n) return 0n;
  if (totalShares === 0n) return 0n;
  return (shares * totalAssets + totalShares - 1n) / totalShares;
}
