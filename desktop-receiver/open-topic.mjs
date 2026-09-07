import { spawn } from "node:child_process";

/** OS dispatch contains no canonical topic identity, credentials, or text.
 * The installed desktop app independently resolves the alias before opening. */
export function createTopicOpener({ platform = process.platform, spawnImpl = spawn } = {}) {
  const executable = platform === "darwin" ? "/usr/bin/open" : platform === "linux" ? "/usr/bin/xdg-open" : null;
  if (!executable) throw new Error("UNSUPPORTED_DESKTOP_PLATFORM");
  return async function openTopic(item) {
    if (typeof item?.id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(item.id) ||
        !Number.isSafeInteger(item.revision) || item.revision < 1) throw new Error("POPPY_ITEM_UNAVAILABLE");
    const url = `openmausbot://poppy?item=${encodeURIComponent(item.id)}&revision=${item.revision}`;
    await new Promise((resolve, reject) => {
      const child = spawnImpl(executable, [url], { stdio: "ignore", timeout: 10_000 });
      child.once("error", () => reject(new Error("POPPY_APP_UNAVAILABLE")));
      child.once("exit", code => code === 0 ? resolve() : reject(new Error("POPPY_APP_UNAVAILABLE")));
    });
  };
}
