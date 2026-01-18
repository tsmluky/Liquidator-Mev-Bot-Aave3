import { Address, parseAbi } from "viem";
import { createPublicClient, http } from "viem";
import { arbitrum } from "viem/chains";

const client = createPublicClient({
    chain: arbitrum,
    transport: http(process.env.ARB_RPC_URL)
});

// Top 6 reserves on Arbitrum Aave V3
const TOP_RESERVES: Address[] = [
    "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // USDC
    "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", // USDT
    "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // WETH
    "0x912CE59144191C1204E64559FE8253a0e49E6548", // ARB
    "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", // WBTC
    "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", // DAI
];

export async function getUserAssets(user: Address, poolAddressProvider: Address, poolAddr: Address) {
    // Get PoolDataProvider
    const poolDataProviderAddr = await client.readContract({
        address: poolAddressProvider,
        abi: parseAbi(["function getPoolDataProvider() external view returns (address)"]),
        functionName: "getPoolDataProvider"
    }) as Address;

    // Get reserve prices
    const oracle = await client.readContract({
        address: poolAddressProvider,
        abi: parseAbi(["function getPriceOracle() external view returns (address)"]),
        functionName: "getPriceOracle"
    }) as Address;

    let bestDebt: Address | null = null;
    let bestCollateral: Address | null = null;
    let maxDebtValue = 0;
    let maxCollateralValue = 0;
    let bestDebtAmount: bigint = 0n;

    for (const reserveAsset of TOP_RESERVES) {
        // Get token addresses
        const [aTokenAddr, , varDebtTokenAddr] = await client.readContract({
            address: poolDataProviderAddr,
            abi: parseAbi(["function getReserveTokensAddresses(address asset) external view returns (address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress)"]),
            functionName: "getReserveTokensAddresses",
            args: [reserveAsset]
        }) as [Address, Address, Address];

        // Get price
        const price = await client.readContract({
            address: oracle,
            abi: parseAbi(["function getAssetPrice(address asset) external view returns (uint256)"]),
            functionName: "getAssetPrice",
            args: [reserveAsset]
        }) as bigint;

        // Check collateral
        const aTokenBalance = await client.readContract({
            address: aTokenAddr,
            abi: parseAbi(["function balanceOf(address) external view returns (uint256)"]),
            functionName: "balanceOf",
            args: [user]
        }) as bigint;

        if (aTokenBalance > 0n) {
            const value = Number(aTokenBalance * price) / 1e8;
            if (value > maxCollateralValue) {
                maxCollateralValue = value;
                bestCollateral = reserveAsset;
            }
        }

        // Check debt
        const debtBalance = await client.readContract({
            address: varDebtTokenAddr,
            abi: parseAbi(["function balanceOf(address) external view returns (uint256)"]),
            functionName: "balanceOf",
            args: [user]
        }) as bigint;

        if (debtBalance > 0n) {
            const value = Number(debtBalance * price) / 1e8;
            if (value > maxDebtValue) {
                maxDebtValue = value;
                bestDebt = reserveAsset;
                bestDebtAmount = debtBalance;
            }
        }
    }

    return {
        bestDebt: bestDebt || "0x0000000000000000000000000000000000000000" as Address,
        bestCollateral: bestCollateral || "0x0000000000000000000000000000000000000000" as Address,
        bestDebtAmount
    };
}
