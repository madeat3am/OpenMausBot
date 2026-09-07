import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { createLinuxAdapter } from "./linux-adapter.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.killCount = 0;
  child.kill = () => { child.killCount += 1; };
  return child;
}

function alert(overrides = {}) {
  return {
    identifier: "poppy-0123456789abcdef0123456789abcdef",
    title: "Poppy needs your review.",
    body: "Poppy needs your review.",
    itemAlias: "opaque_alias",
    revision: 2,
    ...overrides,
  };
}

function callbacks() {
  return { openTopic() {}, showUnavailable() {} };
}

test("refuses to run outside Linux and requires absolute native paths", () => {
  assert.throws(() => createLinuxAdapter({ ...callbacks(), platform: "darwin" }), /LINUX_ADAPTER_UNAVAILABLE/);
  assert.throws(() => createLinuxAdapter({ ...callbacks(), platform: "linux", helperPath: "helper.py" }), /INVALID_LINUX_HELPER_PATH/);
  assert.throws(() => createLinuxAdapter({ ...callbacks(), platform: "linux", pythonPath: "python3" }), /INVALID_PYTHON_PATH/);
});

test("submits generic notification data on stdin with no private argv", async () => {
  const child = fakeChild();
  let captured;
  let input = "";
  child.stdin.on("data", (chunk) => { input += chunk; });
  const adapter = createLinuxAdapter({
    ...callbacks(),
    platform: "linux",
    helperPath: "/opt/openmausbot/linux/helper.py",
    spawnImpl(command, args, options) {
      captured = { command, args, options };
      return child;
    },
  });
  const submitted = adapter.notify(alert());
  child.stdout.write('{"kind":"submitted","identifier":"poppy-0123456789abcdef0123456789abcdef"}\n');
  await submitted;
  assert.equal(captured.command, "/usr/bin/python3");
  assert.deepEqual(captured.args, ["/opt/openmausbot/linux/helper.py"]);
  assert.equal(captured.options.shell, false);
  const processSurface = JSON.stringify(captured);
  assert.equal(processSurface.includes("opaque_alias"), false);
  assert.equal(processSurface.includes("0123456789abcdef"), false);
  assert.deepEqual(JSON.parse(input), alert());
  child.emit("exit", 0);
});

test("fails closed on malformed acknowledgement or helper failure", async () => {
  const exited = fakeChild();
  const adapter = createLinuxAdapter({ ...callbacks(), platform: "linux", spawnImpl() { return exited; } });
  const noAck = adapter.notify(alert());
  exited.stdout.write('{"kind":"submitted","identifier":"poppy-ffffffffffffffffffffffffffffffff"}\n');
  exited.emit("exit", 0);
  await assert.rejects(noAck, /NATIVE_NOTIFICATION_UNAVAILABLE/);

  const failedChild = fakeChild();
  const failing = createLinuxAdapter({ ...callbacks(), platform: "linux", spawnImpl() { return failedChild; } });
  const failed = failing.notify(alert());
  failedChild.stdout.write('{"kind":"failed"}\n');
  await assert.rejects(failed, /NATIVE_NOTIFICATION_UNAVAILABLE/);
});

test("closes active helpers and rejects non-generic inputs before spawning", async () => {
  const active = fakeChild();
  let spawned = 0;
  const adapter = createLinuxAdapter({
    ...callbacks(),
    platform: "linux",
    spawnImpl() { spawned += 1; return active; },
  });
  const pending = adapter.notify(alert());
  adapter.close();
  assert.equal(active.killCount, 1);
  active.emit("exit", 1);
  await assert.rejects(pending, /NATIVE_ADAPTER_UNAVAILABLE/);
  await assert.rejects(adapter.notify(alert({ body: "client content" })), /INVALID_NOTIFICATION/);
  await assert.rejects(adapter.notify(alert({ itemAlias: "not/private" })), /INVALID_NOTIFICATION/);
  assert.equal(spawned, 1);
});
