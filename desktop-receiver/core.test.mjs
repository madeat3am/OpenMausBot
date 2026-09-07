import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPoppyDesktopReceiver, ReceiverError } from "./core.mjs";
import { defaultConfigPath, loadReceiverConfig, ReceiverConfigError } from "./config.mjs";
import { createMacAdapter } from "./macos/adapter.mjs";
import { startReceiver } from "./run.mjs";

const NOW = Date.parse("2026-09-07T15:00:00.000Z");

function item(id, overrides = {}) {
  return {
    id,
    revision: 1,
    botId: "bot_poppy_opaque",
    threadId: "poppy_topic_private",
    sourceTaskId: "task_private",
    status: "pending",
    reviewStatus: "pending",
    readAt: null,
    dismissedAt: null,
    snoozedUntil: null,
    alertEligible: true,
    updatedAt: "2026-09-07T15:00:00.000Z",
    ...overrides,
  };
}

function response(status, body) {
  return { status, async json() { return body; } };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "poppy-receiver-"));
  const notifications = [];
  const opened = [];
  const unavailable = [];
  const adapter = {
    async notify(alert) { notifications.push(alert); },
    async openTopic(value) { opened.push(value); },
    async showUnavailable() { unavailable.push(true); },
  };
  return {
    root,
    statePath: join(root, "state.json"),
    notifications,
    opened,
    unavailable,
    adapter,
    async close() { await rm(root, { recursive: true, force: true }); },
  };
}

function receiver(fx, fetchImpl, overrides = {}) {
  return createPoppyDesktopReceiver({
    deviceId: "desktop-mac",
    endpoint: "https://mau.example.ts.net",
    token: "opaque-test-bearer",
    statePath: fx.statePath,
    adapter: fx.adapter,
    fetchImpl,
    now: () => NOW,
    ...overrides,
  });
}

test("rejects non-private endpoints and requires an injected native adapter", () => {
  const base = {
    deviceId: "desktop-mac",
    endpoint: "https://mau.example.ts.net",
    token: "token",
    statePath: "/tmp/poppy-state.json",
  };
  assert.throws(() => createPoppyDesktopReceiver({ ...base, adapter: {} }), (error) => error.code === "NATIVE_ADAPTER_UNAVAILABLE");
  assert.throws(() => createPoppyDesktopReceiver({ ...base, endpoint: "https://example.com", adapter: { notify() {}, openTopic() {} } }), (error) => error.code === "NON_PRIVATE_ENDPOINT");
  assert.throws(() => createPoppyDesktopReceiver({ ...base, endpoint: "http://example.com", adapter: { notify() {}, openTopic() {} } }), (error) => error.code === "NON_PRIVATE_ENDPOINT");
  assert.throws(() => createPoppyDesktopReceiver({ ...base, endpoint: "http://192.168.1.20", adapter: { notify() {}, openTopic() {} } }), (error) => error.code === "NON_PRIVATE_ENDPOINT");
  assert.throws(() => createPoppyDesktopReceiver({ ...base, endpoint: "http://mau.local", adapter: { notify() {}, openTopic() {} } }), (error) => error.code === "NON_PRIVATE_ENDPOINT");
  assert.throws(() => createPoppyDesktopReceiver({ ...base, endpoint: "https://example.com", privateHostnames: ["example.com"], adapter: { notify() {}, openTopic() {} } }), (error) => error.code === "NON_PRIVATE_ENDPOINT");
  assert.doesNotThrow(() => createPoppyDesktopReceiver({ ...base, endpoint: "http://127.0.0.1", adapter: { notify() {}, openTopic() {} } }));
  assert.doesNotThrow(() => createPoppyDesktopReceiver({ ...base, endpoint: "http://100.100.100.10", adapter: { notify() {}, openTopic() {} } }));
  assert.doesNotThrow(() => createPoppyDesktopReceiver({ ...base, endpoint: "http://[fd7a:115c:a1e0::1]", adapter: { notify() {}, openTopic() {} } }));
});

