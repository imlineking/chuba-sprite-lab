// Show the desktop copilot before importing Sharp, ONNX and processing modules.
import { app, BrowserWindow, screen, ipcMain, dialog } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopCompanion } from "./desktop-companion.mjs";
import { startupShell } from "./startup-shell.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] || "" : ""; };
const selfTest = process.argv.includes("--self-test") || process.env.CHUBA_SPRITE_SELF_TEST === "1";
const screenshot = arg("--screenshot") || process.env.CHUBA_SPRITE_SCREENSHOT;
const desktopProbe = arg("--desktop-probe");
const diagnostic = selfTest || screenshot || desktopProbe || process.argv.includes("--ui-regression") || process.env.CHUBA_SPRITE_STARTUP_PROBE;
if (diagnostic && arg("--self-test-user-data")) {
  const profile = path.resolve(arg("--self-test-user-data"));
  fs.mkdirSync(profile, { recursive: true }); app.setPath("userData", profile);
}
startupShell.instanceLock = Boolean(diagnostic) || app.requestSingleInstanceLock();
if (!startupShell.instanceLock) app.quit();
else {
  // Do not await app readiness at ESM top level: Electron must finish loading the entry first.
  app.whenReady().then(async () => {
    if (!selfTest && (!screenshot || desktopProbe)) {
      const companion = new DesktopCompanion({ app, BrowserWindow, screen, ipcMain, appRoot: root, mainWindow: () => null });
      startupShell.companion = companion;
      await companion.create();
      startupShell.shownAt = Date.now();
      startupShell.loadingText = await companion.bubble.webContents.executeJavaScript("document.querySelector('#message').textContent");
    }
    await import("./main.mjs");
  }).catch((error) => {
    if (startupShell.companion) {
      startupShell.companion.update({ loading: false, greeting: "Не удалось загрузить программу.", error: error.message });
      startupShell.companion.show(false);
    }
    dialog.showErrorBox("Chuba Sprite Lab", `Не удалось загрузить программу: ${error.message}`);
    startupShell.companion?.destroy(); app.exit(1);
  });
}
