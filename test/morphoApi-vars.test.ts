import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("morphoApi must not use $chainIds inside JS variables object", () => {
  const src = readFileSync(new URL("../src/services/morphoApi.ts", import.meta.url), "utf8");
  // Esto es el patrón que rompió runtime (no existe en GraphQL strings normalmente):
  assert.equal(src.includes("first: params.first, chainIds: $chainIds"), false);
});
