import test from "node:test";
import assert from "node:assert/strict";
import { resolveMorphoApiUrl } from "../src/services/morphoApi.js";

test("resolveMorphoApiUrl: returns default when undefined and no env", async () => {
  const prev = {
    MORPHO_API_URL: process.env.MORPHO_API_URL,
    MORPHO_API: process.env.MORPHO_API,
    MORPHO_GRAPHQL_URL: process.env.MORPHO_GRAPHQL_URL,
    MORPHO_API_ENDPOINT: process.env.MORPHO_API_ENDPOINT,
  };

  delete process.env.MORPHO_API_URL;
  delete process.env.MORPHO_API;
  delete process.env.MORPHO_GRAPHQL_URL;
  delete process.env.MORPHO_API_ENDPOINT;

  try {
    assert.equal(resolveMorphoApiUrl(undefined), "https://api.morpho.org/graphql");
  } finally {
    // restore
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("resolveMorphoApiUrl: prefers explicit input url", () => {
  assert.equal(resolveMorphoApiUrl("https://example.com/graphql"), "https://example.com/graphql");
});
