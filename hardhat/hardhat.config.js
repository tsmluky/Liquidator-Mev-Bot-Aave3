require("@nomicfoundation/hardhat-toolbox-viem");
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const ARB_RPC_URL = process.env.ARB_RPC_URL;

const networks = {
    hardhat: { type: "edr-simulated" },
};

if (ARB_RPC_URL) {
    networks.arbitrumOne = {
        type: "http",
        url: ARB_RPC_URL,
        accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
        chainId: 42161,
    };
}

module.exports = {
    solidity: {
        version: "0.8.20",
        settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true },
    },
    networks,
};
