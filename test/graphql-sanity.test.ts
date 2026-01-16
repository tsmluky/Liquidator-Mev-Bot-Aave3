import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("morphoApi GraphQL query must not contain resolveChainId(", () => {
  const src = readFileSync(new URL("../src/services/morphoApi.ts", import.meta.url), "utf8");
  assert.equal(src.includes("chainIds: [resolveChainId("), false);
});
