import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { getPath7za } from "app-builder-lib/out/toolsets/7zip.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const packageJson = JSON.parse(await fs.readFile(path.join(appRoot, "package.json"), "utf8"));
const portablePath = path.join(appRoot, "portable");
const releaseDir = path.join(appRoot, "release");
const releaseName = `Chuba-Sprite-Lab-${packageJson.version}-offline.7z`;
const releasePath = path.join(releaseDir, releaseName);

await fs.access(portablePath);
await fs.mkdir(releaseDir, { recursive: true });
for (const file of await fs.readdir(releaseDir)) if (file.startsWith(releaseName)) await fs.rm(path.join(releaseDir, file), { force: true });
// Split volumes keep each GitHub asset below its size limit. The portable folder
// itself remains the application; publishing creates archives, never a second EXE.
const result = spawnSync(await getPath7za(), ["a", "-t7z", "-mx=1", "-v1900m", "-bd", releasePath, "portable"], { cwd: appRoot, stdio: "inherit", windowsHide: true });
if (result.status !== 0) throw new Error(`Архивация завершилась с кодом ${result.status}.`);
for (const file of await fs.readdir(releaseDir)) {
  if (!file.startsWith(releaseName) || file.endsWith(".sha256")) continue;
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(path.join(releaseDir, file))) hash.update(chunk);
  await fs.writeFile(path.join(releaseDir, `${file}.sha256`), `${hash.digest("hex")}  ${file}\n`);
}
console.log(`Release ${packageJson.version} offline archives created:\n${releaseDir}`);
