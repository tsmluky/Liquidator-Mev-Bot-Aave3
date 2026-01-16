import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

function withEnv(overrides: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) {
    prev[k] = process.env[k];
    const v = overrides[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(overrides)) {
      const v = prev[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("Config defaults exist: GAS_PRICE_MULTIPLIER + GAS_LIMIT", () => {
  withEnv(
    {
      ARB_RPC_URL: "https://example.com",
      UNISWAP_V3_SWAPROUTER02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
      PRIVATE_KEY: undefined,
    },
    () => {
      const cfg = loadConfig();
      assert.equal(typeof cfg.GAS_PRICE_MULTIPLIER, "number");
      assert.equal(typeof cfg.GAS_LIMIT, "number");
      assert.ok(cfg.GAS_PRICE_MULTIPLIER > 0);
      assert.ok(cfg.GAS_LIMIT > 0);
    }
  );
});

test("PRIVATE_KEY placeholder is allowed (becomes undefined)", () => {
  withEnv(
    {
      ARB_RPC_URL: "https://example.com",
      UNISWAP_V3_SWAPROUTER02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
      PRIVATE_KEY: "0xREPLACE_ME",
    },
    () => {
      const cfg = loadConfig();
      assert.equal(cfg.PRIVATE_KEY, undefined);
    }
  );
});