test("finishes a paginated snapshot before emitting one generic alert and persists 0600 state", async () => {
  const fx = await fixture();
  try {
    const calls = [];
    const first = { cursor: "snap-1", items: [item("alias_one")], hasMore: true, nextPage: "page-2" };
    const second = { cursor: "snap-1", items: [item("alias_two")], hasMore: false, nextPage: null };
    const fetchImpl = async (url) => {
      calls.push(new URL(url).toString());
      return calls.at(-1).includes("page=page-2") ? response(200, second) : response(200, first);
    };
    const result = await receiver(fx, fetchImpl).poll();
    assert.deepEqual(result, { cursor: "snap-1", seen: 2, notified: 2 });
    assert.equal(calls.length, 2);
    assert.equal(new URL(calls[0]).searchParams.has("cursor"), false);
    assert.equal(new URL(calls[1]).searchParams.get("cursor"), "snap-1");
    assert.equal(fx.notifications.length, 2);
    for (const alert of fx.notifications) {
      assert.equal(alert.title, "Poppy needs your review.");
      assert.equal(alert.body, "Poppy needs your review.");
      assert.match(alert.itemAlias, /^alias_/);
      assert.equal(alert.revision, 1);
      assert.match(alert.identifier, /^poppy-[0-9a-f]{32}$/);
      assert.equal(JSON.stringify({ title: alert.title, body: alert.body, identifier: alert.identifier }).includes("alias_"), false);
    }
    const stored = JSON.parse(await readFile(fx.statePath, "utf8"));
    assert.equal(stored.version, 2);
    assert.match(stored.binding, /^[a-f0-9]{64}$/);
    assert.equal(stored.cursor, "snap-1");
    assert.equal(stored.deliveryKeys.length, 2);
    assert.ok(stored.deliveryKeys.every((key) => /^[a-f0-9]{64}$/.test(key)));
    const disk = await readFile(fx.statePath, "utf8");
    assert.equal(disk.includes("opaque-test-bearer"), false);
    assert.equal(disk.includes("mau.example.ts.net"), false);
    assert.equal(disk.includes("desktop-mac"), false);
    assert.equal(disk.includes("alias_one"), false);
    assert.equal(disk.includes("poppy_topic_private"), false);
    assert.equal(disk.includes("task_private"), false);
    assert.equal((await stat(fx.statePath)).mode & 0o777, 0o600);
  } finally {
    await fx.close();
  }
});

test("filters resolved, read, dismissed, snoozed, and ineligible items", async () => {
  const fx = await fixture();
  try {
    const page = {
      cursor: "snap-filter",
      items: [
        item("resolved", { status: "resolved" }),
        item("read", { readAt: "2026-09-07T14:59:00.000Z" }),
        item("dismissed", { dismissedAt: "2026-09-07T14:59:00.000Z" }),
        item("snoozed", { snoozedUntil: "2026-09-07T16:00:00.000Z" }),
        item("ineligible", { alertEligible: false }),
      ],
      hasMore: false,
      nextPage: null,
    };
    const result = await receiver(fx, async () => response(200, page)).poll();
    assert.equal(result.notified, 0);
    assert.equal(fx.notifications.length, 0);
  } finally {
    await fx.close();
  }
});

test("does not duplicate a delivery after restart and alerts a new revision", async () => {
  const fx = await fixture();
  try {
    let current = item("alias_revision");
    const fetchImpl = async () => response(200, { cursor: "snap", items: [current], hasMore: false, nextPage: null });
    assert.equal((await receiver(fx, fetchImpl).poll()).notified, 1);
    const restarted = receiver(fx, fetchImpl);
    assert.equal((await restarted.poll()).notified, 0);
    current = item("alias_revision", { revision: 2, updatedAt: "2026-09-07T15:01:00.000Z" });
    assert.equal((await restarted.poll()).notified, 1);
    assert.equal(fx.notifications.length, 2);
  } finally {
    await fx.close();
  }
});

