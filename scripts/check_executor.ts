import { createPublicClient, http } from "viem";
import { arbitrum } from "viem/chains";

const EXECUTOR = (process.env.EXECUTOR_ADDR ?? "").trim();
if (!EXECUTOR) throw new Error("Missing EXECUTOR_ADDR");

const CALLER = (process.env.CALLER_ADDR ?? "").trim();
if (!CALLER) throw new Error("Missing CALLER_ADDR");

const RPC = (process.env.ARB_RPC_URL ?? "").trim();
if (!RPC) throw new Error("Missing ARB_RPC_URL");

const ABI = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "treasury", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "operatorModeEnabled", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "isOperator", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "signer", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "aavePool", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "morpho", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "swapRouter", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }
] as const;

async function main() {
  const client = createPublicClient({ chain: arbitrum, transport: http(RPC) });

  const [owner, paused, treasury, opMode, isOp, signer, aavePool, morpho, swapRouter] = await Promise.all([
    client.readContract({ address: EXECUTOR as any, abi: ABI, functionName: "owner" }),
    client.readContract({ address: EXECUTOR as any, abi: ABI, functionName: "paused" }),
    client.readContract({ address: EXECUTOR as any, abi: ABI, functionName: "treasury" }),
    client.readContract({ address: EXECUTOR as any, abi: ABI, functionName: "operatorModeEnabled" }),
    client.readContract({ address: EXECUTOR as any, abi: ABI, functionName: "isOperator", args: [CALLER as any] }),
    client.readContract({ address: EXECUTOR as any, abi: ABI, functionName: "signer" }),
    client.readContract({ address: EXECUTOR as any, abi: ABI, functionName: "aavePool" }),
    client.readContract({ address: EXECUTOR as any, abi: ABI, functionName: "morpho" }),
    client.readContract({ address: EXECUTOR as any, abi: ABI, functionName: "swapRouter" })
  ]);

  console.log(JSON.stringify({
    executor: EXECUTOR,
    caller: CALLER,
    owner,
    paused,
    treasury,
    operatorModeEnabled: opMode,
    callerIsOperator: isOp,
    signer,
    aavePool,
    morpho,
    swapRouter
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
