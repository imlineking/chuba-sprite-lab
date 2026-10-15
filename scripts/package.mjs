import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareVendor } from "./prepare-vendor.mjs";
import { preparePortableModels } from "./prepare-portable-models.mjs";
import { prepareHealingRuntime } from "./prepare-healing-runtime.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builder = path.join(appRoot, "node_modules", "electron-builder", "cli.js");
const localElectronDist = path.join(appRoot, "node_modules", "electron", "dist");
const packageInfo = JSON.parse(await fs.readFile(path.join(appRoot, "package.json"), "utf8"));

function assertNoRunningBuild() {
  if (process.platform !== "win32") return;
  const probe = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; foreach ($item in @(Get-Process | Where-Object ProcessName -eq 'Chuba Sprite Lab')) { if (-not $item.Path) { throw 'Executable path unavailable' }; $item.Path }"], { encoding: "utf8", windowsHide: true, timeout: 30000 });
  if (probe.status !== 0) throw new Error("Не удалось проверить запущенные экземпляры. Закройте приложение перед пересборкой.");
  const prefix = (appRoot + path.sep).toLowerCase();
  if (probe.stdout.split(/\r?\n/).some((entry) => entry.trim().toLowerCase().startsWith(prefix))) throw new Error("Закройте Chuba Sprite Lab из папки проекта перед заменой portable-комплекта.");
}

assertNoRunningBuild();

await prepareVendor(appRoot);
await prepareHealingRuntime(appRoot);
const models = await preparePortableModels(appRoot);
await fs.access(path.join(appRoot, "assets", "app.ico"));
async function checked(relative) {
  const target = path.resolve(appRoot, relative);
  const resolved = await fs.realpath(target).catch(() => target);
  if (!target.startsWith(appRoot + path.sep) || !resolved.startsWith(appRoot + path.sep)) throw new Error(`Путь вне проекта: ${target}`);
  return target;
}
await fs.rm(await checked(".build"), { recursive: true, force: true });

// Build a directory only as an intermediate. The existing single-file launcher
// then embeds it with fast compression and reuses its verified extraction cache.
const builderArgs = [builder, "--win", "--x64", "--dir", "--publish", "never"];

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

const artifact = await checked(".build/Chuba-Sprite-Lab-portable.exe");
const packedApp = await checked(".build/win-unpacked");
const singleFile = spawnSync(process.execPath, [path.join(appRoot, "scripts", "build-single-exe.mjs"), artifact, packedApp], { cwd: appRoot, stdio: "inherit", windowsHide: true });
if (singleFile.status !== 0) throw new Error(`Однофайловая упаковка завершилась с кодом ${singleFile.status ?? "unknown"}.`);
await fs.access(artifact);
const staging = await checked(".build/portable-container");
await fs.mkdir(staging);
await fs.rename(artifact, path.join(staging, "Chuba Sprite Lab.exe"));
assertNoRunningBuild();
await fs.mkdir(await checked(".build-archive"), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
async function renameWithRetry(source, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try { await fs.rename(source, destination); return; }
    catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 5) throw error;
      // Defender/indexing can briefly hold a freshly built Electron binary open.
      await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 500));
    }
  }
}
const archiveFolder = async (relative, label) => {
  const source = await checked(relative);
  try { await fs.access(source); } catch { return; }
  await renameWithRetry(source, await checked(`.build-archive/${stamp}-${label}`));
};
await archiveFolder("portable", "previous-portable");
await renameWithRetry(staging, await checked("portable"));
for (const relative of ["dist", "release"]) await archiveFolder(relative, `legacy-${relative}`);
const modelFiles = packageInfo.build.extraResources.find(entry => entry.to === "models").filter;
console.log(`Offline single-file portable ${packageInfo.version} created:\n${path.join(appRoot, "portable", "Chuba Sprite Lab.exe")}\nIncluded models: ${models.filter(entry => modelFiles.includes(entry.file)).length}`);
