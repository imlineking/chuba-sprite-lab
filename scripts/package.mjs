import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareVendor } from "./prepare-vendor.mjs";
import { preparePortableModels } from "./prepare-portable-models.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const builder = path.join(appRoot, "node_modules", "electron-builder", "cli.js");
const localElectronDist = path.join(appRoot, "node_modules", "electron", "dist");

await prepareVendor(appRoot);
await preparePortableModels(appRoot);
await fs.access(path.join(appRoot, "assets", "app.ico"));
await fs.rm(path.join(appRoot, "dist"), { recursive: true, force: true });

const builderArgs = [builder, "--win", "portable", "--x64", "--publish", "never"];

// A prepared local Electron distribution avoids Windows cache rename errors on
// developer machines. Clean CI installations can use electron-builder's normal
// download path instead, so releases remain reproducible on GitHub Actions.
try {
  await fs.access(path.join(localElectronDist, "electron.exe"));
  builderArgs.push("--config.electronDist=node_modules/electron/dist");
} catch {
  // electron-builder will download the matching Electron release.
}

const result = spawnSync(process.execPath, builderArgs, {
  cwd: appRoot,
  stdio: "inherit",
  windowsHide: true,
});
if (result.status !== 0) throw new Error(`electron-builder завершился с кодом ${result.status ?? "unknown"}.`);

const portablePath = path.join(appRoot, "dist", "Chuba-Sprite-Lab-portable.exe");
await fs.access(portablePath);
console.log(`Single-file portable build created:\n${portablePath}`);
