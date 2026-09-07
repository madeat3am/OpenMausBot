#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { defaultConfigPath, loadReceiverConfig } from "./config.mjs";
import { createPoppyDesktopReceiver } from "./core.mjs";
import { createLinuxAdapter } from "./linux-adapter.mjs";
import { createMacAdapter } from "./macos/adapter.mjs";
import { createTopicOpener } from "./open-topic.mjs";

function configPathFromArgs(argv, platform) {
  if (argv.length === 0) return defaultConfigPath(platform);
  if (argv.length === 2 && argv[0] === "--config" && argv[1]?.startsWith("/")) return argv[1];
  throw new Error("INVALID_ARGUMENTS");
}

export async function startReceiver({
  argv = process.argv.slice(2),
  platform = process.platform,
  stderr = process.stderr,
  processTarget = process,
  loadConfig = loadReceiverConfig,
  receiverFactory = createPoppyDesktopReceiver,
  topicOpenerFactory = createTopicOpener,
  linuxAdapterFactory = createLinuxAdapter,
  macAdapterFactory = createMacAdapter,
} = {}) {
  const config = await loadConfig(configPathFromArgs(argv, platform));
  const openTopic = topicOpenerFactory({ platform });
  const showUnavailable = async () => { stderr.write("POPPY_ITEM_UNAVAILABLE\n"); };
  let receiver;
  const onActivate = async (itemAlias, revision) => receiver.activate(itemAlias, revision);

  let adapter;
  if (platform === "linux") {
    adapter = linuxAdapterFactory({
      openTopic,
      showUnavailable,
      ...(config.linuxHelperPath === undefined ? {} : { helperPath: config.linuxHelperPath }),
    });
  } else if (platform === "darwin") {
    if (config.helperPath === undefined) throw new Error("NATIVE_HELPER_REQUIRED");
    adapter = macAdapterFactory({ helperPath: config.helperPath, onActivate, openTopic, showUnavailable });
  } else {
    throw new Error("UNSUPPORTED_DESKTOP_PLATFORM");
  }

  receiver = receiverFactory({
    deviceId: config.deviceId,
    endpoint: config.endpoint,
    token: config.token,
    statePath: config.statePath,
    adapter,
    ...(config.pollIntervalMs === undefined ? {} : { pollIntervalMs: config.pollIntervalMs }),
    ...(config.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: config.requestTimeoutMs }),
  });
  receiver.start();

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    receiver.stop();
    adapter.close?.();
    processTarget.removeListener?.("SIGINT", close);
    processTarget.removeListener?.("SIGTERM", close);
  };
  processTarget.once?.("SIGINT", close);
  processTarget.once?.("SIGTERM", close);
  return { close, receiver };
}

async function main() {
  await startReceiver();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${typeof error?.code === "string" ? error.code : error?.message || "POPPY_RECEIVER_FAILED"}\n`);
    process.exitCode = 1;
  });
}
