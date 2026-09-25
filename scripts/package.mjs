import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareVendor } from "./prepare-vendor.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const builder = path.join(appRoot, "node_modules", "electron-builder", "cli.js");

await prepareVendor(appRoot);
await fs.access(path.join(appRoot, "assets", "app.ico"));
await fs.rm(path.join(appRoot, "dist"), { recursive: true, force: true });

const result = spawnSync(process.execPath, [builder, "--win", "portable", "--x64", "--publish", "never"], {
  cwd: appRoot,
  stdio: "inherit",
  windowsHide: true,
});
if (result.status !== 0) throw new Error(`electron-builder завершился с кодом ${result.status ?? "unknown"}.`);

const portablePath = path.join(appRoot, "dist", "Chuba-Sprite-Lab-portable.exe");
await fs.access(portablePath);
console.log(`Single-file portable build created:\n${portablePath}`);
