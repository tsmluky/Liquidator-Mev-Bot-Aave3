import "dotenv/config";
import hre from "hardhat";
import { getAddress } from "viem";

async function main() {
  const viem = (hre as any).viem;
  if (!viem) {
    throw new Error(
      "hre.viem undefined. Ejecuta este script con `pnpm hardhat run`."
    );
  }

  const walletClients = await viem.getWalletClients();
  if (!walletClients?.length) {
    throw new Error("No wallet clients: revisa PRIVATE_KEY en .env y accounts en la red.");
  }

  const [deployer] = walletClients;
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();

  console.log("Network:", hre.network.name, "ChainID:", chainId);
  console.log("Deployer:", deployer.account.address);

  // Addresses Configuration
  let AAVE_POOL = "";
  let SWAP_ROUTER = ""; // Uniswap V3 Router (SwapRouter02 or similar)

  // Addresses map
  if (chainId === 42161) { // Arbitrum One
    AAVE_POOL = "0x794a61358d6845594f94dc1db02a252b5b4814ad";
    SWAP_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564"; // Standard V3 Router
  } else if (chainId === 8453) { // Base
    AAVE_POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
    SWAP_ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481"; // SwapRouter02
  } else {
    // Allow manual override via Env if other network
    AAVE_POOL = process.env.AAVE_POOL ?? "";
    SWAP_ROUTER = process.env.SWAP_ROUTER ?? "";
  }

  if (!AAVE_POOL || !SWAP_ROUTER) {
    throw new Error(`Missing addresses for ChainID ${chainId}. Set AAVE_POOL and SWAP_ROUTER in .env`);
  }

  const TREASURY = deployer.account.address; // Default to deployer

  console.log("AAVE_POOL:", AAVE_POOL);
  console.log("SWAP_ROUTER:", SWAP_ROUTER);
  console.log("TREASURY:", TREASURY);

  const LiquidationExecutor = await viem.deployContract("LiquidationExecutor", [
    AAVE_POOL,
    SWAP_ROUTER,
    TREASURY,
  ]);

  console.log("LiquidationExecutor Deployed to:", LiquidationExecutor.address);

  const txHash = LiquidationExecutor.deploymentTransaction?.hash;
  if (txHash) {
    console.log("Tx Hash:", txHash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log("Block:", receipt.blockNumber);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
