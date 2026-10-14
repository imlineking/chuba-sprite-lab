import crypto from "node:crypto";
import path from "node:path";

// "walk_01", "walk-2", "walk 3", "walk.04", "walk05" -> { animation: "walk", index: n }.
const numbered = /^(.*?)[\s_.-]*(\d+)$/;

export function parseFrameName(fileName) {
  const base = path.basename(String(fileName)).replace(/\.[^.]+$/, "");
  const match = numbered.exec(base);
  if (match && match[1]) return { base, animation: match[1].replace(/[\s_.-]+$/, ""), index: Number(match[2]) };
  return { base, animation: base, index: 0 };
}

/** Groups frames ({ name }) into animations by file name, keeping numeric order. */
export function groupAnimations(frames) {
  const groups = new Map();
  for (const frame of frames) {
    const key = frame.animation ?? parseFrameName(frame.name).animation;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(frame);
  }
  for (const list of groups.values()) list.sort((a, b) => (a.index ?? 0) - (b.index ?? 0) || a.name.localeCompare(b.name));
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** Stable content hash of a trimmed RGBA frame. Identical pixels -> identical hash. */
export function frameHash({ width, height, rgba }) {
  return crypto.createHash("sha1").update(`${width}x${height}:`).update(rgba).digest("hex");
}

/** Returns { unique: [frame], aliasOf: Map<name, canonicalName> }. */
export function deduplicate(frames) {
  const seen = new Map();
  const unique = [];
  const aliasOf = new Map();
  for (const frame of frames) {
    const hash = frame.hash ?? frameHash(frame);
    const first = seen.get(hash);
    if (first) aliasOf.set(frame.name, first.name);
    else { seen.set(hash, frame); unique.push(frame); }
  }
  return { unique, aliasOf };
}

/** Tags from preset rules: { "walk": ["player", "loop"], "*": ["all"] } plus the source folder name. */
export function tagsFor(frame, rules = {}) {
  const tags = new Set(frame.folderTag ? [frame.folderTag] : []);
  for (const [pattern, values] of Object.entries(rules)) {
    const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
    if (regex.test(frame.animation) || regex.test(frame.name)) for (const value of [].concat(values)) tags.add(String(value));
  }
  return [...tags].sort();
}
