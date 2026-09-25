import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

async function findFile(directory, fileName, depth = 5) {
  if (depth < 0) return null;
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return path.join(directory, entry.name);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findFile(path.join(directory, entry.name), fileName, depth - 1);
    if (found) return found;
  }
  return null;
}

async function resolveOnPath(name) {
  const candidates = [];
  if (process.platform === "win32" && process.env.ChocolateyInstall) {
    const chocolateyPackage = await findFile(path.join(process.env.ChocolateyInstall, "lib"), `${name}.exe`, 8);
    if (chocolateyPackage) candidates.push(chocolateyPackage);
  }

  const result = spawnSync(process.platform === "win32" ? "where.exe" : "which", [name], { encoding: "utf8", windowsHide: true });
  if (result.status === 0) candidates.push(...result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));

  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const wingetPackages = path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Packages");
    const found = await findFile(wingetPackages, `${name}.exe`);
    if (found) candidates.push(found);
  }

  // Chocolatey's PATH entry is commonly a tiny redirector that stops working
  // after being copied. Prefer the actual static binary for a portable build.
  for (const candidate of [...new Set(candidates)]) {
    try {
      const info = await fs.stat(candidate);
      if (process.platform !== "win32" || info.size > 1024 * 1024) return candidate;
    } catch {
      // Try the next installation candidate.
    }
  }
  throw new Error(`${name} не найден как автономный исполняемый файл.`);
}

export async function prepareVendor(appRoot) {
  const vendorDir = path.join(appRoot, "vendor");
  const executable = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  await fs.mkdir(vendorDir, { recursive: true });
  await fs.copyFile(await resolveOnPath("ffmpeg"), path.join(vendorDir, executable));
  await fs.rm(path.join(vendorDir, "ffprobe.exe"), { force: true });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  await prepareVendor(appRoot);
  console.log(`FFmpeg prepared in ${path.join(appRoot, "vendor")}`);
}