test("starts every polling cycle from a fresh first page without the stored cursor", async () => {
  const fx = await fixture();
  try {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(new URL(url));
      return response(200, { cursor: `fresh-${calls.length}`, items: [], hasMore: false, nextPage: null });
    };
    const active = receiver(fx, fetchImpl);
    assert.equal((await active.poll()).cursor, "fresh-1");
    assert.equal((await active.poll()).cursor, "fresh-2");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].searchParams.has("cursor"), false);
    assert.equal(calls[1].searchParams.has("cursor"), false);
  } finally {
    await fx.close();
  }
});

test("binds persisted delivery state to the paired device and endpoint", async () => {
  const fx = await fixture();
  try {
    const fetchImpl = async () => response(200, { cursor: "bound", items: [item("bound_alias")], hasMore: false, nextPage: null });
    await receiver(fx, fetchImpl).poll();
    await assert.rejects(
      receiver(fx, fetchImpl, { deviceId: "different-paired-device" }).poll(),
      (error) => error instanceof ReceiverError && error.code === "CORRUPT_STATE",
    );
    await assert.rejects(
      receiver(fx, fetchImpl, { endpoint: "https://other.example.ts.net" }).poll(),
      (error) => error instanceof ReceiverError && error.code === "CORRUPT_STATE",
    );
  } finally {
    await fx.close();
  }
});

test("refuses symlinked or oversized receiver state", async () => {
  const fx = await fixture();
  try {
    const { symlink, writeFile } = await import("node:fs/promises");
    const target = join(fx.root, "target-state.json");
    await writeFile(target, "{}\n", { mode: 0o600 });
    await symlink(target, fx.statePath);
    await assert.rejects(
      receiver(fx, async () => response(200, { cursor: "unused", items: [], hasMore: false, nextPage: null })).poll(),
      (error) => error instanceof ReceiverError && error.code === "CORRUPT_STATE",
    );
    await rm(fx.statePath);
    await writeFile(fx.statePath, "x".repeat(8 * 1024 * 1024 + 1), { mode: 0o600 });
    await assert.rejects(
      receiver(fx, async () => response(200, { cursor: "unused", items: [], hasMore: false, nextPage: null })).poll(),
      (error) => error instanceof ReceiverError && error.code === "CORRUPT_STATE",
    );
  } finally {
    await fx.close();
  }
});

test("adds a bounded timeout signal to snapshot and activation requests", async () => {
  const fx = await fixture();
  try {
    const signals = [];
    const fetchImpl = async (_url, init) => {
      signals.push(init.signal);
      return response(200, signals.length === 1
        ? { cursor: "timeout", items: [], hasMore: false, nextPage: null }
        : item("timeout_alias"));
    };
    const active = receiver(fx, fetchImpl, { requestTimeoutMs: 1_234 });
    await active.poll();
    await active.activate("timeout_alias", 1);
    assert.equal(signals.length, 2);
    assert.ok(signals.every((signal) => signal instanceof AbortSignal));
  } finally {
    await fx.close();
  }
});

test("refuses a malformed page without advancing the cursor", async () => {
  const fx = await fixture();
  try {
    await assert.rejects(receiver(fx, async () => response(200, { cursor: "bad", items: [] })).poll(), (error) => error instanceof ReceiverError && error.code === "MALFORMED_PAGE");
    await assert.rejects(stat(fx.statePath), (error) => error.code === "ENOENT");
  } finally {
    await fx.close();
  }
});

