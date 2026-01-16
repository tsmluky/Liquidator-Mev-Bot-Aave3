import fs from "node:fs";
import path from "node:path";
import { isAddress, getAddress } from "viem";

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

async function fetchJson(url) {
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}

export default async function (taskArgs, hre) {
  const expectedChainId = 42161;

  const addrRaw = (taskArgs.address ?? process.env.EXECUTOR_ADDRESS ?? "").trim();
  if (!addrRaw) throw new Error("Missing --address or EXECUTOR_ADDRESS");
  if (!isAddress(addrRaw)) throw new Error(`Invalid address: ${addrRaw}`);
  const address = getAddress(addrRaw);

  const outPath = (taskArgs.out ?? "deployments/arbitrumOne.json").trim();

  const { viem } = await hre.network.connect();
  const publicClient = await viem.getPublicClient();

  const chainId = await publicClient.getChainId();
  if (chainId !== expectedChainId) throw new Error(`Wrong chainId: ${chainId}`);

  // Pull constructor args from env (best-effort)
  const args = {
    AAVE_POOL: process.env.AAVE_POOL ?? null,
    MORPHO: process.env.MORPHO ?? null,
    SWAP_ROUTER: process.env.SWAP_ROUTER ?? null,
    TREASURY: process.env.TREASURY ?? null,
  };

  // Best-effort txHash recovery via Etherscan API v2
  let creation = { txHash: null, contractCreator: null, blockNumber: null, timestamp: null };
  const apiKey = (process.env.ETHERSCAN_API_KEY ?? "").trim();

  if (apiKey) {
    // Etherscan v2: /v2/api?chainid=42161&module=contract&action=getcontractcreation&contractaddresses=...
    const url =
      `https://api.etherscan.io/v2/api?chainid=${chainId}` +
      `&module=contract&action=getcontractcreation&contractaddresses=${address}` +
      `&apikey=${encodeURIComponent(apiKey)}`;

    const j = await fetchJson(url);
    const row = j?.result?.[0];
    const txHash = row?.txHash ?? row?.transactionHash ?? null;
    const contractCreator = row?.contractCreator ?? row?.creatorAddress ?? null;

    if (txHash) {
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
      const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
      creation = {
        txHash,
        contractCreator,
        blockNumber: Number(receipt.blockNumber),
        timestamp: new Date(Number(block.timestamp) * 1000).toISOString(),
      };
    } else {
      creation = { txHash: null, contractCreator, blockNumber: null, timestamp: null };
    }
  }

  const payload = {
    project: "morpho-liquidator-v0",
    network: "arbitrumOne",
    chainId,
    contract: "LiquidationExecutor",
    address,
    deployedAt: new Date().toISOString(),
    creation,
    args,
  };

  const absOut = path.resolve(process.cwd(), outPath);
  ensureDir(path.dirname(absOut));

  const tmp = absOut + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmp, absOut);

  console.log(`Saved: ${outPath}`);
  if (!apiKey) {
    console.log("Note: ETHERSCAN_API_KEY not set => creation.txHash not recovered.");
  } else if (!payload.creation.txHash) {
    console.log("Note: ETHERSCAN_API_KEY set but txHash could not be recovered (API returned empty).");
  } else {
    console.log(`creation.txHash: ${payload.creation.txHash}`);
  }
}
