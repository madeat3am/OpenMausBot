import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

if (process.platform !== "darwin" || process.argv.length !== 3) {
  throw new Error("Usage on macOS: node macos/build.mjs /absolute/output/PoppyReceiver.app");
}
const output = resolve(process.argv[2]);
if (!output.endsWith(".app")) throw new Error("Output must be an app bundle");
const source = dirname(fileURLToPath(import.meta.url));
await mkdir(`${output}/Contents/MacOS`, { recursive: true });
await writeFile(`${output}/Contents/Info.plist`, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.openmausbot.poppy-receiver</string>
<key>CFBundleName</key><string>Poppy</string>
<key>CFBundleDisplayName</key><string>Poppy</string>
<key>CFBundleExecutable</key><string>PoppyReceiver</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
<key>LSMinimumSystemVersion</key><string>13.0</string>
</dict></plist>
`);
execFileSync("xcrun", ["swiftc", "-O", "-framework", "AppKit", "-framework", "UserNotifications", `${source}/main.swift`, "-o", `${output}/Contents/MacOS/PoppyReceiver`], { stdio: "inherit" });
execFileSync("codesign", ["--force", "--sign", "-", output], { stdio: "inherit" });
console.log(output);
