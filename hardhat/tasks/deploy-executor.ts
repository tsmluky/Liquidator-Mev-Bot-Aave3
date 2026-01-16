import { getAddress } from "viem";

// Hardhat 3: this file is the ACTION module, imported via setAction(() => import("./tasks/deploy-executor.js"))
export default async function (_args: any, hre: any) {
  // Hardhat 3 + hardhat-viem: connect to the selected network
  const { viem } = await hre.network.connect();

  const walletClients = await viem.getWalletClients();
  if (!walletClients?.length) {
    throw new Error("No wallet clients. Revisa PRIVATE_KEY en .env y accounts en la red.");
  }

  const [deployer] = walletClients;
  const publicClient = await viem.getPublicClient();

  const AAVE_POOL   = getAddress((process.env.AAVE_POOL ?? "").trim() as `0x${string}`);
  const MORPHO      = getAddress((process.env.MORPHO ?? "").trim() as `0x${string}`);
  const SWAP_ROUTER = getAddress((process.env.SWAP_ROUTER ?? "").trim() as `0x${string}`);
  const TREASURY    = getAddress((process.env.TREASURY ?? "").trim() as `0x${string}`);

  // Guardrails: detecta env vacías
  for (const [k, v] of Object.entries({ AAVE_POOL, MORPHO, SWAP_ROUTER, TREASURY })) {
    if (!v) throw new Error(`Missing env var: ${k}`);
  }

  // Guardrails: valida que AAVE_POOL/MORPHO/SWAP_ROUTER tengan bytecode en esa red
  const mustHaveCode: Record<string, `0x${string}`> = { AAVE_POOL, MORPHO, SWAP_ROUTER };
  for (const [name, addr] of Object.entries(mustHaveCode)) {
    const code = await publicClient.getBytecode({ address: addr });
    if (!code || code === "0x") {
      throw new Error(`${name} no tiene bytecode en ${addr}. Address incorrecta o red equivocada.`);
    }
  }

  console.log("Network:", hre.network.name);
  console.log("Deployer:", deployer.account.address);
  console.log("Args:", { AAVE_POOL, MORPHO, SWAP_ROUTER, TREASURY });

  const exec = await viem.deployContract("LiquidationExecutor", [
    AAVE_POOL,
    MORPHO,
    SWAP_ROUTER,
    TREASURY,
  ]);

  console.log("LiquidationExecutor:", exec.address);

  const txHash = exec.deploymentTransaction?.hash;
  if (txHash) {
    console.log("Tx:", txHash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log("Block:", receipt.blockNumber);
  }
}
