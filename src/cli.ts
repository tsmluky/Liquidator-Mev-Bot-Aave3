import { Command } from "commander";
import { scanCmd } from "./commands/scan.js";
// import { simulateCmd } from "./commands/simulate.js";
import { planCmd } from "./commands/plan.js";
import { execCmd } from "./commands/exec.js";

// import { preflightCmd } from "./commands/preflight.js";
// import { cycleCmd } from "./commands/cycle.js";
// import { showBanner } from "./banner.js";
const program = new Command();

// Show LUKX banner on startup
// showBanner();

program
  .name("aave-liquidator") // Updated name
  .description("🎯 LUKX Reaper | Aave V3 Liquidation Engine")
  .version("v0.LUKX");

program.command("scan")
  .description("Discover candidates")
  .option("-m, --mode <mode>", "mining | sentry | mixed", "mixed")
  .action(async (opts) => scanCmd(opts));
// program.command("simulate").description("Simulate opportunities net profitability").action(async () => simulateCmd());
program.command("plan").description("Create tx plan (WATCH/EXEC)").action(async () => planCmd());
// program.command("preflight").description("Preflight checks (RPC, quoter, staleness, key if EXEC)").action(async () => preflightCmd());
// program.command("cycle").description("Run full optimization cycle (Scan->Sim->Plan->Exec)").action(async () => cycleCmd());

program
  .command("exec")
  .description("DRY-RUN execution plumbing (requires PRIVATE_KEY)")
  .action(async () => execCmd());

program.parseAsync(process.argv);



