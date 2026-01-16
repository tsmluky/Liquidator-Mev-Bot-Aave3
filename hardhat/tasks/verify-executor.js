import fs from "node:fs";
import path from "node:path";
import { keccak256, isAddress, getAddress, zeroAddress, hexToBytes } from "viem";

/**
 * Strip Solidity CBOR metadata from the end of deployed bytecode.
 * Solidity appends: <runtime><cbor_metadata><2 bytes: metadata_length>
 */
function stripSolcMetadata(hex) {
  if (!hex || hex === "0x") return hex;
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length < 4) return hex;

  const lenHex = h.slice(-4);
  const metaLen = parseInt(lenHex, 16);
  if (!Number.isFinite(metaLen) || metaLen <= 0) return hex;

  const trailerBytes = metaLen + 2;
  const trailerHexChars = trailerBytes * 2;
  if (trailerHexChars >= h.length) return hex;

  const stripped = h.slice(0, h.length - trailerHexChars);
  return "0x" + stripped;
}

function maskRanges(hex, ranges) {
  if (!hex || hex === "0x") return hex;
  const has0x = hex.startsWith("0x");
  let h = has0x ? hex.slice(2) : hex;

  const arr = h.split("");
  for (const r of ranges) {
    const startHex = r.start * 2;
    const lenHex = r.length * 2;
    const endHex = startHex + lenHex;
    if (startHex < 0 || endHex > arr.length) continue;
    for (let i = startHex; i < endHex; i++) arr[i] = "0";
  }
  h = arr.join("");
  return (has0x ? "0x" : "") + h;
}

