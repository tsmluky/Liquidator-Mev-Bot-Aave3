
import { createPublicClient, http, Address, parseAbi } from "viem";
import { arbitrum } from "viem/chains";

const RPC = "https://rpc.ankr.com/arbitrum";
// Arbitrum Aave V3 Addresses
const UI_POOL_ADDR = "0x2a2a1b42a4f74b45e9f549a954cb6d9d25dddd43";
const PROVIDER_ADDR = "0xa97684ead0e402dc232f5a977953df7ecbab3cdb";

// Using a simplified JSON ABI to avoid parseAbi errors with complex tuples
const ABI_UI = [
    {
        "inputs": [{ "internalType": "address", "name": "provider", "type": "address" }],
        "name": "getReservesData",
        "outputs": [
            {
                "components": [
                    { "internalType": "address", "name": "underlyingAsset", "type": "address" },
                    { "internalType": "string", "name": "name", "type": "string" },
                    { "internalType": "string", "name": "symbol", "type": "string" },
                    { "internalType": "uint256", "name": "decimals", "type": "uint256" },
                    { "internalType": "uint256", "name": "baseLTVasCollateral", "type": "uint256" },
                    // ... explicit truncation for test ...
                    { "internalType": "uint256", "name": "reserveLiquidationThreshold", "type": "uint256" }
                ],
                "internalType": "struct IUiPoolDataProviderV3.AggregatedReserveData[]",
                "name": "",
                "type": "tuple[]"
            },
            {
                "components": [
                    { "internalType": "uint256", "name": "marketReferenceCurrencyUnit", "type": "uint256" },
                    { "internalType": "int256", "name": "marketReferenceCurrencyPriceInUsd", "type": "int256" }
                ],
                "internalType": "struct IUiPoolDataProviderV3.BaseCurrencyInfo",
                "name": "",
                "type": "tuple"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    }
];

const ABI_PAP = parseAbi([
    "function getPool() external view returns (address)"
]);

async function main() {
    console.log("💀 Debugging Aave V3 Scan...");
    console.log("RPC:", RPC);

    const client = createPublicClient({
        chain: arbitrum,
        transport: http(RPC),
    });

    const chainId = await client.getChainId();
    console.log("Chain ID:", chainId);

    // 1. Check Code
    const codeUI = await client.getBytecode({ address: UI_POOL_ADDR as Address });
    console.log(`UiPoolDataProvider ${UI_POOL_ADDR}: ${codeUI ? "EXISTS" : "MISSING (0x)"}`);

    const codeProv = await client.getBytecode({ address: PROVIDER_ADDR as Address });
    console.log(`PoolAddressesProvider ${PROVIDER_ADDR}: ${codeProv ? "EXISTS" : "MISSING (0x)"}`);

    if (!codeUI || !codeProv) return;

    // 2. Check getPool from Provider
    try {
        const pool = await client.readContract({
            address: PROVIDER_ADDR as Address,
            abi: ABI_PAP,
            functionName: "getPool"
        });
        console.log("✅ Provider.getPool() works:", pool);
    } catch (e: any) {
        console.error("❌ Provider.getPool() failed:", e.message);
    }

    // 3. Call getReservesData (Raw Call to avoid ABI decoding errors if schema mismatches)
    // We just want to know if it REVERTS or returns data. 
    // Selector for getReservesData(address) is 0xd705b495, actually let's calculate or trust viem if we simplify ABI?
    // If we simplify ABI output to just "tuple[]", it might fail decoding. 
    // Let's do a raw call.
    // Function: getReservesData(address)

    try {
        console.log("Calling getReservesData...");
        /* 
           We can't easily decode without full ABI, but readContract will throw if revert.
           If it succeeds, decoding might fail, but that's progress.
        */
        // Let's try raw eth_call
        // 4-byte selector for getReservesData(address) might be standard.
        // But let's use the provided full ABI from aaveScanner.ts if possible, but it was crashing parsing in debug.

        // Instead, let's just use the ABI from aaveScanner.ts but pasted carefully again? 
        // Or just use the one below which is truncated, so decoding WILL fail, but we'll see if it reverts.

        const data = await client.readContract({
            address: UI_POOL_ADDR as Address,
            abi: ABI_UI,
            functionName: "getReservesData",
            args: [PROVIDER_ADDR as Address]
        });
        console.log("✅ Success! Data returned.");
    } catch (e: any) {
        if (e.message.includes("reverted")) {
            console.error("❌ REVERTED: The logic failed execution on chain.");
        } else if (e.message.includes("decode")) {
            console.log("✅ SUCCESS (Execution): Decoding failed (expected due to partial ABI), but call didn't revert!");
        } else {
            console.error("❌ Failed:", e.message);
        }
    }
}

main();
