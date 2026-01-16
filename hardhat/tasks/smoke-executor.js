import fs from "node:fs";
import path from "node:path";
import { isAddress, getAddress, zeroAddress } from "viem";

function pickLastAddressFromText(text) {
  const matches = text.match(/0x[a-fA-F0-9]{40}/g) ?? [];
  return matches.length ? matches[matches.length - 1] : null;
}

function pickExecutorFromDeployLog(text) {
  // Preferimos una línea tipo: "LiquidationExecutor: 0x...."
  const re = /LiquidationExecutor:\s*(0x[a-fA-F0-9]{40})/g;
  let m;
  let last = null;
  while ((m = re.exec(text)) !== null) last = m[1];
  if (last) return last;

  // Fallback: última address 0x... del log
  return pickLastAddressFromText(text);
}

function resolveExecutorAddress(taskArgs, hre) {
  const fromCli = (taskArgs.address ?? "").trim();
  if (fromCli) return { addrRaw: fromCli, source: "cli(--address)" };

  const fromEnv = (process.env.EXECUTOR_ADDRESS ?? "").trim();
  if (fromEnv) return { addrRaw: fromEnv, source: "env(EXECUTOR_ADDRESS)" };

  // Fallback profesional: si existe deploy.<network>.log, tomamos la última address (o LiquidationExecutor: ...)
  const netName = (hre?.network?.name ?? "").trim() || "unknown";
  const logFile = path.resolve(process.cwd(), `deploy.${netName}.log`);
  if (fs.existsSync(logFile)) {
    const text = fs.readFileSync(logFile, "utf8");
    const v = pickExecutorFromDeployLog(text);
    if (v) return { addrRaw: v.trim(), source: `log(${path.basename(logFile)})` };
  }

  return { addrRaw: "", source: "none" };
}

export default async function (taskArgs, hre) {
  const expectedChainId = 42161;

  const resolved = resolveExecutorAddress(taskArgs, hre);
  const addrRaw = resolved.addrRaw;

  if (!addrRaw) {
    // Debug útil si vuelve a pasar
    const envV = process.env.EXECUTOR_ADDRESS;
    console.error("DEBUG: process.env.EXECUTOR_ADDRESS =", envV);
    throw new Error("Missing --address or EXECUTOR_ADDRESS (and no deploy.<network>.log fallback found)");
  }

  if (!isAddress(addrRaw)) throw new Error(`Invalid address: ${addrRaw}`);
  const address = getAddress(addrRaw);

  const { viem } = await hre.network.connect();
  const publicClient = await viem.getPublicClient();

  const chainId = await publicClient.getChainId();
  if (chainId !== expectedChainId) throw new Error(`Wrong chainId: ${chainId}`);

  const artifact = await hre.artifacts.readArtifact("LiquidationExecutor");
  const abi = artifact.abi ?? [];

  const hasFn = (name) =>
    abi.some((x) => x?.type === "function" && x?.name === name && (x?.inputs?.length ?? 0) === 0);

  const mustNonZeroAny = async (label, fnNames) => {
    const fn = fnNames.find((n) => hasFn(n));
    if (!fn) {
      console.log(`skip: ${label} (none of ${fnNames.map((x) => `${x}()`).join(", ")} in ABI)`);
      return;
    }

    const v = await publicClient.readContract({ address, abi, functionName: fn, args: [] });
    if (typeof v === "string" && v === zeroAddress) throw new Error(`${fn}() returned zero address`);
    console.log(`${fn}(): ${v}`);
  };

  console.log("== Smoke ==");
  console.log(`chainId: ${chainId}`);
  console.log(`contract: ${address}`);
  console.log(`addressSource: ${resolved.source}`);

  // Requeridos
  await mustNonZeroAny("treasury", ["treasury"]);
  await mustNonZeroAny("owner", ["owner"]);

  // Compat: prueba nombres “legacy” y “reales”
  await mustNonZeroAny("Aave Pool", ["AAVE_POOL", "aavePool", "POOL", "pool"]);
  await mustNonZeroAny("Morpho", ["MORPHO", "morpho"]);
  await mustNonZeroAny("Swap Router", ["SWAP_ROUTER", "swapRouter"]);

  console.log("OK: smoke passed.");
}