function flattenImmutableRefs(immutableReferences) {
  const ranges = [];
  if (!immutableReferences || typeof immutableReferences !== "object") return ranges;

  for (const k of Object.keys(immutableReferences)) {
    const arr = immutableReferences[k];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      const start = Number(item?.start);
      const length = Number(item?.length);
      if (Number.isFinite(start) && Number.isFinite(length) && start >= 0 && length > 0) {
        ranges.push({ start, length });
      }
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  return ranges;
}

/**
 * Find deployedBytecode + immutableReferences inside artifacts/build-info/*.json
 * Returns { deployedBytecodeObject, immutableReferences, buildInfoFile, sourceName }
 */
function findInBuildInfo(contractName) {
  const buildInfoDir = path.resolve(process.cwd(), "artifacts", "build-info");
  if (!fs.existsSync(buildInfoDir)) return null;

  const files = fs.readdirSync(buildInfoDir).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const full = path.join(buildInfoDir, f);
    let j;
    try {
      j = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch {
      continue;
    }

    const contracts = j?.output?.contracts;
    if (!contracts || typeof contracts !== "object") continue;

    for (const sourceName of Object.keys(contracts)) {
      const perSource = contracts[sourceName];
      if (!perSource || typeof perSource !== "object") continue;

      const c = perSource[contractName];
      if (!c) continue;

      const deployedBytecodeObject = c?.evm?.deployedBytecode?.object;
      const immutableReferences = c?.evm?.deployedBytecode?.immutableReferences;

      if (deployedBytecodeObject && deployedBytecodeObject !== "0x") {
        return {
          deployedBytecodeObject,
          immutableReferences: immutableReferences ?? null,
          buildInfoFile: f,
          sourceName,
        };
      }
    }
  }

  return null;
}

function pickLastAddressFromText(text) {
  const matches = text.match(/0x[a-fA-F0-9]{40}/g) ?? [];
  return matches.length ? matches[matches.length - 1] : null;
}

function pickExecutorFromDeployLog(text) {
  const re = /LiquidationExecutor:\s*(0x[a-fA-F0-9]{40})/g;
  let m;
  let last = null;
  while ((m = re.exec(text)) !== null) last = m[1];
  if (last) return last;
  return pickLastAddressFromText(text);
}

function resolveExecutorAddress(taskArgs, hre) {
  const fromCli = (taskArgs.address ?? "").trim();
  if (fromCli) return { addrRaw: fromCli, source: "cli(--address)" };

  const fromEnv = (process.env.EXECUTOR_ADDRESS ?? "").trim();
  if (fromEnv) return { addrRaw: fromEnv, source: "env(EXECUTOR_ADDRESS)" };

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
  const contractName = "LiquidationExecutor";

  const resolved = resolveExecutorAddress(taskArgs, hre);
  const addrRaw = resolved.addrRaw;

  if (!addrRaw) {
    console.error("DEBUG: process.env.EXECUTOR_ADDRESS =", process.env.EXECUTOR_ADDRESS);
    throw new Error("Missing --address or EXECUTOR_ADDRESS (and no deploy.<network>.log fallback found)");
  }

  if (!isAddress(addrRaw)) throw new Error(`Invalid address: ${addrRaw}`);
  const address = getAddress(addrRaw);

  const { viem } = await hre.network.connect();
  const publicClient = await viem.getPublicClient();

  const chainId = await publicClient.getChainId();
  if (chainId !== expectedChainId) {
    throw new Error(`Wrong chainId. Expected ${expectedChainId} (Arbitrum One), got ${chainId}`);
  }

  const onchainCode = await publicClient.getBytecode({ address });
  if (!onchainCode || onchainCode === "0x") {
    throw new Error(`No bytecode at ${address}. Not a contract or wrong address/network.`);
  }

  const artifact = await hre.artifacts.readArtifact(contractName);
  const abi = artifact.abi ?? [];

  // local deployed bytecode (artifact)
  let localDeployedBytecode =
    (typeof artifact.deployedBytecode === "string" ? artifact.deployedBytecode : "") ||
    artifact.deployedBytecode?.object ||
    artifact.evm?.deployedBytecode?.object ||
    "";

  // immutable refs (artifact)
  let immutableReferences =
    artifact.evm?.deployedBytecode?.immutableReferences ||
    artifact.deployedBytecode?.immutableReferences ||
    null;

  // Fallback: use build-info (more "solc-native")
  let buildInfoUsed = null;
  if (!immutableReferences || Object.keys(immutableReferences ?? {}).length === 0) {
    const bi = findInBuildInfo(contractName);
    if (bi) {
      buildInfoUsed = bi;
      const obj = bi.deployedBytecodeObject.startsWith("0x")
        ? bi.deployedBytecodeObject
        : "0x" + bi.deployedBytecodeObject;
      localDeployedBytecode = obj;
      immutableReferences = bi.immutableReferences ?? null;
    }
  }

  if (!localDeployedBytecode || localDeployedBytecode === "0x") {
    throw new Error("Could not find deployed bytecode locally (artifact/build-info).");
  }

  const ranges = flattenImmutableRefs(immutableReferences);

  const onchainStripped = stripSolcMetadata(onchainCode);
  const localStripped = stripSolcMetadata(localDeployedBytecode);

  const onchainMasked = maskRanges(onchainStripped, ranges);
  const localMasked = maskRanges(localStripped, ranges);

  const onchainMaskedHash = keccak256(hexToBytes(onchainMasked));
  const localMaskedHash = keccak256(hexToBytes(localMasked));

  console.log("== On-chain verification ==");
  console.log(`network.chainId: ${chainId}`);
  console.log(`contract: ${address}`);
  console.log(`addressSource: ${resolved.source}`);

  console.log("== Local source ==");
  if (buildInfoUsed) {
    console.log(`using build-info: artifacts/build-info/${buildInfoUsed.buildInfoFile}`);
    console.log(`sourceName: ${buildInfoUsed.sourceName}`);
  } else {
    console.log("using artifact bytecode");
  }

  console.log("== Bytecode lengths (stripped) ==");
  console.log(`len.onchain.stripped: ${onchainStripped.length} hex chars`);
  console.log(`len.local.stripped:   ${localStripped.length} hex chars`);

  console.log("== Immutable masking ==");
  console.log(`immutableRanges: ${ranges.length}`);
  if (ranges.length > 0) console.log("firstRanges:", ranges.slice(0, 6));
  else console.log("NOTE: immutableReferences empty. If contract uses immutables, we cannot mask without refs.");

  console.log("== Hashes (stripped + immu-masked) ==");
  console.log(`onchain.masked.keccak256: ${onchainMaskedHash}`);
  console.log(`local.masked.keccak256:   ${localMaskedHash}`);

  if (ranges.length === 0) {
    throw new Error("No immutableReferences available to mask. Comparison is unreliable if the contract uses immutables.");
  }

  if (onchainMaskedHash !== localMaskedHash) {
    throw new Error("Bytecode mismatch after stripping metadata AND masking immutables (using build-info if available).");
  }

  console.log("OK: runtime matches after stripping metadata and masking immutables.");

  // Getter probe (guardrails)
  const hasFn = (name) =>
    abi.some((x) => x?.type === "function" && x?.name === name && (x?.inputs?.length ?? 0) === 0);

  const read0 = async (fnName) => {
    try {
      return await publicClient.readContract({ address, abi, functionName: fnName, args: [] });
    } catch {
      return undefined;
    }
  };

  const probeAny = async (label, names) => {
    const fn = names.find((n) => hasFn(n));
    if (!fn) return;
    const v = await read0(fn);
    if (typeof v === "string" && v === zeroAddress) throw new Error(`Guardrail failed: ${fn}() returned zero address`);
    console.log(`${fn}():`, v);
  };

  console.log("== Getter probe ==");
  await probeAny("owner", ["owner"]);
  await probeAny("treasury", ["treasury"]);
  await probeAny("aave", ["AAVE_POOL", "aavePool", "POOL", "pool"]);
  await probeAny("morpho", ["MORPHO", "morpho"]);
  await probeAny("router", ["SWAP_ROUTER", "swapRouter"]);

  console.log("Done.");
}
