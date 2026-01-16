import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("morphoApi GraphQL: Markets query must type $chainIds as [Int!]!", () => {
  const src = readFileSync(new URL("../src/services/morphoApi.ts", import.meta.url), "utf8");
  assert.match(src, /query\s+Markets\(\$first:\s*Int!,\s*\$chainIds:\s*\[Int!\]!\)/);
});
