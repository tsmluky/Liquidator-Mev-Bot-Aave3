import { parseAbi, encodeFunctionData, decodeFunctionResult, formatUnits } from "viem";

const ABI = parseAbi([
  "function getPricesInWei() external view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
  "function getL1GasPriceEstimate() external view returns (uint256)",
]);

const DEFAULT_ARB_GASINFO = "0x000000000000000000000000000000000000006c" as const;

async function rpcCall(rpcUrl: string, method: string, params: any[]): Promise<any> {
  const r = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  const text = await r.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`RPC ${method} returned non-JSON: ${text.slice(0, 300)}`);
  }
  if (json?.error) throw new Error(`RPC ${method} error: ${JSON.stringify(json.error).slice(0, 300)}`);
  return json?.result;
}

function calldataUnitsWorstCase(calldataBytes: number): bigint {
  // Worst-case: all bytes are non-zero => 16 units/byte (Ethereum calldata gas schedule)
  const b = BigInt(Math.max(0, Math.trunc(calldataBytes)));
  return b * 16n;
}

async function getPricesInWei(rpcUrl: string, gasInfoAddr: `0x${string}` = DEFAULT_ARB_GASINFO) {
  const data = encodeFunctionData({ abi: ABI, functionName: "getPricesInWei", args: [] });
  const raw = await rpcCall(rpcUrl, "eth_call", [{ to: gasInfoAddr, data }, "latest"]);

  const decoded = decodeFunctionResult({ abi: ABI, functionName: "getPricesInWei", data: raw }) as readonly [
    bigint, bigint, bigint, bigint, bigint, bigint
  ];

  return {
    perL2TxWei: decoded[0],
    perL1CalldataUnitWei: decoded[1],
    perStorageAllocationWei: decoded[2],
    perArbGasBaseWei: decoded[3],
    perArbGasCongestionWei: decoded[4],
    perArbGasTotalWei: decoded[5],
  } as const;
}

async function getL1GasPriceEstimate(rpcUrl: string, gasInfoAddr: `0x${string}` = DEFAULT_ARB_GASINFO) {
  const data = encodeFunctionData({ abi: ABI, functionName: "getL1GasPriceEstimate", args: [] });
  const raw = await rpcCall(rpcUrl, "eth_call", [{ to: gasInfoAddr, data }, "latest"]);
  const decoded = decodeFunctionResult({ abi: ABI, functionName: "getL1GasPriceEstimate", data: raw }) as bigint;
  return decoded;
}

export async function estimateL1CalldataFeeUsd(args: {
  rpcUrl: string;
  calldataBytes: number;
  ethPriceUsd: number;
  gasInfoAddr?: `0x${string}`;
}) {
  const gasInfoAddr = args.gasInfoAddr ?? DEFAULT_ARB_GASINFO;

  const units = calldataUnitsWorstCase(args.calldataBytes);

  // Try method A: perL1CalldataUnitWei from getPricesInWei
  const prices = await getPricesInWei(args.rpcUrl, gasInfoAddr);

  let mode: "prices_per_unit" | "l1_gas_price_estimate" | "unavailable" = "unavailable";
  let feeWei = 0n;

  if (prices.perL1CalldataUnitWei > 0n) {
    mode = "prices_per_unit";
    feeWei = prices.perL1CalldataUnitWei * units;
  } else {
    // Fallback B: L1 gas price estimate * calldata units (worst-case)
    const l1GasPriceWei = await getL1GasPriceEstimate(args.rpcUrl, gasInfoAddr);
    if (l1GasPriceWei > 0n) {
      mode = "l1_gas_price_estimate";
      feeWei = l1GasPriceWei * units;
    } else {
      mode = "unavailable";
      feeWei = 0n;
    }
  }

  const feeEth = Number(formatUnits(feeWei, 18));
  const feeUsd = feeEth * args.ethPriceUsd;

  return {
    mode,
    calldataUnits: units,
    l1CalldataFeeWei: feeWei,
    l1CalldataFeeUsd: feeUsd,
    debug: {
      perL2TxWei: prices.perL2TxWei,
      perL1CalldataUnitWei: prices.perL1CalldataUnitWei,
      perArbGasBaseWei: prices.perArbGasBaseWei,
      perArbGasCongestionWei: prices.perArbGasCongestionWei,
      perArbGasTotalWei: prices.perArbGasTotalWei,
    },
  };
}
