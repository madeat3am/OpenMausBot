import fs from "node:fs";
import path from "node:path";

import { normalizeManagedComposioBrokerUrl } from "./managed-composio.mjs";

const TOKEN = /^[0-9a-f]{64}$/;

export function parseManagedComposioExportArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!["--source", "--output", "--broker-url"].includes(name)) continue;
    values.set(name, argv[index + 1] ?? "");
    index += 1;
  }
  return {
    source: values.get("--source") ?? "",
    output: values.get("--output") ?? "",
    brokerUrl: normalizeManagedComposioBrokerUrl(values.get("--broker-url") ?? ""),
  };
}

function readRegularFile(file, fsImpl) {
  if (!path.isAbsolute(file)) throw new Error("source and output paths must be absolute");
  const stats = fsImpl.lstatSync(file);
  if (!stats.isFile() || stats.nlink !== 1) throw new Error("credential source must be one regular file");
  const flags =
    fsImpl.constants.O_RDONLY |
    (process.platform === "win32" ? 0 : fsImpl.constants.O_NOFOLLOW ?? 0);
  const handle = fsImpl.openSync(file, flags);
  try {
    const opened = fsImpl.fstatSync(handle);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stats.dev || opened.ino !== stats.ino) {
      throw new Error("credential source must be one regular file");
    }
    return fsImpl.readFileSync(handle);
  } finally {
    fsImpl.closeSync(handle);
  }
}

export async function exportManagedComposioCredential({
  source,
  output,
  brokerUrl,
  decrypt,
  storageAvailable,
  fsImpl = fs,
}) {
  const normalizedBrokerUrl = normalizeManagedComposioBrokerUrl(brokerUrl);
  if (!normalizedBrokerUrl) throw new Error("an HTTPS managed broker URL is required");
  const encrypted = readRegularFile(source, fsImpl);
  if (!path.isAbsolute(output) || path.dirname(output) === output) {
    throw new Error("source and output paths must be absolute");
  }
  if (!(await storageAvailable())) throw new Error("the operating-system credential store is unavailable");

  const decrypted = await decrypt(encrypted);
  const text = typeof decrypted === "string" ? decrypted : decrypted?.result;
  let credentials;
  try {
    credentials = JSON.parse(text);
  } catch {
    throw new Error("the credential store is not readable");
  }
  if (!TOKEN.test(credentials?.composioBrokerToken ?? "")) {
    throw new Error("the managed connected-apps credential is missing or invalid");
  }
  if (typeof credentials?.composioInstallationId !== "string" || !credentials.composioInstallationId) {
    throw new Error("the managed connected-apps installation ID is missing or invalid");
  }

  fsImpl.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const flags =
    fsImpl.constants.O_WRONLY |
    fsImpl.constants.O_CREAT |
    fsImpl.constants.O_EXCL |
    (process.platform === "win32" ? 0 : fsImpl.constants.O_NOFOLLOW ?? 0);
  let handle = null;
  let created = false;
  try {
    handle = fsImpl.openSync(output, flags, 0o600);
    created = true;
    if (process.platform !== "win32") fsImpl.fchmodSync(handle, 0o600);
    fsImpl.writeFileSync(
      handle,
      `${JSON.stringify({
        schema: "openmausbot.managed-composio-credential.v1",
        brokerUrl: normalizedBrokerUrl,
        token: credentials.composioBrokerToken,
        installationId: credentials.composioInstallationId,
      })}\n`,
      "utf8",
    );
    fsImpl.fsyncSync(handle);
  } catch (error) {
    if (handle !== null) fsImpl.closeSync(handle);
    handle = null;
    if (created) {
      try {
        fsImpl.rmSync(output, { force: true });
      } catch {}
    }
    throw error;
  } finally {
    if (handle !== null) fsImpl.closeSync(handle);
  }

  return { status: "exported", output };
}