test("activation fetches the current exact alias and opens its current topic", async () => {
  const fx = await fixture();
  try {
    const current = item("alias_activate", { revision: 3, threadId: "current-topic", sourceTaskId: "current-task" });
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(new URL(url));
      return response(200, current);
    };
    const result = await receiver(fx, fetchImpl).activate("alias_activate", 1);
    assert.equal(result.status, "opened");
    assert.equal(urls[0].pathname, "/api/poppy/v1/items/alias_activate");
    assert.equal(fx.opened[0].threadId, "current-topic");
    assert.equal(fx.opened[0].sourceTaskId, "current-task");
  } finally {
    await fx.close();
  }
});

test("activation refuses missing aliases without a fallback topic", async () => {
  const fx = await fixture();
  try {
    const result = await receiver(fx, async () => response(404, { error: "not-visible" })).activate("alias_missing", 1);
    assert.deepEqual(result, { status: "unavailable" });
    assert.equal(fx.unavailable.length, 1);
    assert.equal(fx.opened.length, 0);
  } finally {
    await fx.close();
  }
});

test("activation drops a 410 target silently", async () => {
  const fx = await fixture();
  try {
    const result = await receiver(fx, async () => response(410, { error: "gone" })).activate("alias_gone", 1);
    assert.deepEqual(result, { status: "gone" });
    assert.equal(fx.unavailable.length, 0);
    assert.equal(fx.opened.length, 0);
  } finally {
    await fx.close();
  }
});

test("keeps the polling timer referenced for a background runner", async () => {
  const fx = await fixture();
  try {
    const active = receiver(fx, async () => response(200, { cursor: "timer", items: [], hasMore: false, nextPage: null }));
    active.start();
    assert.equal(active.timer.hasRef?.(), true);
    active.stop();
    await active.inFlight;
  } finally {
    await fx.close();
  }
});

test("loads only 0600 config and token files without embedding the bearer", async () => {
  const fx = await fixture();
  try {
    const configPath = join(fx.root, "receiver.json");
    const tokenFile = join(fx.root, "token");
    await import("node:fs/promises").then(({ writeFile }) => Promise.all([
      writeFile(tokenFile, "paired-bearer\n", { mode: 0o600 }),
      writeFile(configPath, JSON.stringify({
        deviceId: "paired-device",
        endpoint: "https://mau.example.ts.net",
        uiOrigin: "https://mau.example.ts.net:5173",
        statePath: fx.statePath,
        tokenFile,
        linuxHelperPath: "/opt/openmausbot/linux/helper.py",
        pollIntervalMs: 30_000,
        requestTimeoutMs: 5_000,
      }), { mode: 0o600 }),
    ]));
    const loaded = await loadReceiverConfig(configPath);
    assert.equal(loaded.token, "paired-bearer");
    assert.equal(loaded.endpoint, "https://mau.example.ts.net");
    assert.equal(loaded.uiOrigin, "https://mau.example.ts.net:5173");
    assert.equal((await readFile(configPath, "utf8")).includes("paired-bearer"), false);
  } finally {
    await fx.close();
  }
});

