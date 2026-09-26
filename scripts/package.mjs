import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareVendor } from "./prepare-vendor.mjs";
import { preparePortableModels } from "./prepare-portable-models.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builder = path.join(appRoot, "node_modules", "electron-builder", "cli.js");
const localElectronDist = path.join(appRoot, "node_modules", "electron", "dist");

await prepareVendor(appRoot);
const models = await preparePortableModels(appRoot);
await fs.access(path.join(appRoot, "assets", "app.ico"));
async function checked(relative) {
  const target = path.resolve(appRoot, relative);
  const resolved = await fs.realpath(target).catch(() => target);
  if (!target.startsWith(appRoot + path.sep) || !resolved.startsWith(appRoot + path.sep)) throw new Error(`Путь вне проекта: ${target}`);
  return target;
}
await fs.rm(await checked(".build"), { recursive: true, force: true });

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

const staging = await checked(".build/win-unpacked");
await fs.access(path.join(staging, "Chuba Sprite Lab.exe"));
await fs.writeFile(path.join(staging, "START-HERE.txt"), `Chuba Sprite Lab 1.8.0\n\nЗапуск: Chuba Sprite Lab.exe\nКопируйте на флешку ВСЮ папку portable. Resources и DLL нужны приложению.\n\nВсе ${models.length} поддержанных моделей работают локально. Интернет нужен только для\nпроверки обновлений и внешних сайтов/онлайн-редакторов. Node.js и Python не нужны.\nВнутренние EXE (FFmpeg и компоненты Electron) не являются другими версиями программы.\n`);
await fs.mkdir(await checked(".build-archive"), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const archiveFolder = async (relative, label) => {
  const source = await checked(relative);
  try { await fs.access(source); } catch { return; }
  await fs.rename(source, await checked(`.build-archive/${stamp}-${label}`));
};
await archiveFolder("portable", "previous-portable");
await fs.rename(staging, await checked("portable"));
for (const relative of ["dist", "release"]) await archiveFolder(relative, `legacy-${relative}`);
console.log(`Offline portable folder created:\n${path.join(appRoot, "portable")}\nIncluded models: ${models.length}`);
