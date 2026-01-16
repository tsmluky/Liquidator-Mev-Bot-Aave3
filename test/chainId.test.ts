import test from "node:test";
import assert from "node:assert/strict";
import { resolveChainId } from "../src/services/morphoApi.js";

test("resolveChainId: defaults to 42161 when input is undefined/invalid", () => {
  assert.equal(resolveChainId(undefined), 42161);
  assert.equal(resolveChainId(""), 42161);
  assert.equal(resolveChainId("NaN"), 42161);
});

test("resolveChainId: accepts valid integers (number|string)", () => {
  assert.equal(resolveChainId(42161), 42161);
  assert.equal(resolveChainId("42161"), 42161);
});