test("rejects permissive, symlinked, or mismatched private config inputs", async () => {
  const fx = await fixture();
  try {
    const { chmod, symlink, writeFile } = await import("node:fs/promises");
    const configPath = join(fx.root, "receiver.json");
    const tokenFile = join(fx.root, "token");
    const config = {
      deviceId: "paired-device",
      endpoint: "https://mau.example.ts.net",
      uiOrigin: "https://mau.example.ts.net:5173",
      statePath: fx.statePath,
      tokenFile,
    };
    await writeFile(tokenFile, "secret\n", { mode: 0o644 });
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    await assert.rejects(loadReceiverConfig(configPath), (error) => error instanceof ReceiverConfigError && error.code === "TOKEN_FILE_UNAVAILABLE");
    await chmod(tokenFile, 0o600);
    await chmod(configPath, 0o644);
    await assert.rejects(loadReceiverConfig(configPath), (error) => error instanceof ReceiverConfigError && error.code === "CONFIG_FILE_UNAVAILABLE");
    await chmod(configPath, 0o600);
    await writeFile(configPath, JSON.stringify({ ...config, uiOrigin: "https://public.example.com" }), { mode: 0o600 });
    await assert.rejects(loadReceiverConfig(configPath), (error) => error instanceof ReceiverConfigError && error.code === "NON_PRIVATE_ENDPOINT");
    await writeFile(configPath, JSON.stringify({ ...config, uiOrigin: "https://other.example.ts.net" }), { mode: 0o600 });
    await assert.rejects(loadReceiverConfig(configPath), (error) => error instanceof ReceiverConfigError && error.code === "ENDPOINT_HOST_MISMATCH");
    const linkedToken = join(fx.root, "linked-token");
    await symlink(tokenFile, linkedToken);
    await writeFile(configPath, JSON.stringify({ ...config, tokenFile: linkedToken }), { mode: 0o600 });
    await assert.rejects(loadReceiverConfig(configPath), (error) => error instanceof ReceiverConfigError && error.code === "TOKEN_FILE_UNAVAILABLE");
    await writeFile(tokenFile, "x".repeat(4_098), { mode: 0o600 });
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    await assert.rejects(loadReceiverConfig(configPath), (error) => error instanceof ReceiverConfigError && error.code === "TOKEN_FILE_UNAVAILABLE");
    await writeFile(tokenFile, "secret\n", { mode: 0o600 });
    await writeFile(configPath, JSON.stringify({ ...config, deviceId: 42 }), { mode: 0o600 });
    await assert.rejects(loadReceiverConfig(configPath), (error) => error instanceof ReceiverConfigError && error.code === "INVALID_DEVICE_ID");
    await writeFile(configPath, " ".repeat(32_769), { mode: 0o600 });
    await assert.rejects(loadReceiverConfig(configPath), (error) => error instanceof ReceiverConfigError && error.code === "CONFIG_FILE_UNAVAILABLE");
  } finally {
    await fx.close();
  }
});

test("selects the documented per-user config path for Mac and Linux", () => {
  assert.equal(defaultConfigPath("darwin", "/Users/example"), "/Users/example/Library/Application Support/OpenMausBot/poppy-receiver.json");
  assert.equal(defaultConfigPath("linux", "/home/example"), "/home/example/.config/openmausbot/poppy-receiver.json");
  assert.throws(() => defaultConfigPath("win32", "/Users/example"), /UNSUPPORTED_PLATFORM/);
});

test("runner wires the Linux adapter and opener without exposing its token", async () => {
  const processTarget = new EventEmitter();
  const writes = [];
  let adapterOptions;
  let receiverConfig;
  let starts = 0;
  let stops = 0;
  let closes = 0;
  const running = await startReceiver({
    argv: ["--config", "/private/receiver.json"],
    platform: "linux",
    stderr: { write(value) { writes.push(value); } },
    processTarget,
    async loadConfig(path) {
      assert.equal(path, "/private/receiver.json");
      return {
        deviceId: "paired-device",
        endpoint: "https://mau.example.ts.net",
        uiOrigin: "https://mau.example.ts.net:5173",
        statePath: "/private/state.json",
        token: "private-bearer",
        linuxHelperPath: "/opt/openmausbot/linux/helper.py",
      };
    },
    topicOpenerFactory({ platform }) {
      assert.equal(platform, "linux");
      return async () => undefined;
    },
    linuxAdapterFactory(options) {
      adapterOptions = options;
      return { notify() {}, openTopic: options.openTopic, showUnavailable: options.showUnavailable, close() { closes += 1; } };
    },
    receiverFactory(config) {
      receiverConfig = config;
      return {
        start() { starts += 1; },
        stop() { stops += 1; },
        async activate() { throw new Error("Linux notification actions use the persistent first-party deep link"); },
      };
    },
  });
  assert.equal(receiverConfig.token, "private-bearer");
  assert.equal(JSON.stringify(adapterOptions).includes("private-bearer"), false);
  assert.equal("onActivate" in adapterOptions, false);
  await adapterOptions.showUnavailable();
  assert.deepEqual(writes, ["POPPY_ITEM_UNAVAILABLE\n"]);
  assert.equal(starts, 1);
  running.close();
  assert.equal(stops, 1);
  assert.equal(closes, 1);
});

