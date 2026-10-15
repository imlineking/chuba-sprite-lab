import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { createHash, randomUUID } from "node:crypto";
import { writeJsonAtomic, safeAtlasName, quickOutputDir } from "./conveyor.mjs";

const inside = (file, dir) => { const rel = path.relative(path.resolve(dir), path.resolve(file)); return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel)); };
export function checkpointRoots(c) {
  return [...(c.source?.paths || []), ...(c.cleaned ? [c.cleaned.framesDir, c.cleaned.manifestPath, ...(c.cleaned.sheetPaths || [c.cleaned.sheetPath])] : []), ...(c.built ? [c.built.config.output] : []), ...(c.review?.kind === "png" ? [path.join(c.cleaned.outputDir, "png-review.json")] : [])].filter(Boolean);
}
function mapTree(value, transform) {
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value)) return value.map(v => mapTree(v, transform));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [transform(k), mapTree(v, transform)]));
  return value;
}
function lean(c) {
  return JSON.parse(JSON.stringify({ ...c, ...(c.built ? { built: { ...c.built, pages: c.built.pages.map(p => ({ ...p, ...(p.image ? { image: { ...p.image, rgba: undefined } } : {}) })) } } : {}) }));
}
export class CheckpointStore {
  constructor(directory) { this.directory = path.resolve(directory); }
  file(slot) { if (!/^[a-z0-9-]{1,120}$/i.test(slot)) throw new Error("Некорректный ключ задачи."); return path.join(this.directory, slot + ".json"); }
  async read(slot) {
    try {
      const { checkpointDigest, ...record } = JSON.parse(await fs.readFile(this.file(slot), "utf8"));
      if (record.version !== 1 || createHash("sha256").update(JSON.stringify(record)).digest("hex") !== checkpointDigest) return null;
      return record;
    } catch { return null; }
  }
  async write(slot, session) {
    const record = { ...session, version: 1, checkpoint: lean(session.checkpoint || {}) };
    const checkpointDigest = createHash("sha256").update(JSON.stringify(record)).digest("hex");
    await writeJsonAtomic(this.file(slot), { ...record, checkpointDigest });
  }
  async prune(ttlMs) {
    for (const entry of await fs.readdir(this.directory).catch(() => [])) {
      if (!/^[a-z0-9-]{1,120}\.json$/i.test(entry)) continue;
      const slot = entry.slice(0, -5), record = await this.read(slot);
      if (record && Date.now() - record.at > ttlMs) await this.remove(slot, record);
    }
  }
  async remove(slot, session) {
    await fs.rm(this.file(slot), { force: true });
    const assets = session?.assetsDir;
    // Only remove the UUID directory created by this store, never an input/output folder.
    if (assets && path.dirname(path.resolve(assets)) === this.directory && /^[\da-f-]{36}\.assets$/i.test(path.basename(assets))) await fs.rm(path.resolve(assets), { recursive: true, force: true });
  }
  async durable(session, checkpoint, signal) {
    const c = lean(checkpoint), replacements = new Map();
    session.assetsDir ||= path.join(this.directory, session.id + ".assets");
    for (const [i, file] of (c.source?.paths || []).entries()) {
      if (!inside(file, os.tmpdir()) || session.inputRoots.includes(file) || inside(file, this.directory)) continue;
      signal?.throwIfAborted();
      const target = path.join(session.assetsDir, `source-${i}${path.extname(file)}`);
      await fs.mkdir(session.assetsDir, { recursive: true });
      // An extracted source is immutable for this task. Reuse its durable copy.
      if (!(await fs.stat(target).catch(() => null))) await fs.copyFile(file, target);
      replacements.set(file, target); replacements.set(pathToFileURL(file).href, pathToFileURL(target).href);
    }
    if (c.source) c.source = mapTree(c.source, text => replacements.get(text) || text);
    return c;
  }
}

export async function hydrateCheckpoint(checkpoint) {
  if (!checkpoint?.built || checkpoint.review) return checkpoint;
  const c = { ...checkpoint, built: { ...checkpoint.built, pages: [] } };
  for (const page of checkpoint.built.pages) {
    const file = path.resolve(checkpoint.built.config.output, page.file);
    if (!inside(file, checkpoint.built.config.output)) throw new Error("Страница атласа вне папки результата.");
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    c.built.pages.push({ ...page, image: { width: info.width, height: info.height, rgba: data } });
  }
  return c;
}

export async function relocateCheckpoint(checkpoint, args, outputFiles, signal) {
  if (!checkpoint.cleaned) return checkpoint;
  const old = path.resolve(checkpoint.cleaned.outputDir);
  const name = safeAtlasName(args.name || path.parse(args.paths[0]).name);
  let target = path.resolve(args.outputDir || quickOutputDir(args.paths[0]), name);
  if (target === old) return checkpoint;
  if (await fs.stat(target).catch(() => null)) target += "-resume-" + randomUUID().slice(0, 8);
  const oldUrl = pathToFileURL(old).href, newUrl = pathToFileURL(target).href;
  const rewrite = text => {
    if (text === oldUrl || text.startsWith(oldUrl + "/")) return newUrl + text.slice(oldUrl.length);
    if (text === old || text.startsWith(old + path.sep)) return path.join(target, path.relative(old, text));
    return text;
  };
  for (const file of outputFiles.filter(f => inside(f, old))) {
    signal?.throwIfAborted();
    const dest = path.join(target, path.relative(old, file));
    if (!inside(dest, target)) throw new Error("Некорректный путь переноса результата.");
    await fs.mkdir(path.dirname(dest), { recursive: true });
    if (/\.json$/i.test(file)) {
      const json = await fs.readFile(file, "utf8").then(JSON.parse);
      await writeJsonAtomic(dest, mapTree(json, rewrite));
    } else await fs.copyFile(file, dest);
  }
  return mapTree(lean(checkpoint), rewrite);
}
