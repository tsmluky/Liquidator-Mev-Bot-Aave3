import { task } from "hardhat/config";
import { ArgumentType } from "hardhat/types/arguments";

/**
 * Hardhat 3 tasks: arguments via .addOption({ name, type, defaultValue, ... })
 * NOT via addParam/addOptionalParam (Hardhat 2 API).
 */

function withAddressOption(t) {
  return t.addOption({
    name: "address",
    description: "Executor contract address (defaults to EXECUTOR_ADDRESS env var)",
    type: ArgumentType.STRING,
    defaultValue: "",
  });
}

export const verifyExecutorTask =
  withAddressOption(
    task("verify-executor", "Verify deployed executor: chainId + bytecode hash + basic getters"),
  )
    .setAction(() => import("./verify-executor.js"))
    .build();

export const smokeExecutorTask =
  withAddressOption(
    task("smoke-executor", "Smoke-call executor getters and assert non-zero addresses"),
  )
    .setAction(() => import("./smoke-executor.js"))
    .build();

export const saveDeploymentTask =
  withAddressOption(
    task("save-deployment", "Persist deployment JSON (and tries to recover txHash via Etherscan API v2)"),
  )
    .addOption({
      name: "out",
      description: "Output path",
      type: ArgumentType.STRING,
      defaultValue: "deployments/arbitrumOne.json",
    })
    .setAction(() => import("./save-deployment.js"))
    .build();

export const executorTasks = [verifyExecutorTask, smokeExecutorTask, saveDeploymentTask];
