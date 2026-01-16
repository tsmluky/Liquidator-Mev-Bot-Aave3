import {
    createPublicClient,
    http,
    parseAbi,
    PublicClient,
    formatUnits,
    Address,
    zeroAddress,
} from "viem";
import { arbitrum, base } from "viem/chains";
import { loadConfig } from "../config";
import { logger } from "../logger";

const config = loadConfig();

// Minimal ABI for UiPoolDataProviderV3
const UI_POOL_DATA_PROVIDER_ABI = parseAbi([
    "struct AggregatedReserveData { address underlyingAsset; string name; string symbol; uint256 decimals; uint256 baseLTVasCollateral; uint256 reserveLiquidationThreshold; uint256 reserveLiquidationBonus; uint256 reserveFactor; uint256 usageAsCollateralEnabled; uint256 borrowingEnabled; uint256 stableBorrowRateEnabled; uint256 isActive; uint256 isFrozen; uint128 liquidityIndex; uint128 variableBorrowIndex; uint128 liquidityRate; uint128 variableBorrowRate; uint128 stableBorrowRate; uint40 lastUpdateTimestamp; address aTokenAddress; address stableDebtTokenAddress; address variableDebtTokenAddress; address interestRateStrategyAddress; uint256 availableLiquidity; uint256 totalPrincipalStableDebt; uint256 averageStableRate; uint256 stableDebtLastUpdateTimestamp; uint256 totalScaledVariableDebt; uint256 priceInMarketReferenceCurrency; address priceOracle; uint256 variableRateSlope1; uint256 variableRateSlope2; uint256 stableRateSlope1; uint256 stableRateSlope2; uint256 baseStableBorrowRate; uint256 baseVariableBorrowRate; uint256 maxStableLoanPercent; uint256 flashLoanFee; uint256 availableApparentLiquidity; uint256 availableWethLiquidity; }",
    "struct BaseCurrencyInfo { uint256 marketReferenceCurrencyUnit; int256 marketReferenceCurrencyPriceInUsd; int256 networkBaseTokenPriceInUsd; uint8 networkBaseTokenPriceDecimals; }",
    "struct UserReserveData { address underlyingAsset; uint256 scaledATokenBalance; uint256 usageAsCollateralEnabledOnUser; uint256 stableBorrowRate; uint256 scaledVariableDebt; uint256 principalStableDebt; uint256 stableBorrowLastUpdateTimestamp; }",
    "function getReservesData(address provider) external view returns (AggregatedReserveData[] memory, BaseCurrencyInfo memory)",
    "function getUserReservesData(address provider, address user) external view returns (UserReserveData[] memory, uint8)",
]);

// Minimal ABI for Pool (to get user account data - verifying HF)
const POOL_ABI = parseAbi([
    "function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)"
]);

export interface UserHealth {
    user: Address;
    healthFactor: number;
    totalCollateralUSD: number;
    totalDebtUSD: number;
    bestDebt?: Address;
    bestCollateral?: Address;
    bestDebtAmount?: bigint;
}

export class AaveScanner {
    client: PublicClient;
    uiPoolDataProvider: Address;
    poolAddressProvider: Address;

    constructor() {
        this.client = createPublicClient({
            chain: (config.CHAIN_ID === 8453 ? base : arbitrum) as any,
            transport: http(config.ARB_RPC_URL),
            // batch: { multicall: true }, // Disabled for stability with huge UiPoolDataProvider returns
        }) as PublicClient;
        this.uiPoolDataProvider = config.AAVE_UI_POOL_DATA_PROVIDER as Address;
        this.poolAddressProvider = config.AAVE_POOL_ADDRESS_PROVIDER as Address;
    }

    async getReserves() {
        try {
            const [reserves, baseCurrency] = await this.client.readContract({
                address: this.uiPoolDataProvider,
                abi: UI_POOL_DATA_PROVIDER_ABI,
                functionName: "getReservesData",
                args: [this.poolAddressProvider],
            });
            return { reserves, baseCurrency };
        } catch (error) {
            logger.error(error, "Failed to get reserves data");
            throw error;
        }
    }

