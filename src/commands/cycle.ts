import { logger } from "../logger.js";
import { scanCmd } from "./scan.js";
import { simulateCmd } from "./simulate.js";
import { planCmd } from "./plan.js";
import { execCmd } from "./exec.js";
import { preflightCmd } from "./preflight.js";

export async function cycleCmd() {
    const start = Date.now();
    logger.info("🔄 [CYCLE] Starting optimized execution sequence...");

    try {
        // 1. SCAN
        console.log(">> STEP: SCAN");
        await scanCmd();

        // 2. SIMULATE
        console.log(">> STEP: SIMULATE");
        await simulateCmd();

        // 3. PLAN
        console.log(">> STEP: PLAN");
        await planCmd();

        // 4. PREFLIGHT
        console.log(">> STEP: PREFLIGHT");
        await preflightCmd();

        // 5. EXEC
        console.log(">> STEP: EXEC");
        // We capture the return value or logs if possible, but execCmd usually logs to stdout
        // For the visual dashboard, we need it to print "exec: submitted" if successful
        await execCmd();

        const duration = ((Date.now() - start) / 1000).toFixed(2);
        logger.info(`✅ [CYCLE] Sequence completed in ${duration}s`);

        // Force exit to ensure no lingering handles (sockets/timeouts) keep the process alive
        process.exit(0);

    } catch (error) {
        logger.error(error, "❌ [CYCLE] Sequence failed");
        process.exit(1);
    }
}
