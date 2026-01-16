import { logger } from "../logger";
import { loadConfig } from "../config";
import { writeJson, writeJsonl } from "../utils/io";
import { AaveScanner } from "../services/aaveScanner";
import { createPublicClient, http, parseAbiItem, Address } from "viem";
import { arbitrum, base } from "viem/chains";
import { dataPath } from "../lib/data_dir";

// Comprehensive Aave V3 Events to ensure we miss nothing due to ABI mismatches
const EVENTS = [
  // Borrow V3 (Canonical: interestRateMode is uint256 in some implementations, uint8 in others)
  parseAbiItem("event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint256 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)"),
  parseAbiItem("event Borrow(address indexed reserve, address indexed user, address indexed onBehalfOf, uint256 amount, uint256 interestRateMode, uint256 borrowRate, uint16 referralCode)"),
  parseAbiItem("event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)"),

  // Supply V3 (Canonical: user is often NOT indexed, referralCode IS indexed)
  parseAbiItem("event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)"),
  parseAbiItem("event Supply(address indexed reserve, address indexed user, address indexed onBehalfOf, uint256 amount, uint16 referralCode)"),
];

export async function scanCmd() {
  const cfg = loadConfig();
  const now = new Date().toISOString();

  // Chain setup
  const chain = cfg.CHAIN_ID === 8453 ? base : arbitrum;
  const client = createPublicClient({
    chain,
    transport: http(cfg.ARB_RPC_URL)
  });

  const scanner = new AaveScanner();
  const poolAddr = await scanner.getPoolAddress();

  // 1. Get Markets
  // (Moving logs down to optimize visible flow)

  // 2. Find Users (Persistent + Smart Sync)
  const dbPath = dataPath("borrowers.json");
  const syncPath = dataPath("sync_head.json");

  let dbUsers: Address[] = [];
  try {
    const raw = await import("fs").then(m => m.readFileSync(dbPath, "utf-8"));
    dbUsers = JSON.parse(raw) as Address[];
  } catch { /* ignore */ }

  let lastScanned = 0n;
  try {
    const raw = await import("fs").then(m => m.readFileSync(syncPath, "utf-8"));
    lastScanned = BigInt(JSON.parse(raw).lastBlock);
  } catch { /* ignore */ }

  const currentBlock = await client.getBlockNumber();

  // Smart Sync Policies
  // 1. If no history vs 2. Gap too large vs 3. Normal follow-up
  // 4. AUTO-EXPANSION: If our universe is tiny (< 100), force a deep history scan to find targets.

  // Smart Sync Policies
  const MAX_WINDOW = 10000n; // User requested 10k
  const MEGA_WINDOW = 10000n; // RPC Limit (Safe for Alchemy)

  // We need to track the "deepest block scanned" to go backwards
  const deepPath = dataPath("sync_deep.json");
  let deepHead = 0n;
  try {
    const raw = await import("fs").then(m => m.readFileSync(deepPath, "utf-8"));
    deepHead = BigInt(JSON.parse(raw).deepBlock);
  } catch {
    deepHead = currentBlock; // Start from tip if no history
  }

  // Direction: Default is FORWARD (catch up to tip)
  let fromBlock = lastScanned === 0n ? currentBlock - MAX_WINDOW : lastScanned + 1n;
  let toBlock = fromBlock + MAX_WINDOW;
  if (toBlock > currentBlock) toBlock = currentBlock;

  let isBackfill = false;

  // AUTO-EXPANSION: If universe < 50k, prioritized BACKWARD scanning for faster growth
  if (dbUsers.length < 50000) {
    if (deepHead === 0n) deepHead = currentBlock;

    // Go backwards from deepHead
    toBlock = deepHead - 1n;
    fromBlock = toBlock - MEGA_WINDOW;

    // Safety base
    if (fromBlock < 10000000n) fromBlock = toBlock - 1000n; // Don't go to genesis

    isBackfill = true;
    logger.info({ currentUsers: dbUsers.length, backfillTo: toBlock.toString() }, "🚀 Low user count. Mining history (BACKFILL)...");
  } else {
    // Normal forward sync safety
    if (fromBlock < currentBlock - MAX_WINDOW * 5n) {
      fromBlock = currentBlock - MAX_WINDOW;
      toBlock = fromBlock + MAX_WINDOW;
    }
  }

  // Execution
  if (!isBackfill && fromBlock > toBlock) {
    logger.info({ currentBlock }, "Scan up to date, sleeping...");
  } else {
    // Estimate date for context
    // Arbitrum block time ~0.26s average
    const diff = Number(currentBlock - fromBlock);
    const secondsAgo = diff * 0.26;
    const date = new Date(Date.now() - secondsAgo * 1000);
    const dateStr = date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

    logger.info(
      {
        from: fromBlock.toString(),
        to: toBlock.toString(),
        range: (toBlock - fromBlock).toString(),
        totalKnown: dbUsers.length,
        mode: isBackfill ? `BACKFILL (${dateStr})` : `LIVE`
      },
      "🔍 Syncing events (Raw Scrape)..."
    );

    // NUCLEAR OPTION: Fetch ALL logs from Pool.
    // We don't care about the event signature. If an address appears in the topics,
    // they are interacting with the Pool (Borrow, Supply, Repay, Withdraw, Liquidation).
    // We want to check them all.
    const logs = await client.getLogs({
      address: poolAddr,
      fromBlock,
      toBlock
    });

    const uniqueUsers = new Set<Address>(dbUsers);

    for (const l of logs) {
      // Topic 0: Event Hash
      // Topic 1: Usually Reserve (Asset)
      // Topic 2: User / onBehalfOf
      // Topic 3: onBehalfOf / Referral

      // careful: topics can be null or empty
      if (!l.topics) continue;

      // Helper to add if valid address
      const addIfAddr = (hex: string | undefined) => {
        if (!hex) return;
        // topic is 32 bytes (66 chars). Address is last 20 bytes (40 chars)
        // 0x0000...000[address]
        if (hex.length === 66) {
          const addr = `0x${hex.substring(26)}` as Address;
          // Filter out the pool itself or obviously zero addrs if any
          if (addr !== "0x0000000000000000000000000000000000000000") {
            uniqueUsers.add(addr);
          }
        }
      }

      // We skip Topic 0 (Hash) and Topic 1 (Reserve usually). 
      // We aggressively scrape Topic 2 and 3.
      // Even if Topic 1 is the user (rare in Aave), skimming 2 and 3 covers 99% of "User" fields.
      addIfAddr(l.topics[1]); // Sometimes User is indexed at 1? In "LiquidationCall(collateral, debt, user...)" user is 3. 
      // In "Supply(reserve, user, onBehalfOf)", reserve is 1. user is 2 (if indexed).
      addIfAddr(l.topics[2]);
      addIfAddr(l.topics[3]);
    }

    const updatedUsers = Array.from(uniqueUsers);
    const newFound = updatedUsers.length - dbUsers.length;

    if (newFound > 0 || updatedUsers.length > dbUsers.length) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      logger.info({ newFound, total: updatedUsers.length }, "✨ Universe Expanded (Scraper)");
      dbUsers = updatedUsers;
    }

    // Update Pointers
    if (isBackfill) {
      await writeJson(deepPath, { deepBlock: fromBlock.toString(), ts: now });
      // Don't update sync_head (forward tip) when backfilling
    } else {
      await writeJson(syncPath, { lastBlock: toBlock.toString(), ts: now });
    }
  }

  // 3. Health Check (The Real Work)
  // Only check if we have users
  if (dbUsers.length === 0) {
    logger.info("Universe empty. Waiting for events...");
    return;
  }

  // 1. Get Markets (Lazy load)
  const { reserves } = await scanner.getReserves();
  const markets = reserves.map(r => ({
    symbol: r.symbol,
    address: r.underlyingAsset,
    decimals: Number(r.decimals),
    ltv: Number(r.baseLTVasCollateral) / 10000,
    liquidationThreshold: Number(r.reserveLiquidationThreshold) / 10000,
    isActive: Number(r.isActive) === 1, // Corrected for uint logic
    isFrozen: Number(r.isFrozen) === 1    // Corrected for uint logic
  }));

  // Log summary
  logger.info({ users: dbUsers.length }, "🏥 Checking Health...");
  const candidates: any[] = [];

  // 3. Check Health (Batched)
  let scanned = 0;
  const CHUNK_SIZE = 50;

  // Stats for HUD
  let statSafe = 0;
  let statWatch = 0;
  let statRisk = 0;
  let statLiquidatable = 0;

  for (let i = 0; i < dbUsers.length; i += CHUNK_SIZE) {
    const chunk = dbUsers.slice(i, i + CHUNK_SIZE);
    scanned += chunk.length;

    // Efficient multicall
    const results = await scanner.getUsersHealthBatch(chunk);

    for (const health of results) {
      if (!health) continue;

      const hf = health.healthFactor;

      // Stats classification
      if (hf >= 2.0) statSafe++;
      else if (hf >= 1.5) statSafe++; // Granularity if needed
      else if (hf >= 1.1) statWatch++;
      else if (hf >= 1.0) statRisk++;
      else statLiquidatable++;

      const proximity = hf === 0 ? 100 : 1 / hf;

      let candidateStatus = "below_watch";
      if (hf < 1.0) candidateStatus = "exec_ready";
      else if (hf < 1.1) candidateStatus = "watch";

      if (candidateStatus === "below_watch") continue;
      if (health.totalDebtUSD < 10) continue;

      candidates.push({
        candidateId: `${chain.id}|${health.user}|aave`,
        borrower: health.user,
        healthFactor: hf,
        proximity,
        totalCollateralUSD: health.totalCollateralUSD,
        totalDebtUSD: health.totalDebtUSD,
        bestDebt: health.bestDebt,
        bestCollateral: health.bestCollateral,
        bestDebtAmount: health.bestDebtAmount?.toString(),
        status: candidateStatus,
        ts: now
      });
    }
  }

  // Write results
  await writeJson(dataPath("markets.json"), { generatedAt: now, markets });
  await writeJsonl(dataPath("candidates.jsonl"), candidates);

  // --- REAPER HUD ---
  // Clearer visual summary for the user

  // Get top 3 closest to liquidation
  const top3 = candidates
    .filter(c => c.status === "watch" || c.status === "exec_ready")
    .sort((a, b) => a.healthFactor - b.healthFactor)
    .slice(0, 3);

  console.log("");
  console.log("┌────────────────────────────────────────────────────────┐");
  console.log("│ 💀 REAPER HUD                                           │");
  console.log("├────────────────────────────────────────────────────────┤");
  console.log(`│ 📡 Range    : +${Number(toBlock - fromBlock)} blocks (${fromBlock} -> ${toBlock})`);
  console.log(`│ 👥 Universe : ${dbUsers.length} users (${dbUsers.length - candidates.length} safe)`);
  console.log("│ 🏥 Health   :");
  console.log(`│    🟢 Safe  : ${statSafe}`);
  console.log(`│    🟡 Watch : ${statWatch}`);
  console.log(`│    🟠 Risk  : ${statRisk} (HF < 1.1)`);
  console.log(`│    💀 DOOM  : ${statLiquidatable} (HF < 1.0)`);
  console.log("├────────────────────────────────────────────────────────┤");
  console.log(`│ 🎯 TARGETS  : ${statRisk} FOUND! ${statLiquidatable > 0 ? 'Sending to execution...' : 'Monitoring...'}    │`);

  if (top3.length > 0) {
    console.log("├────────────────────────────────────────────────────────┤");
    console.log("│ 🔍 TOP 3 CLOSEST TO LIQUIDATION:                        │");

    // Helper map for known Arbitrum addresses to Symbols
    const TOKEN_MAP: Record<string, string> = {
      "0xaf88d065e77c8cC2239327C5EDb3A432268e5831": "USDC",
      "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9": "USDT",
      "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1": "WETH",
      "0x912CE59144191C1204E64559FE8253a0e49E6548": "ARB",
      "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f": "WBTC",
      "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1": "DAI"
    };

    // Lazy load getUserAssets if needed
    const { getUserAssets } = await import("../lib/getUserAssets");
    const poolAddr = cfg.AAVE_POOL_ADDRESS_PROVIDER;

    for (let i = 0; i < top3.length; i++) {
      const c = top3[i];
      const addr = c.borrower as string;
      const shortAddr = `${addr.slice(0, 10)}...${addr.slice(-8)}`;
      const collateral = `$${Math.round(c.totalCollateralUSD)}`.padStart(8);
      const debt = `$${Math.round(c.totalDebtUSD)}`.padStart(8);
      const estProfit = Math.round(c.totalDebtUSD * 0.5 * 0.05);

      console.log(`│ ${i + 1}. ${shortAddr}  HF: ${c.healthFactor.toFixed(4)} │`);
      console.log(`│    Col: ${collateral} | Debt: ${debt} | Est. Profit: ~$${estProfit} │`);
    }
  }

  console.log("└────────────────────────────────────────────────────────┘");
  console.log("");

  logger.info({ candidates: candidates.length, items: candidates.length, liqReady: statLiquidatable }, "Candidates written");
}
