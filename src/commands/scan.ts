import { logger } from "../logger";
import { loadConfig } from "../config";
import { writeJson, writeJsonl } from "../utils/io";
import { AaveScanner } from "../services/aaveScanner";
import { createPublicClient, http, parseAbiItem, Address } from "viem";
import { arbitrum, base } from "viem/chains";
import { dataPath } from "../lib/data_dir";
import { loadBlacklist, isBlacklisted } from "../lib/blacklist";

// Comprehensive Aave V3 Events
const EVENTS = [
  parseAbiItem("event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint256 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)"),
  parseAbiItem("event Borrow(address indexed reserve, address indexed user, address indexed onBehalfOf, uint256 amount, uint256 interestRateMode, uint256 borrowRate, uint16 referralCode)"),
  parseAbiItem("event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)"),
  parseAbiItem("event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)"),
  parseAbiItem("event Supply(address indexed reserve, address indexed user, address indexed onBehalfOf, uint256 amount, uint16 referralCode)"),
];

export async function scanCmd(options: { mode?: string } = {}) {
  const cfg = loadConfig();
  const now = new Date().toISOString();
  const mode = options.mode || "mixed"; // mixed, sentry, mining

  // Chain setup
  const chain = cfg.CHAIN_ID === 8453 ? base : arbitrum;
  const client = createPublicClient({
    chain,
    transport: http(cfg.ARB_RPC_URL)
  });

  const scanner = new AaveScanner();
  const poolAddr = await scanner.getPoolAddress();

  // 1. Find Users (Persistent + Smart Sync)
  const dbPath = dataPath("borrowers.json");
  const syncPath = dataPath("sync_head.json");

  let dbUsers: Address[] = [];
  try {
    const raw = await import("fs").then(m => m.readFileSync(dbPath, "utf-8"));
    dbUsers = JSON.parse(raw) as Address[];
  } catch { /* ignore */ }

  // =================================================================
  // ⛏️ MINER LOGIC (Discovery) - Only runs once at start if not 'sentry'
  // =================================================================
  if (mode !== "sentry") {
    let lastScanned = 0n;
    try {
      const raw = await import("fs").then(m => m.readFileSync(syncPath, "utf-8"));
      lastScanned = BigInt(JSON.parse(raw).lastBlock);
    } catch { /* ignore */ }

    const currentBlock = await client.getBlockNumber();
    const MAX_WINDOW = 10000n;
    const deepPath = dataPath("sync_deep.json");
    let deepHead = 0n;
    try {
      const raw = await import("fs").then(m => m.readFileSync(deepPath, "utf-8"));
      deepHead = BigInt(JSON.parse(raw).deepBlock);
    } catch { deepHead = currentBlock; }

    let fromBlock = lastScanned === 0n ? currentBlock - MAX_WINDOW : lastScanned + 1n;
    let toBlock = fromBlock + MAX_WINDOW;
    if (toBlock > currentBlock) toBlock = currentBlock;

    let isBackfill = false;
    // Auto-expansion logic
    if (dbUsers.length < 50000) {
      if (deepHead === 0n) deepHead = currentBlock;
      toBlock = deepHead - 1n;
      fromBlock = toBlock - MAX_WINDOW;
      if (fromBlock < 10000000n) fromBlock = toBlock - 1000n;
      isBackfill = true;
      logger.info({ currentUsers: dbUsers.length, backfillTo: toBlock.toString() }, "🚀 Low user count. Mining history (BACKFILL)...");
    } else {
      if (fromBlock < currentBlock - MAX_WINDOW * 5n) { // Catch up fast
        fromBlock = currentBlock - MAX_WINDOW;
        toBlock = fromBlock + MAX_WINDOW;
      }
    }

    if (!isBackfill && fromBlock > toBlock) {
      logger.info({ currentBlock }, "Scan up to date, sleeping...");
    } else {
      // Mining...
      logger.info({ from: fromBlock.toString(), to: toBlock.toString(), totalKnown: dbUsers.length }, "🔍 Syncing events...");
      try {
        const logs = await client.getLogs({ address: poolAddr, fromBlock, toBlock });
        if (logs.length > 0) {
          const uniqueUsers = new Set<Address>(dbUsers);
          const addIfAddr = (hex: string | undefined) => {
            if (!hex) return;
            if (hex.length === 66 && hex !== "0x0000000000000000000000000000000000000000") {
              uniqueUsers.add(`0x${hex.substring(26)}` as Address);
            }
          }
          for (const l of logs) {
            if (!l.topics) continue;
            addIfAddr(l.topics[1]); addIfAddr(l.topics[2]); addIfAddr(l.topics[3]);
          }
          const updatedUsers = Array.from(uniqueUsers);
          if (updatedUsers.length > dbUsers.length) {
            dbUsers = updatedUsers;
            await writeJson(dbPath, dbUsers); // Save immediately
            logger.info({ newFound: updatedUsers.length - dbUsers.length }, "✨ Universe Expanded");
          }
        }
        const ptrPath = isBackfill ? deepPath : syncPath;
        const ptrData = isBackfill ? { deepBlock: fromBlock.toString() } : { lastBlock: toBlock.toString() };
        await writeJson(ptrPath, { ...ptrData, ts: new Date().toISOString() });
      } catch (e: any) { logger.error(e.message); }
    }
  }

  if (mode === "mining") return; // Exit if just mining

  // =================================================================
  // 😈 SENTRY DAEMON (Persistent Service)
  // =================================================================
  logger.info("😈 Sentry Daemon STARTING...");

  // State
  let cursor = 0;
  let cycleCount = 0;
  const CHUNK_SIZE = 50;
  const prioritySet = new Set<string>(); // HF < 1.5
  const stateHF = new Map<string, number>(); // Track last known HF for stats

  // Load initial candidates to priority and warm up
  // (Optional: Load logic skipped for simplicity, will fill up naturally)

  while (true) {
    // Hot reload blacklist every cycle (cheap file read)
    const blacklist = loadBlacklist();

    const candidates: any[] = [];

    // Stats counters for HUD
    let statSafe = 0;
    let statWatch = 0;
    let statRisk = 0;
    let statLiquidatable = 0;
    let statDust = 0;

    // 1. PRIORITY LANE (High Risk Users)
    const priorityUsers = Array.from(prioritySet) as Address[];
    // Filter out blacklisted from priority to save calls
    const displayPriority = priorityUsers.filter(u => !isBlacklisted(blacklist, u));

    // 2. BACKGROUND LANE (Slow Rotation)
    // Take specific chunk from universe
    if (dbUsers.length > 0) {
      if (cursor >= dbUsers.length) cursor = 0;
      const bgChunk = dbUsers.slice(cursor, cursor + CHUNK_SIZE);
      cursor += CHUNK_SIZE;

      // Merge unique users to check this cycle
      const usersCheck = Array.from(new Set([...displayPriority, ...bgChunk]));

      // Perform Multicall
      const results = await scanner.getUsersHealthBatch(usersCheck);

      for (const health of results) {
        if (!health) continue;
        const hf = health.healthFactor;
        const user = health.user;

        // Priority Management
        if (hf < 1.5 && hf > 0) {
          prioritySet.add(user); // Keep/Add to priority
          stateHF.set(user, hf); // Update stat
          statRisk++;
        } else {
          prioritySet.delete(user); // Remove if safe
          stateHF.delete(user);
          statSafe++;
        }

        // Candidates Logic for Planner
        let candidateStatus = "below_watch";
        if (hf < 1.0) candidateStatus = "exec_ready";
        else if (hf < 1.1) candidateStatus = "watch";

        if (candidateStatus === "below_watch") continue; // Not interesting for Planner

        // Ghost Filter
        if (health.totalCollateralUSD < 1 && health.totalDebtUSD < 1) {
          statDust++;
          prioritySet.delete(user); // cleanup
          continue;
        }

        // Blacklist Check
        if (isBlacklisted(blacklist, user)) {
          prioritySet.delete(user); // cleanup
          continue;
        }

        // Add to candidates list
        if (hf < 1.0) statLiquidatable++;
        else statWatch++;

        candidates.push({
          candidateId: `${chain.id}|${user}|aave`,
          borrower: user,
          healthFactor: hf,
          proximity: hf === 0 ? 100 : 1 / hf,
          totalCollateralUSD: health.totalCollateralUSD,
          totalDebtUSD: health.totalDebtUSD,
          bestDebt: health.bestDebt,
          bestCollateral: health.bestCollateral,
          status: candidateStatus,
          ts: new Date().toISOString()
        });
      }
    }

    // Write Candidates (Flush to disk for Planner)
    await writeJsonl(dataPath("candidates.jsonl"), candidates);

    // HOT RELOAD: Refresh Universe every 250 cycles (approx 2-4 mins)
    if (cycleCount % 250 === 0) {
      try {
        const raw = await import("fs").then(m => m.readFileSync(dbPath, "utf-8"));
        const freshUsers = JSON.parse(raw) as Address[];
        if (freshUsers.length > dbUsers.length) {
          dbUsers = freshUsers;
        }
      } catch { }
    }

    // HUD DISPLAY
    const topCandidates = candidates
      .filter(c => {
        const isInteresting = c.status === "watch" || c.status === "exec_ready";
        const estProfit = c.totalDebtUSD * 0.5 * 0.05;
        return isInteresting && estProfit >= 10; // Only show >$10 profit
      })
      .sort((a, b) => a.healthFactor - b.healthFactor)
      .slice(0, 15); // Expanded to Top 15

    const W = 75;
    const pad = (s: string) => s.padEnd(W - 4);

    // Calc live stats from map
    const hfValues = Array.from(stateHF.values());
    const countRisk = hfValues.length; // < 1.5
    const countWarn = hfValues.filter(h => h < 1.1).length; // < 1.1
    const countDoom = hfValues.filter(h => h < 1.0).length; // < 1.0

    // Refresh Rate Logic
    // If no priority targets, we can sleep longer to save RPC
    const sleepTime = displayPriority.length > 0 ? 500 : 1000;

    console.clear();
    console.log(`│ ${pad(`💀 DAEMON SENTRY | Cycle: ${cycleCount} | Universe: ${dbUsers.length} Users`)} │`);
    console.log(`│ ${pad(`   🔥 Priority Queue : ${countRisk} users (HF < 1.5)`)} │`);
    console.log(`│ ${pad(`   🟠 Warning Queue  : ${countWarn} users (HF < 1.1)`)} │`);
    console.log(`│ ${pad(`   💀 Kill Zone      : ${countDoom} users (HF < 1.0)`)} │`);
    console.log(`│ ${pad(`   ⚡ Speed          : ${sleepTime}ms refresh (${displayPriority.length > 0 ? 'TURBO' : 'ECO'})`)} │`);

    if (topCandidates.length > 0) {
      console.log("├───────────────────────────────────────────────────────────────────────┤");
      console.log(`│ ${pad("🔍 TOP 15 CLOSEST TO LIQUIDATION:")} │`);
      topCandidates.forEach((c, i) => {
        const hfStr = c.healthFactor.toFixed(4);
        const estProfit = Math.round(c.totalDebtUSD * 0.5 * 0.05);
        const col = `$${Math.round(c.totalCollateralUSD)}`.padEnd(12);
        const deb = `$${Math.round(c.totalDebtUSD)}`.padEnd(12);
        const prof = `~$${estProfit}`.padEnd(10);
        console.log(`│ ${i + 1}. ${c.borrower.slice(0, 10)}... HF: ${hfStr}`.padEnd(W - 4) + " │");
        console.log(`│    Col: ${col} | Debt: ${deb} | Prof: ${prof}`.padEnd(W - 4) + " │");
      });
    }
    console.log("└───────────────────────────────────────────────────────────────────────┘");

    // Sleep to avoid RPC spam
    await new Promise(r => setTimeout(r, sleepTime));
    cycleCount++;
  }
}
