import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const source = fs.readFileSync(new URL("./main.mjs", import.meta.url), "utf8");

test("remote load failures retain the remote and enter the reconnect supervisor", () => {
  const start = source.indexOf('win.webContents.on("did-fail-load"');
  const end = source.indexOf('win.webContents.on("did-finish-load"', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const handler = source.slice(start, end);
  assert.match(handler, /remoteFailurePolicy/);
  assert.match(handler, /remoteReconnect\.failed/);
  assert.doesNotMatch(handler, /switchEnvironment\(LOCAL_ID\)/);
  assert.doesNotMatch(handler, /withActive\([^\n]+LOCAL_ID/);
});

test("only an explicit Local selection persists Local", () => {
  const writes = source.match(/persistEnvironments\(withActive\(environmentsState, LOCAL_ID\)\)/g) ?? [];
  assert.equal(writes.length, 1);
  const switchStart = source.indexOf("async function switchEnvironment");
  assert.ok(source.indexOf("if (id === LOCAL_ID)", switchStart) > switchStart);
});

test("corrupt saved server profiles show an unavailable page instead of Local", () => {
  assert.match(source, /environmentProfileUnavailable = profile\.error/);
  assert.match(source, /if \(environmentProfileUnavailable\)/);
  assert.match(source, /Saved server profile/);
});

test("cold start retries without waiting for an operator and new pairing joins the supervisor", () => {
  assert.match(source, /switchEnvironment\(remote\.id, \{ startup: true \}\)/);
  assert.match(source, /if \(!reconnect && !startup\)/);
  assert.match(source, /remoteReconnect\.select\(added\.id\);\s+persistEnvironments\(next\)/);
});
