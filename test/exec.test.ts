import test from "node:test";
import assert from "node:assert/strict";
import { execCmd } from "../src/commands/exec.js";

// Force exec-enabled for unit tests that validate PRIVATE_KEY behavior
process.env.EXEC_ENABLED = "1";

function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) {
    prev[k] = process.env[k];
    const v = overrides[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(() => fn())
    .finally(() => {
      for (const k of Object.keys(overrides)) {
        const v = prev[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

test("exec requires a real PRIVATE_KEY", async () => {
  await withEnv(
    {
      ARB_RPC_URL: "https://example.com",
      PRIVATE_KEY: "0xREPLACE_ME",
      UNISWAP_V3_SWAPROUTER02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    },
    async () => {
      await assert.rejects(execCmd, /PRIVATE_KEY missing/i);
    }
  );
});

