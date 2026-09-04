import { app, BrowserWindow, safeStorage } from "electron";

import {
  exportManagedComposioCredential,
  parseManagedComposioExportArguments,
} from "./managed-composio-export.mjs";

// safeStorage's macOS key name is derived from the app name. Match the
// packaged desktop so this one-purpose helper can reuse its OS-protected
// credential without returning it through stdout, argv, IPC, or the model.
app.setName("openmausbot");

const options = parseManagedComposioExportArguments(process.argv.slice(2));

app.whenReady().then(async () => {
  // On macOS Chromium binds its Keychain service name while constructing the
  // browser process. A never-shown window establishes the same app-name
  // identity as the desktop without exposing the export in renderer IPC.
  const identityWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await exportManagedComposioCredential({
    ...options,
    decrypt: (buffer) => safeStorage.decryptStringAsync(buffer),
    storageAvailable: async () => {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;
      return process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text";
    },
  });
  identityWindow.destroy();
  process.stdout.write("managed connected-apps credential exported to a protected file\n");
  app.exit(0);
}).catch((error) => {
  process.stderr.write(`managed connected-apps credential export failed: ${error?.message ?? error}\n`);
  app.exit(1);
});
