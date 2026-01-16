import { createPublicClient, http, parseAbiItem } from "viem";
import { arbitrum } from "viem/chains";
import { loadConfig } from "./config";

const cfg = loadConfig();
const client = createPublicClient({
    chain: arbitrum,
    transport: http(cfg.ARB_RPC_URL)
});

async function main() {
    const pool = "0x794a61358d6845594f94dc1db02a252b5b4814ad";
    const block = await client.getBlockNumber();
    console.log(`Checking raw logs for pool ${pool} from ${block - 2000n} to ${block}`);

    // Fetch EVERYTHING (no event filter)
    const logs = await client.getLogs({
        address: pool,
        fromBlock: block - 2000n,
        toBlock: block
    });

    console.log(`Found ${logs.length} total logs`);

    // Analyze unique topics
    const signatures: Record<string, number> = {};

    logs.forEach(l => {
        const t0 = l.topics[0] || "unknown";
        signatures[t0] = (signatures[t0] || 0) + 1;
    });

    console.log("--- TOPIC HASHES SEEN ---");
    for (const [hash, count] of Object.entries(signatures)) {
        console.log(`${hash}: ${count} occurrences`);
    }

    // Known Aave V3 Hashes
    const KNOWN = {
        "Borrow": "0x7eb06877a33a0026e0be57ca16a2468307d1a580662d5b62b10167c6999b19e2",
        "Supply": "0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b92c5881a10e1934027",
        "Repay": "0xa534c8dbe71f871f9f3530e97a74601fea17b420cae54e8d3842fa31e1346f31"
    };

    console.log("\n--- COMPARISON ---");
    for (const [name, h] of Object.entries(KNOWN)) {
        console.log(`${name}: ${h} ${signatures[h] ? '✅ MATCH ' + signatures[h] : '❌ NOT FOUND'}`);
    }
}

main().catch(console.error);
