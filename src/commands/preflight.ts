import fs from "node:fs/promises";
import { logger } from "../logger.js";
import { loadConfig } from "../config.js";
import { getCode } from "../services/uniswapQuoterV2.js";
import { dataPath } from "../lib/data_dir";

const DEFAULT_QUOTER_V2_ARBITRUM = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e" as const;

function ageSec(iso: string): number | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (Date.now() - t) / 1000);
}

function parseHexInt(x: string): number | null {
  if (typeof x !== "string" || !x.startsWith("0x")) return null;
  try {
    return Number.parseInt(x, 16);
  } catch {
    return null;
  }
}

function truthyEnv(name: string, def = "0"): boolean {
  return ["1", "true", "yes", "y", "on"].includes(String(process.env[name] ?? def).toLowerCase());
}

export async function preflightCmd() {
  const cfg = loadConfig();

  // 1) RPC connectivity + chainId match
  const rpcRes = await fetch(cfg.ARB_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
  });
  const rpcText = await rpcRes.text();
  if (!rpcRes.ok) throw new Error(`preflight: RPC eth_chainId failed: HTTP ${rpcRes.status} :: ${rpcText.slice(0, 200)}`);

  let chainIdHex = "";
  try {
    chainIdHex = JSON.parse(rpcText)?.result ?? "";
  } catch {
    throw new Error(`preflight: RPC eth_chainId non-JSON: ${rpcText.slice(0, 200)}`);
  }

  const rpcChainId = parseHexInt(chainIdHex);
  const chainOk = rpcChainId !== null && rpcChainId === cfg.CHAIN_ID;

  // 2) Read plan
  const planRaw = await fs.readFile(dataPath("tx_plan.json"), "utf8");
  const plan = JSON.parse(planRaw) as any;
  const planAge = ageSec(plan?.generatedAt ?? "");

  const execItems = Array.isArray(plan?.items) ? plan.items.filter((x: any) => x.action === "EXEC") : [];
  const execCount = execItems.length;

  // 3) Read sim (optional but recommended)
  let simAge: number | null = null;
  let simHasQuotedPass: number | null = null;
  let simPassesQuoted: number | null = null;
  let simPassesExec: number | null = null;

  try {
    const simRaw = await fs.readFile(dataPath("tx_sim.json"), "utf8");
    const sim = JSON.parse(simRaw) as any;
    simAge = ageSec(sim?.generatedAt ?? "");

    simPassesQuoted = Number(sim?.diagnostics?.passesQuoted ?? null);
    simPassesExec = Number(sim?.diagnostics?.passesExec ?? null);

    if (!Number.isFinite(simPassesQuoted)) simPassesQuoted = null;
    if (!Number.isFinite(simPassesExec)) simPassesExec = null;

    // IMPORTANT: this is NOT "exec-ready by threshold"
    // It's "we have at least one quoted+profit-pass candidate in simulate outputs"
    simHasQuotedPass = (simPassesExec !== null ? (simPassesExec > 0 ? 1 : 0) : null);
  } catch {
    simAge = null;
    simHasQuotedPass = null;
    simPassesQuoted = null;
    simPassesExec = null;
  }

  // 4) Quoter presence (only if quoting enabled)
  const quoteEnabled = Boolean(cfg.QUOTE_ENABLED);
  const quoterAddr = DEFAULT_QUOTER_V2_ARBITRUM as `0x${string}`;

  let quoterOk = true;
  if (quoteEnabled) {
    const quoterCode = await getCode(cfg.ARB_RPC_URL, quoterAddr);
    quoterOk = quoterCode !== "0x";
  }

  // 5) Key presence if any EXEC
  const keyOk = Boolean(cfg.PRIVATE_KEY);

  const execEnabled = truthyEnv("EXEC_ENABLED", "0");

  const planFresh = planAge !== null && planAge <= 180;
  const simFresh = simAge !== null && simAge <= 180;

  // Monitor is healthy when chain+quoter OK and artifacts are fresh enough.
  // If there are EXEC items, require simFresh too (avoid acting on stale simulate).
  const staleOk = execCount === 0 ? planFresh : (planFresh && simFresh);
  const monitorOk = chainOk && quoterOk && staleOk;

  // Ready-to-exec semantics:
  // - MUST have exec candidates in plan (this already encodes proximity threshold + quote requirement from plan logic)
  // - MUST have key + EXEC_ENABLED
  // - MUST have fresh artifacts (plan + sim)
  const readyToExec = execCount > 0 && keyOk && execEnabled && planFresh && simFresh;

  // Final OK:
  // - If EXEC_ENABLED is off, we still allow "ok" for monitoring.
  // - If EXEC_ENABLED is on and there are exec candidates, require readyToExec.
  const ok = monitorOk && (!execEnabled ? true : (execCount === 0 || readyToExec));

  logger.info(
    {
      chainIdHex,
      rpcChainId,
      cfgChainId: cfg.CHAIN_ID,
      chainOk,

      planGeneratedAt: plan?.generatedAt ?? null,
      planAgeSec: planAge,
      execCount,

      simAgeSec: simAge,
      simHasQuotedPass,
      simPassesQuoted,
      simPassesExec,

      quoteEnabled,
      quoterAddr,
      quoterOk,

      privateKeyLoaded: keyOk,
      execEnabled,

      monitorOk,
      readyToExec,
      ok,
    },
    "preflight: status"
  );

  if (!ok) {
    throw new Error("preflight: failed (see fields above)");
  }
}
