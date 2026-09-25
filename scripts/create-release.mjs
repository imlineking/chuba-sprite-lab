import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const packageJson = JSON.parse(await fs.readFile(path.join(appRoot, "package.json"), "utf8"));
const portablePath = path.join(appRoot, "dist", "Chuba-Sprite-Lab-portable.exe");
const releaseDir = path.join(appRoot, "release");
let releaseName = "Chuba-Sprite-Lab-portable.exe";
let releasePath = path.join(releaseDir, releaseName);

await fs.access(portablePath);
await fs.mkdir(releaseDir, { recursive: true });
try {
  await fs.rm(releasePath, { force: true });
  await fs.rm(`${releasePath}.sha256`, { force: true });
} catch (error) {
  if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
  releaseName = `Chuba-Sprite-Lab-portable-${packageJson.version}.exe`;
  releasePath = path.join(releaseDir, releaseName);
  await fs.rm(releasePath, { force: true });
  await fs.rm(`${releasePath}.sha256`, { force: true });
  console.warn(`Previous portable EXE is running; creating ${releaseName} alongside it.`);
}
await fs.copyFile(portablePath, releasePath);

const digest = crypto.createHash("sha256").update(await fs.readFile(releasePath)).digest("hex");
await fs.writeFile(`${releasePath}.sha256`, `${digest}  ${releaseName}\n`, "utf8");
console.log(`Release ${packageJson.version} assets created:\n${releasePath}\n${releasePath}.sha256`);
