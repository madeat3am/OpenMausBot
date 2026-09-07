import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { isAbsolute } from "node:path";

export function createMacAdapter({ helperPath, onActivate, openTopic, showUnavailable, spawnImpl = spawn }) {
  if (!isAbsolute(helperPath)) throw new Error("INVALID_NATIVE_HELPER_PATH");
  const child = spawnImpl(helperPath, [], { stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map();
  let closed = false;
  const failAll = () => {
    closed = true;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("NATIVE_ADAPTER_UNAVAILABLE"));
    }
    pending.clear();
  };
  child.on("error", failAll);
  child.on("exit", failAll);
  child.stdin.on("error", failAll);
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (line.length > 4096) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.kind === "activate" && typeof event.itemAlias === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(event.itemAlias) && Number.isSafeInteger(event.revision) && event.revision > 0) {
      Promise.resolve().then(() => onActivate(event.itemAlias, event.revision)).catch(() => showUnavailable?.()).catch(() => {});
      return;
    }
    if (event.kind !== "submitted" && event.kind !== "failed") return;
    const request = pending.get(event.identifier);
    if (!request) return;
    pending.delete(event.identifier);
    clearTimeout(request.timer);
    if (event.kind === "submitted") request.resolve();
    else request.reject(new Error("NATIVE_NOTIFICATION_UNAVAILABLE"));
  });
  return {
    notify({ identifier, itemAlias, revision }) {
      if (closed) return Promise.reject(new Error("NATIVE_ADAPTER_UNAVAILABLE"));
      if (typeof identifier !== "string" || typeof itemAlias !== "string" || !/^poppy-[a-f0-9]{32}$/.test(identifier) || !/^[A-Za-z0-9_-]{1,256}$/.test(itemAlias) || !Number.isSafeInteger(revision) || revision < 1) {
        return Promise.reject(new Error("INVALID_NOTIFICATION"));
      }
      if (pending.has(identifier)) return pending.get(identifier).promise;
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      const timer = setTimeout(() => {
        pending.delete(identifier);
        reject(new Error("NATIVE_NOTIFICATION_TIMEOUT"));
      }, 30_000);
      pending.set(identifier, { promise, resolve, reject, timer });
      child.stdin.write(JSON.stringify({ identifier, itemAlias, revision }) + "\n");
      return promise;
    },
    openTopic,
    showUnavailable,
    close() { lines.close(); child.kill(); failAll(); },
  };
}