    async getUserData(user: Address) {
        try {
            const [userReserves, userEmode] = await this.client.readContract({
                address: this.uiPoolDataProvider,
                abi: UI_POOL_DATA_PROVIDER_ABI,
                functionName: "getUserReservesData",
                args: [this.poolAddressProvider, user]
            });
            return { userReserves, userEmode };
        } catch (error) {
            logger.error({ user, error }, "Failed to get user data");
            return null;
        }
    }

    async getUserHealth(user: Address): Promise<UserHealth | null> {
        // Fallback to single if needed, but we prefer batch
        const res = await this.getUsersHealthBatch([user]);
        return res[0] ?? null;
    }

    async getUsersHealthBatch(users: Address[]): Promise<(UserHealth | null)[]> {
        if (users.length === 0) return [];
        try {
            const poolAddress = await this.getPoolAddress();

            // Multicall: Get Account Data
            const contracts = users.map(u => ({
                address: poolAddress,
                abi: POOL_ABI,
                functionName: "getUserAccountData",
                args: [u]
            }));

            // Use client.multicall
            const results = await this.client.multicall({ contracts });

            // Parse results
            return await Promise.all(results.map(async (r, i) => {
                if (r.status !== "success" || !r.result) return null;
                const [totalCollateralBase, totalDebtBase, availableBorrowsBase, currentLiquidationThreshold, ltv, healthFactor] = r.result as any;

                const hf = Number(healthFactor) / 1e18;

                // Detailed data only if needed (HF < 1.1)
                // We SKIP fetch detailed reserves for SAFE users to save bandwidth.
                // This is the true optimization.
                if (hf >= 1.1) {
                    return {
                        user: users[i],
                        healthFactor: hf,
                        totalCollateralUSD: Number(totalCollateralBase) / 1e8,
                        totalDebtUSD: Number(totalDebtBase) / 1e8,
                    };
                }

                // If dangerous, fetch detailed data (single user call, but rare)
                return this.getUserHealthDetailed(users[i]);
            }));

        } catch (e) {
            logger.error({ error: e }, "Batch health failed");
            return users.map(() => null);
        }
    }

    async getUserHealthDetailed(user: Address): Promise<UserHealth | null> {
        try {
            const poolAddress = await this.getPoolAddress();

            // Get basic health - FAST
            const accountData = await this.client.readContract({
                address: poolAddress,
                abi: parseAbi([
                    "function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)"
                ]),
                functionName: "getUserAccountData",
                args: [user]
            });

            const [totalCollateralBase, totalDebtBase, , , , healthFactor] = accountData;
            const hfNum = Number(healthFactor) / 1e18;
            const totalCollateralUSD = Number(totalCollateralBase) / 1e8;
            const totalDebtUSD = Number(totalDebtBase) / 1e8;

            // NOTE: We don't fetch bestDebt/bestCollateral here (too slow for scan)
            // The planner will fetch these details when needed
            return {
                user,
                healthFactor: hfNum,
                totalCollateralUSD,
                totalDebtUSD,
                bestDebt: "0x0000000000000000000000000000000000000000" as Address,
                bestCollateral: "0x0000000000000000000000000000000000000000" as Address,
                bestDebtAmount: undefined
            };
        } catch (error: any) {
            logger.error({ user, error: error.message || error }, "Failed to get user health");
            return null;
        }
    }

    private _poolAddress: Address | undefined;
    async getPoolAddress(): Promise<Address> {
        if (this._poolAddress) return this._poolAddress;

        // Hardcoded for stability
        if (config.CHAIN_ID === 8453) {
            this._poolAddress = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5"; // Base
        } else {
            this._poolAddress = "0x794a61358d6845594f94dc1db02a252b5b4814ad"; // Arbitrum
        }
        return this._poolAddress;
    }
}
