import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");

function fixture() {
  const handlers = new Map();
  const invocations = [];
  let bridge;
  const ipcRenderer = {
    on(channel, callback) { handlers.set(channel, callback); },
    removeListener(channel) { handlers.delete(channel); },
    invoke(...args) { invocations.push(args); return Promise.resolve(); },
    send(...args) { invocations.push(args); },
  };
  runInNewContext(source, {
    require(name) {
      assert.equal(name, "electron");
      return { ipcRenderer, webUtils: {}, contextBridge: {
        exposeInMainWorld(name, value) { assert.equal(name, "ogb"); bridge = value; },
      } };
    },
    process: { platform: "darwin", argv: ["--omb-local-origin=http://127.0.0.1:5173"] },
    location: { origin: "https://mau.example.ts.net" },
  });
  return { bridge, handlers, invocations };
}

test("remote Poppy bridge is receive-only and withholds privileged companion controls", () => {
  const { bridge, invocations } = fixture();
  assert.equal(typeof bridge.onPoppyOpen, "function");
  for (const key of ["companion", "companionAccount", "setCredential", "saveFile"]) {
    assert.equal(bridge[key], undefined);
  }
  const unsubscribe = bridge.onPoppyOpen(() => {});
  unsubscribe();
  assert.deepEqual(invocations, []);
});

test("remote Poppy bridge ignores other origins and delivers only latest pre-hydration target once", () => {
  const { bridge, handlers, invocations } = fixture();
  const incoming = handlers.get("poppy:open");
  const seen = [];
  incoming({}, { uiOrigin: "https://other.example.ts.net", target: { itemAlias: "wrong" } });
  incoming({}, { uiOrigin: "https://mau.example.ts.net", target: { itemAlias: "old" } });
  incoming({}, { uiOrigin: "https://mau.example.ts.net", target: { itemAlias: "current" } });
  const unsubscribe = bridge.onPoppyOpen((target) => seen.push(target.itemAlias));
  assert.deepEqual(seen, ["current"]);
  incoming({}, { uiOrigin: "https://mau.example.ts.net", target: { itemAlias: "new" } });
  assert.deepEqual(seen, ["current", "new"]);
  unsubscribe();
  bridge.onPoppyOpen((target) => seen.push(target.itemAlias));
  assert.deepEqual(seen, ["current", "new"]);
  assert.deepEqual(invocations, []);
});
