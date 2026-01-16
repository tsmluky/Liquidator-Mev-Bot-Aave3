import "dotenv/config";
import { createPublicClient, http, parseAbi } from "viem";
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

const erc20 = parseAbi([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
]);

async function main() {
  const addrs = process.argv.slice(2);
  if (addrs.length === 0) {
    console.error("Usage: pnpm tsx scripts/token_meta.ts <tokenAddr...>");
    process.exit(1);
  }

  for (const address of addrs) {
    const [symbol, name, decimals] = await Promise.all([
      client.readContract({ address: address as `0x${string}`, abi: erc20, functionName: "symbol" }).catch(() => "<?>"),
      client.readContract({ address: address as `0x${string}`, abi: erc20, functionName: "name" }).catch(() => "<?>"),
      client.readContract({ address: address as `0x${string}`, abi: erc20, functionName: "decimals" }).catch(() => 255),
    ]);

    console.log(`${address} | symbol=${symbol} | decimals=${decimals} | name=${name}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
