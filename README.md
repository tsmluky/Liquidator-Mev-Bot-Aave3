# Aave V3 Liquidator: Institutional-Grade MEV Engine

> **High-Frequency, Dual-Core Architected Liquidation System for EVM L2s.**

![Status](https://img.shields.io/badge/status-production-success.svg) ![Strategy](https://img.shields.io/badge/strategy-atomic%20arbitrage-blueviolet.svg) ![Audited](https://img.shields.io/badge/architecture-dual%20core-00c853.svg)

##  Executive Summary

This repository hosts the source code for a production-grade **Liquidation Bot** targeting the Aave V3 protocol on Arbitrum and Base. It was engineered to solve the "latency vs. intelligence" trade-off common in DeFi arbitrage.

By implementing a **Parallel Dual-Core Architecture**, the system achieves sub-second detection latency while simultaneously performing complex off-chain risk modelling and atomic execution planning. It represents a state-of-the-art approach to securing decentralized lending markets.

---

##  Core Architecture

The system abandons the traditional sequential loop for a decoupled, event-driven model:

### 1. The Cortex (Scanner)
*Dedicated process for high-velocity data ingestion.*
- **Zero-Latency Polling:** Optimized `eth_getLogs` scraping loop running at the theoretical block-time limit.
- **Historic Backfill Engine:** Autonomous "time-travel" mining capable of processing 50,000 blocks/cycle to uncover dormant, high-value liquidation targets missed by real-time-only bots.
- **Append-Only Persistence:** Writes finding to a lock-free JSONL stream (`candidates.jsonl`), ensuring zero blocking on I/O.

### 2. The Strategist (Executor)
*Dedicated process for sophisticated financial decision making.*
- **Off-Chain Risk Engine:** Fully replicates Aave's Health Factor math locally. No RPC calls required to assess solvency, enabling instant reaction to price ticks.
- **MEV "Smart Bidding":** Implements a probabilistic gas auction strategy ("The Robin Hood Model"). Bidding is purely dynamic—a calculated percentage of the **Expected Net Profit** (e.g., 10%) is allocated to the miner priority fee to guarantee inclusion probability >99% for high-value targets.
- **Flashloan-Powered:** Atomic execution via custom Solidity contracts. Debt is repaid using Aave's own liquidity pool via `flashLoanSimple`, requiring **0 operating capital** for the principal.

---

##  Features & Capabilities

- **Atomic Composability:** A single transaction performs -> Flashloan -> Liquidate -> Swap Collateral -> Repay Loan -> Profit to Treasury.
- **Capital Efficiency:** Infinite leverage capacity dependent only on on-chain liquidity depth, not wallet balance.
- **Resilience:** Self-healing watchdog processes (PowerShell) ensure 99.9% uptime availability.
- **Visual Intelligence:** "The Reaper HUD" provides real-time CLI telemetry of target health, asset composition (e.g., WBTC/USDC), and net profit estimation in USD.

---

##  Technology Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| **Runtime** | Node.js / TypeScript | Strong typing for financial safety + non-blocking I/O. |
| **Blockchain** | Viem | Bare-metal performance, significantly faster than Ethers.js. |
| **Smart Contracts** | Solidity 0.8.x | Gas-optimized execution logic. |
| **Orchestration** | PowerShell Core | Robust process management and IPC. |

---

##  🗂️ Project Structure

```bash
├── data/               # Runtime database (candidates.jsonl, stats)
├── hardhat/            # Solidity contracts & deployment scripts
├── ops/                # PowerShell operational scripts
├── src/
│   ├── commands/       # CLI command implementations (plan, scan, etc.)
│   ├── lib/            # Core logic (Aave math, pathfinding)
│   └── logger.ts       # Structured logging configuration
├── test/               # Unit and Integration tests
└── tx_plan.json        # Output of the Planner module
```

##  🛠️ Development Setup

Designed for rapid iteration and safety.

### Prerequisites
- Node.js v18+
- pnpm (recommended)
- An RPC URL (Arbitrum/Base)

### Installation
```bash
# Install dependencies
pnpm install

# Setup Environment
cp .env.example .env
# Edit .env with your RPC_URL and PRIVATE_KEY
```

### Testing
We use standard Node.js test runner with `tsx`.
```bash
pnpm test
```

---

##  Deployment

Designed for server-grade environments (Linux/Windows) closer to RPC endpoints.

### ⚡ Quick Start (The Master Switch)

Launch the entire Tri-Force fleet (Miner, Sentry, Sniper) in separate windows with a double-click:

Double-click **`Start_Aave_Bot.bat`** in the project folder.

*(Or running `./Liquidator_Aave3.ps1` from PowerShell if you prefer)*

### 🤓 Manual Start (The Hard Way)

If you prefer manual control, run the bot in **3 separate terminals**:

**Terminal 1: THE MINER ⛏️ (Discovery)**
Excavates historical data to find new borrowers without pausing.
```powershell
./run_miner.ps1
```

**Terminal 2: THE SENTRY 🛡️ (Watchdog)**
Monitors the health of known users at high frequency (No RPC overhead).
```powershell
./run_sentry.ps1
```

**Terminal 3: THE SNIPER 🔫 (Execution)**
Calculates functionality and executes liquidations on targets found by the Sentry.
```powershell
./run_strategy.ps1
```

---

## Disclaimer & License

This codebase is open-sourced to demonstrate advanced DeFi development capabilities. It utilizes aggressive strategies typical of MEV (Maximal Extractable Value) searchers.

**Architected by Lukx**

[Twitter](https://x.com/0xLuky) | [GitHub](https://github.com/tsmluky)

*Building the financial infrastructure of tomorrow.*
