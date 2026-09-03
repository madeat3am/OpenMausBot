import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const electron = require("electron");
const [expected, ...archives] = process.argv.slice(2);

if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(expected ?? "") || archives.length === 0) {
  throw new Error("usage: verify-packaged-revision <full-git-revision> <app.asar> [...]");
}

for (const archive of archives) {
  const packageJson = resolve(archive, "package.json");
  const revision = execFileSync(
    electron,
    ["-e", "process.stdout.write(require(process.argv[1]).buildRevision || '')", packageJson],
    {
      encoding: "utf8",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    },
  );
  if (revision !== expected) {
    throw new Error(`${archive} has buildRevision ${JSON.stringify(revision)}, expected ${expected}`);
  }
}

console.log(`packaged revision verified: ${expected} (${archives.length} archive(s))`);
