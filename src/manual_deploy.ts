import fs from "fs";
import path from "path";
import solc from "solc";
import { createWalletClient, createPublicClient, http, parseAbi, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "./config";
import "dotenv/config";
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const ARBITRUM_RPC = process.env.ARB_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// Arbitrum One Addresses (Aave V3)
const AAVE_POOL = "0x794a61358d6845594f94dc1db02a252b5b4814ad";
const SWAP_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";

async function main() {
    console.log("🚀 Starting Manual Deployment (Bypassing Hardhat)...");

    if (!PRIVATE_KEY || !ARBITRUM_RPC) {
        throw new Error("Missing PRIVATE_KEY or ARB_RPC_URL in .env");
    }

    // 1. Prepare Compiler Input
    const contractPath = path.resolve(__dirname, "../hardhat/contracts/LiquidationExecutor.sol");
    const contractSource = fs.readFileSync(contractPath, "utf8");

    const input = {
        language: "Solidity",
        sources: {
            "LiquidationExecutor.sol": {
                content: contractSource,
            },
        },
        settings: {
            optimizer: {
                enabled: true,
                runs: 200
            },
            outputSelection: {
                "*": {
                    "*": ["abi", "evm.bytecode"],
                },
            },
            viaIR: true,
        },
    };

    // 2. Define Import Callback for OpenZeppelin
    function findImports(importPath: string) {
        if (importPath.startsWith("@openzeppelin")) {
            const nodeModulesPath = path.resolve(__dirname, "../node_modules", importPath);
            if (fs.existsSync(nodeModulesPath)) {
                return { contents: fs.readFileSync(nodeModulesPath, "utf8") };
            }
            // Try hardhat node_modules if root fails
            const hhPath = path.resolve(__dirname, "../hardhat/node_modules", importPath);
            if (fs.existsSync(hhPath)) {
                return { contents: fs.readFileSync(hhPath, "utf8") };
            }
        }
        return { error: "File not found" };
    }

    // 3. Compile
    console.log("Compiling LiquidationExecutor.sol...");
    const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

    if (output.errors) {
        let hasError = false;
        output.errors.forEach((err: any) => {
            console.error(err.formattedMessage);
            if (err.severity === 'error') hasError = true;
        });
        if (hasError) throw new Error("Compilation failed");
    }

    const contract = output.contracts["LiquidationExecutor.sol"]["LiquidationExecutor"];
    const abi = contract.abi;
    const bytecode = contract.evm.bytecode.object;

    console.log("✅ Compilation Successful!");

    // 4. Deploy with Viem
    const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);

    // Arbitrum Chain Definition (Minimal)
    const arbitrum = defineChain({
        id: 42161,
        name: 'Arbitrum One',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [ARBITRUM_RPC] } }
    });

    const wallet = createWalletClient({
        account,
        chain: arbitrum,
        transport: http()
    });

    const publicClient = createPublicClient({
        chain: arbitrum,
        transport: http()
    });

    console.log(`Deploying from: ${account.address}`);
    console.log("Network: Arbitrum One");

    // Constructor: _aavePool, _swapRouter, _treasury
    const args = [AAVE_POOL, SWAP_ROUTER, account.address];

    const hash = await wallet.deployContract({
        abi,
        bytecode: `0x${bytecode}`,
        args
    });

    console.log(`✅ Contract Deployed!`);
    console.log(`Address: ${hash}`);
    // Wait, deployContract returns hash. We need receipt to get address.

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`Contract Address: ${receipt.contractAddress}`);
    console.log("👉 Add this to your .env as EXECUTOR_ADDR");
}

main().catch(console.error);
