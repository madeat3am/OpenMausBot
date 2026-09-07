import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { validatePrivateEndpoint } from "./core.mjs";

const CONFIG_KEYS = new Set([
  "deviceId",
  "endpoint",
  "helperPath",
  "linuxHelperPath",
  "pollIntervalMs",
  "requestTimeoutMs",
  "statePath",
  "tokenFile",
  "uiOrigin",
]);
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export class ReceiverConfigError extends Error {
  constructor(code) {
    super(code);
    this.name = "ReceiverConfigError";
    this.code = code;
  }
}

function fail(code) {
  throw new ReceiverConfigError(code);
}

async function readPrivateFile(path, errorCode, maximumBytes) {
  if (typeof path !== "string" || !isAbsolute(path)) fail(errorCode);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const details = await handle.stat();
    if (!details.isFile() || details.size > maximumBytes || (details.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === "function" && details.uid !== process.getuid())) fail(errorCode);
    return await handle.readFile({ encoding: "utf8" });
  } catch {
    fail(errorCode);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function optionalInteger(value, minimum, maximum, code) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < minimum || value > maximum) fail(code);
  return value;
}

export async function loadReceiverConfig(configPath) {
  const raw = await readPrivateFile(configPath, "CONFIG_FILE_UNAVAILABLE", 32_768);
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    fail("INVALID_CONFIG_FILE");
  }
  if (config === null || typeof config !== "object" || Array.isArray(config) ||
      Object.keys(config).some((key) => !CONFIG_KEYS.has(key))) {
    fail("INVALID_CONFIG_FILE");
  }
  if (typeof config.deviceId !== "string" || !ID_RE.test(config.deviceId)) fail("INVALID_DEVICE_ID");
  if (typeof config.statePath !== "string" || !isAbsolute(config.statePath)) fail("INVALID_STATE_PATH");
  if (config.helperPath !== undefined && (typeof config.helperPath !== "string" || !isAbsolute(config.helperPath))) fail("INVALID_NATIVE_HELPER_PATH");
  if (config.linuxHelperPath !== undefined && (typeof config.linuxHelperPath !== "string" || !isAbsolute(config.linuxHelperPath))) fail("INVALID_LINUX_HELPER_PATH");

  let endpointUrl;
  let uiOriginUrl;
  try {
    endpointUrl = validatePrivateEndpoint(config.endpoint);
    uiOriginUrl = validatePrivateEndpoint(config.uiOrigin);
  } catch {
    fail("NON_PRIVATE_ENDPOINT");
  }
  if (endpointUrl.hostname.toLowerCase() !== uiOriginUrl.hostname.toLowerCase()) fail("ENDPOINT_HOST_MISMATCH");

  const tokenRaw = await readPrivateFile(config.tokenFile, "TOKEN_FILE_UNAVAILABLE", 4_097);
  const token = tokenRaw.endsWith("\n") ? tokenRaw.slice(0, -1) : tokenRaw;
  if (token.length < 1 || token.length > 4096 || /[\r\n]/.test(token)) fail("INVALID_TOKEN_FILE");

  return Object.freeze({
    deviceId: config.deviceId,
    endpoint: endpointUrl.origin,
    uiOrigin: uiOriginUrl.origin,
    statePath: config.statePath,
    tokenFile: config.tokenFile,
    token,
    ...(config.helperPath === undefined ? {} : { helperPath: config.helperPath }),
    ...(config.linuxHelperPath === undefined ? {} : { linuxHelperPath: config.linuxHelperPath }),
    ...(config.pollIntervalMs === undefined ? {} : {
      pollIntervalMs: optionalInteger(config.pollIntervalMs, 1_000, 3_600_000, "INVALID_POLL_INTERVAL"),
    }),
    ...(config.requestTimeoutMs === undefined ? {} : {
      requestTimeoutMs: optionalInteger(config.requestTimeoutMs, 1_000, 120_000, "INVALID_REQUEST_TIMEOUT"),
    }),
  });
}

export function defaultConfigPath(platform = process.platform, home = homedir()) {
  if (typeof home !== "string" || !isAbsolute(home)) fail("INVALID_HOME");
  if (platform === "darwin") return join(home, "Library", "Application Support", "OpenMausBot", "poppy-receiver.json");
  if (platform === "linux") return join(home, ".config", "openmausbot", "poppy-receiver.json");
  fail("UNSUPPORTED_PLATFORM");
}