test("a Mac helper crash stops the poller and leaves a generic nonzero supervisor result", async () => {
  const fx = await fixture();
  try {
    const processTarget = new EventEmitter();
    const stderr = [];
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = () => child.emit("exit", 0);
    let submissions = 0;
    let revision = 1;
    child.stdin.on("data", (bytes) => {
      submissions += 1;
      const notice = JSON.parse(bytes.toString());
      child.stdout.write(JSON.stringify({ kind: "submitted", identifier: notice.identifier }) + "\n");
    });
    const running = await startReceiver({
      argv: [],
      platform: "darwin",
      processTarget,
      stderr: { write(value) { stderr.push(value); } },
      async loadConfig() {
        return {
          deviceId: "fixture-device",
          endpoint: "http://127.0.0.1:12345",
          token: "fixture-only",
          statePath: fx.statePath,
          helperPath: "/fixture/PoppyReceiver",
        };
      },
      topicOpenerFactory: () => async () => undefined,
      macAdapterFactory(options) {
        return createMacAdapter({ ...options, spawnImpl: () => child });
      },
      receiverFactory(config) {
        return createPoppyDesktopReceiver({
          ...config,
          fetchImpl: async () => response(200, {
            cursor: "fixture-snapshot",
            hasMore: false,
            nextPage: null,
            items: [item("opaque", { revision, updatedAt: "2026-09-07T16:00:00.000Z" })],
          }),
        });
      },
    });

    await running.receiver.poll();
    assert.equal(submissions, 1);
    child.emit("exit", 1);
    assert.equal(processTarget.exitCode, 1);
    assert.deepEqual(stderr, ["POPPY_RECEIVER_HELPER_FAILED\n"]);
    assert.equal(running.receiver.timer, null);

    revision = 2;
    await assert.rejects(running.receiver.poll(), /NATIVE_ADAPTER_UNAVAILABLE/);
    assert.equal(submissions, 1);
    running.close();

    const recoveredChild = new EventEmitter();
    recoveredChild.stdin = new PassThrough();
    recoveredChild.stdout = new PassThrough();
    recoveredChild.kill = () => recoveredChild.emit("exit", 0);
    let recoveredSubmissions = 0;
    recoveredChild.stdin.on("data", (bytes) => {
      recoveredSubmissions += 1;
      const notice = JSON.parse(bytes.toString());
      recoveredChild.stdout.write(JSON.stringify({ kind: "submitted", identifier: notice.identifier }) + "\n");
    });
    const restarted = await startReceiver({
      argv: [],
      platform: "darwin",
      processTarget: new EventEmitter(),
      stderr: { write() {} },
      async loadConfig() {
        return {
          deviceId: "fixture-device",
          endpoint: "http://127.0.0.1:12345",
          token: "fixture-only",
          statePath: fx.statePath,
          helperPath: "/fixture/PoppyReceiver",
        };
      },
      topicOpenerFactory: () => async () => undefined,
      macAdapterFactory(options) {
        return createMacAdapter({ ...options, spawnImpl: () => recoveredChild });
      },
      receiverFactory(config) {
        return createPoppyDesktopReceiver({
          ...config,
          fetchImpl: async () => response(200, {
            cursor: "fixture-snapshot",
            hasMore: false,
            nextPage: null,
            items: [item("opaque", { revision, updatedAt: "2026-09-07T17:00:00.000Z" })],
          }),
        });
      },
    });
    await restarted.receiver.poll();
    assert.equal(recoveredSubmissions, 1);
    restarted.close();
  } finally {
    await fx.close();
  }
});
