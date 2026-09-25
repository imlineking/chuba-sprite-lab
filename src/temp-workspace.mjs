import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

const owned = new Set();

// A finished workspace stays readable until enough newer ones replace it. Quick
// previews and sheet imports keep separate pools on purpose: a burst of previews
// must never evict the frames that a sheet import is still being built from.
function createRetirePool(limit) {
  const entries = [];
  return async function retire(directory) {
    const resolved = path.resolve(directory);
    const existing = entries.indexOf(resolved);
    if (existing !== -1) entries.splice(existing, 1);
    entries.push(resolved);
    while (entries.length > limit) {
      const oldest = entries.shift();
      owned.delete(oldest);
      await fs.rm(oldest, { recursive: true, force: true }).catch(() => {});
    }
  };
}

export const finishQuickPreview = createRetirePool(6);
// The active sheet import is always the most recent entry, so it is evicted last.
export const finishSheetImport = createRetirePool(2);

export async function makeTempWorkspace(prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  owned.add(path.resolve(directory));
  return directory;
}

export async function discardTempWorkspace(directory) {
  if (!directory) return;
  owned.delete(path.resolve(directory));
  await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
}

// A prior crash cannot run the exit hook. Only remove our exact temporary names.
export async function pruneStaleTempWorkspaces(maxAgeMs = 24 * 60 * 60 * 1000) {
  const root = path.resolve(os.tmpdir());
  const prefixes = ["chuba-sprite-source-", "chuba-sprite-live-", "chuba-sprite-lab-", "chuba-sprite-sheet-"];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !prefixes.some((prefix) => entry.name.startsWith(prefix))) continue;
    const directory = path.resolve(root, entry.name);
    if (path.dirname(directory) !== root || owned.has(directory)) continue;
    const stat = await fs.stat(directory).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > maxAgeMs) {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }
}

process.once("exit", () => {
  for (const directory of owned) {
    try {
      if (path.dirname(directory) === path.resolve(os.tmpdir())) fsSync.rmSync(directory, { recursive: true, force: true });
    } catch { /* Exiting must not fail because a temporary image is locked. */ }
  }
});
