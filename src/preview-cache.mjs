import fs from "node:fs/promises";
import path from "node:path";

export async function prunePreviewCache(root, { references = [], now = Date.now(), maxAgeMs = 7 * 86400000 } = {}) {
  const resolved = path.resolve(root);
  const protectedDirs = new Set(references.filter(p => typeof p === "string").map(p => {
    const relative = path.relative(resolved, path.resolve(p));
    return !relative.startsWith("..") && !path.isAbsolute(relative) ? relative.split(path.sep)[0] : null;
  }).filter(Boolean));
  const removed = [];
  for (const entry of await fs.readdir(resolved, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith("preview-") || protectedDirs.has(entry.name)) continue;
    const directory = path.resolve(resolved, entry.name);
    if (path.dirname(directory) !== resolved) continue;
    const stats = await fs.stat(directory);
    if (now - stats.mtimeMs <= maxAgeMs) continue;
    await fs.rm(directory, { recursive: true, force: true }); removed.push(entry.name);
  }
  return removed;
}
