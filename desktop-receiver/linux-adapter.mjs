import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const GENERIC_TEXT = "Poppy needs your review.";
const ITEM_ALIAS_RE = /^[A-Za-z0-9_-]{1,256}$/;
const IDENTIFIER_RE = /^poppy-[a-f0-9]{32}$/;
const DEFAULT_HELPER_PATH = fileURLToPath(new URL("./linux/helper.py", import.meta.url));

export function createLinuxAdapter({
  openTopic,
  showUnavailable,
  helperPath = DEFAULT_HELPER_PATH,
  pythonPath = "/usr/bin/python3",
  submissionTimeoutMs = 10_000,
  platform = process.platform,
  spawnImpl = spawn,
}) {
  if (platform !== "linux") throw new Error("LINUX_ADAPTER_UNAVAILABLE");
  if (!isAbsolute(helperPath)) throw new Error("INVALID_LINUX_HELPER_PATH");
  if (!isAbsolute(pythonPath)) throw new Error("INVALID_PYTHON_PATH");
  if (!Number.isInteger(submissionTimeoutMs) || submissionTimeoutMs < 1_000 || submissionTimeoutMs > 60_000) throw new Error("INVALID_SUBMISSION_TIMEOUT");
  if (typeof openTopic !== "function" || typeof showUnavailable !== "function") throw new Error("INVALID_LINUX_ADAPTER_CALLBACK");

  const children = new Set();

  return {
    notify({ identifier, title, body, itemAlias, revision }) {
      if (!IDENTIFIER_RE.test(identifier) || title !== GENERIC_TEXT || body !== GENERIC_TEXT ||
          !ITEM_ALIAS_RE.test(itemAlias) || !Number.isSafeInteger(revision) || revision < 1) {
        return Promise.reject(new Error("INVALID_NOTIFICATION"));
      }

      let child;
      try {
        child = spawnImpl(pythonPath, [helperPath], {
          shell: false,
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
        });
      } catch {
        return Promise.reject(new Error("NATIVE_ADAPTER_UNAVAILABLE"));
      }
      children.add(child);

      let settled = false;
      let resolveSubmitted;
      let rejectSubmitted;
      const result = new Promise((resolve, reject) => {
        resolveSubmitted = resolve;
        rejectSubmitted = reject;
      });
      let submissionTimer;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(submissionTimer);
        if (error) rejectSubmitted(error);
        else resolveSubmitted();
      };
      const lines = createInterface({ input: child.stdout });
      submissionTimer = setTimeout(() => {
        finish(new Error("NATIVE_NOTIFICATION_TIMEOUT"));
        child.kill();
      }, submissionTimeoutMs);

      lines.on("line", (line) => {
        if (line.length > 256) return;
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event?.kind === "submitted" && event.identifier === identifier) finish();
        else if (event?.kind === "failed") finish(new Error("NATIVE_NOTIFICATION_UNAVAILABLE"));
      });
      child.once("error", () => finish(new Error("NATIVE_ADAPTER_UNAVAILABLE")));
      child.once("exit", (code) => {
        children.delete(child);
        lines.close();
        if (!settled) finish(new Error(code === 0 ? "NATIVE_NOTIFICATION_UNAVAILABLE" : "NATIVE_ADAPTER_UNAVAILABLE"));
      });
      child.stdin.once("error", () => finish(new Error("NATIVE_ADAPTER_UNAVAILABLE")));
      child.stdin.end(JSON.stringify({ identifier, itemAlias, revision, title: GENERIC_TEXT, body: GENERIC_TEXT }) + "\n");
      return result;
    },
    openTopic,
    showUnavailable,
    close() {
      for (const child of children) child.kill();
      children.clear();
    },
  };
}
