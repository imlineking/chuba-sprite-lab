import fs from "node:fs/promises";

// Identifies the bytes currently on disk for a set of files: size plus modification
// time. Polling is used instead of fs.watch on purpose, because the sources often sit
// on network or removable drives where change notifications are unreliable.
export async function fingerprint(paths) {
  const parts = [];
  for (const filePath of paths) {
    const stats = await fs.stat(filePath).catch(() => null);
    parts.push(stats ? `${filePath}|${stats.size}|${Math.round(stats.mtimeMs)}` : `${filePath}|missing`);
  }
  return parts.join("\n");
}

function delay(milliseconds) {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

// Calls onChange once per detected change. The caller aborts through the signal; the
// worst case latency is one polling interval.
export async function watchSources(paths, { intervalMs = 1200, signal, onChange } = {}) {
  let previous = await fingerprint(paths);
  while (!signal?.aborted) {
    await delay(intervalMs);
    if (signal?.aborted) break;
    const current = await fingerprint(paths);
    if (current === previous) continue;
    previous = current;
    await onChange?.(current);
  }
}
