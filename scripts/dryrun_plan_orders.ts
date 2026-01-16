import fs from "node:fs";
import path from "node:path";
import { createPublicClient, http } from "viem";
import { arbitrum } from "viem/chains";

/* HEALTHY_COOLDOWN_HELPERS_START */
const healthyCooldownSec = Number(process.env.HEALTHY_COOLDOWN_SEC ?? "900");
const healthyCooldownPath =
  process.env.HEALTHY_COOLDOWN_PATH ??
  path.join(process.cwd(), "data", "healthy_cooldown.json");

function loadCooldown(): Record<string, number> {
  try {
    if (!Number.isFinite(healthyCooldownSec) || healthyCooldownSec <= 0) return {};
    if (!fs.existsSync(healthyCooldownPath)) return {};
    const raw = fs.readFileSync(healthyCooldownPath, "utf8");
    const obj = JSON.parse(raw || "{}");
    if (!obj || typeof obj !== "object") return {};
    return obj as Record<string, number>;
  } catch {
    return {};
  }
}

function saveCooldown(m: Record<string, number>) {
  try {
    fs.mkdirSync(path.dirname(healthyCooldownPath), { recursive: true });
    fs.writeFileSync(healthyCooldownPath, JSON.stringify(m, null, 2));
  } catch {}
}

function pruneCooldown(m: Record<string, number>) {
  if (!Number.isFinite(healthyCooldownSec) || healthyCooldownSec <= 0) return m;
  const now = Date.now();
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(m)) {
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    if (now - n <= healthyCooldownSec * 1000) out[k] = n;
  }
  return out;
}

function markHealthy(candidateId: string) {
  try {
    if (!candidateId) return;
    if (!Number.isFinite(healthyCooldownSec) || healthyCooldownSec <= 0) return;
    const m = pruneCooldown(loadCooldown());
    const prev = Number(m[candidateId] ?? 0);
    const now = Date.now();

    // Si ya está en cooldown, NO refrescar el timestamp
    if (Number.isFinite(prev) && prev > 0 && (now - prev) <= healthyCooldownSec * 1000) return;

    m[candidateId] = now;
    saveCooldown(m);
  } catch {}
}
/* HEALTHY_COOLDOWN_HELPERS_END */

const RPC = (process.env.ARB_RPC_URL ?? "").trim();
const EXECUTOR = (process.env.EXECUTOR_ADDR ?? "").trim();
const CALLER = (process.env.CALLER_ADDR ?? "").trim();

if (!RPC) throw new Error("Missing ARB_RPC_URL");
if (!EXECUTOR) throw new Error("Missing EXECUTOR_ADDR");
if (!CALLER) throw new Error("Missing CALLER_ADDR");

const planFile = path.join(process.cwd(), "data", "tx_plan.json");
if (!fs.existsSync(planFile)) throw new Error(`Missing ${planFile}`);

// Alineado con exec.ts: execute() no retorna nada
const EXECUTE_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "order",
        type: "tuple",
        components: [
          {
            name: "market",
            type: "tuple",
            components: [
              { name: "loanToken", type: "address" },
              { name: "collateralToken", type: "address" },
              { name: "oracle", type: "address" },
              { name: "irm", type: "address" },
              { name: "lltv", type: "uint256" },
            ],
          },
          { name: "borrower", type: "address" },
          { name: "repayAssets", type: "uint256" },
          { name: "repaidShares", type: "uint256" },
          { name: "seizedAssets", type: "uint256" },
          { name: "uniPath", type: "bytes" },
          { name: "amountOutMin", type: "uint256" },
          { name: "minProfit", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "maxTxGasPrice", type: "uint256" },
          { name: "referralCode", type: "uint16" },
          { name: "nonce", type: "uint256" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

function truthy(name: string, def = "1"): boolean {
  return ["1", "true", "yes", "y", "on"].includes(String(process.env[name] ?? def).toLowerCase());
}

function beepOnce() {
  process.stdout.write("\x07"); // BEL
}

function classifyErr(e: any): { kind: "SKIP_HEALTHY" | "FAIL"; msg: string } {
  const msg = String(e?.shortMessage ?? e?.message ?? e ?? "");
  const m = msg.toLowerCase();
  if (m.includes("position is healthy")) return { kind: "SKIP_HEALTHY", msg };
  return { kind: "FAIL", msg };
}

async function main() {
  const plan = JSON.parse(fs.readFileSync(planFile, "utf-8"));

  // Filtra EXEC reales con order + pass (si existe)
  let items = (plan.items ?? []).filter((x: any) => x?.action === "EXEC" && x?.order);
  items = items.filter((x: any) => (typeof x.pass === "boolean" ? x.pass : true));

  // Ordena por netProfitUsd desc si está presente
  items.sort((a: any, b: any) => Number(b?.netProfitUsd ?? 0) - Number(a?.netProfitUsd ?? 0));

  const max = Math.max(1, Math.trunc(Number(process.env.DRYRUN_MAX ?? "25")));
  const stopOnOk = truthy("DRYRUN_STOP_ON_OK", "1");
  const subset = items.slice(0, max);

  const client = createPublicClient({ chain: arbitrum, transport: http(RPC) });

  let ok = 0;
  let fail = 0;
  let skipHealthy = 0;

  for (let i = 0; i < subset.length; i++) {
    const it = subset[i];

    // refresh deadline/nonce to avoid expiry
    const deadlineSec = Math.trunc(Number(process.env.ORDER_DEADLINE_SEC ?? "180"));
    const refreshedDeadline = BigInt(Math.floor(Date.now() / 1000) + Math.max(60, deadlineSec));
    const order = { ...it.order, deadline: refreshedDeadline, nonce: BigInt(Date.now() + i) };

    const id = String(it.candidateId ?? it.marketId ?? "unknown");

    try {
      await client.simulateContract({
        address: EXECUTOR as any,
        abi: EXECUTE_ABI,
        functionName: "execute",
        args: [order],
        account: CALLER as any,
      });

      ok++;
      beepOnce();

      console.log(
        `[OK] ${id} netUsd=${Number(it.netProfitUsd ?? 0).toFixed(4)} repayAssets=${order.repayAssets.toString()} repaidShares=${order.repaidShares.toString()} seizedAssets=${order.seizedAssets.toString()}`
      );

      if (stopOnOk) break;
    } catch (e: any) {
      const c = classifyErr(e);
      if (c.kind === "SKIP_HEALTHY") {
        skipHealthy++;
        markHealthy(id);
        console.log(`[SKIP_HEALTHY] ${id} :: ${c.msg}`);
      } else {
        fail++;
        console.log(`[FAIL] ${id} :: ${c.msg}`);
      }
    }
  }

  console.log(
    `\nDryrun summary: ok=${ok} skipHealthy=${skipHealthy} fail=${fail} checked=${subset.length} totalExecItems=${items.length} (DRYRUN_MAX=${max})`
  );

  // exit codes para tu loop:
  // 0 = OK encontrado
  // 3 = no OK (solo healthy / skips)
  // 2 = fail real
  if (fail > 0) process.exit(2);
  if (ok > 0) process.exit(0);
  process.exit(3);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

