import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { isAbsolute } from "node:path";

export function createMacAdapter({ helperPath, onActivate, openTopic, showUnavailable, onFatal, notificationTimeoutMs = 30_000, spawnImpl = spawn }) {
  if (!isAbsolute(helperPath)) throw new Error("INVALID_NATIVE_HELPER_PATH");
  const child = spawnImpl(helperPath, [], { stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map();
  let closed = false;
  let lines;
  const rejectPending = () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("NATIVE_ADAPTER_UNAVAILABLE"));
    }
    pending.clear();
  };
  const failAll = () => {
    if (closed) return;
    closed = true;
    rejectPending();
    lines?.close();
    // A stopped helper cannot handle SIGTERM. Release this owned process even
    // then, so launchd can observe the receiver exit and recover delivery.
    try { child.kill("SIGKILL"); } catch { /* The helper may already have exited. */ }
    try { onFatal?.(); } catch { /* The supervisor must not revive a dead helper. */ }
  };
  child.on("error", failAll);
  child.on("exit", failAll);
  child.stdin.on("error", failAll);
  lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (closed) return;
    if (line.length > 4096) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.kind === "activate" && typeof event.itemAlias === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(event.itemAlias) && Number.isSafeInteger(event.revision) && event.revision > 0) {
      Promise.resolve().then(() => { if (!closed) return onActivate(event.itemAlias, event.revision); })
        .catch(() => { if (!closed) return showUnavailable?.(); }).catch(() => {});
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
        if (!pending.has(identifier)) return;
        pending.delete(identifier);
        reject(new Error("NATIVE_NOTIFICATION_TIMEOUT"));
        failAll();
      }, notificationTimeoutMs);
      pending.set(identifier, { promise, resolve, reject, timer });
      try {
        child.stdin.write(JSON.stringify({ identifier, itemAlias, revision }) + "\n");
      } catch {
        failAll();
      }
      return promise;
    },
    openTopic,
    showUnavailable,
    close() {
      if (closed) return;
      closed = true;
      lines.close();
      rejectPending();
      try { child.kill("SIGKILL"); } catch { /* The helper is already gone. */ }
    },
  };
}
