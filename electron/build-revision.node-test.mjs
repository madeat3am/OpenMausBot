import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { packagedBuildRevision } = require("./build-revision.cjs");

test("returns an immutable full Git revision from packaged metadata", () => {
  const revision = "509a34b1234567890abcdef1234567890abcdef1";
  assert.equal(packagedBuildRevision({ buildRevision: revision }), revision);
});

test("rejects missing, abbreviated, and non-hex revisions", () => {
  assert.equal(packagedBuildRevision({}), "unknown");
  assert.equal(packagedBuildRevision({ buildRevision: "509a34b" }), "unknown");
  assert.equal(packagedBuildRevision({ buildRevision: "z".repeat(40) }), "unknown");
});
