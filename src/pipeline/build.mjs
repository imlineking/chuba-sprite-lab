import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { packMaxRects } from "./maxrects.mjs";
import { parseFrameName, groupAnimations, frameHash, deduplicate, tagsFor } from "./grouping.mjs";
import { removeBackground, trim, crop, sliceGrid, sliceAuto, blit, createImage, decodeBmp } from "./image-ops.mjs";
import { exportAtlas, formats as knownFormats } from "./exporters.mjs";

// One-call pipeline: import -> background -> slice -> trim -> group/tag -> dedupe ->
// pack -> compose pages -> export. Used by scripts/atlas.mjs (CLI, presets, watch).

export const defaults = Object.freeze({
  name: "atlas",
  input: ["./sprites"],
  output: "./atlas-out",
  recursive: true,
  formats: ["texturepacker-hash", "phaser-hash"],
  maxSize: 2048,
  padding: 2,
  extrude: 1,
  rotate: false,
  powerOfTwo: true,
  square: false,
  trim: true,
  alphaThreshold: 0,
  background: "none", // "none" | "auto" | { mode: "key"|"auto", color: "#ff00ff", tolerance: 16 }
  slice: null, // null | { mode: "grid", cols, rows | cellWidth, cellHeight, margin, spacing } | { mode: "auto", mergeDistance }
  pivot: { x: 0.5, y: 0.5 },
  fps: 12,
  deduplicate: true,
  tags: {},
});

export const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".bmp", ".gif", ".webp", ".tif", ".tiff", ".avif"]);

export function resolveConfig(raw = {}, baseDir = process.cwd()) {
  const config = { ...defaults, ...raw, pivot: { ...defaults.pivot, ...(raw.pivot || {}) } };
  config.input = [].concat(config.input).map((entry) => path.resolve(baseDir, entry));
  config.output = path.resolve(baseDir, config.output);
  config.formats = [].concat(config.formats);
  for (const format of config.formats) if (!knownFormats.includes(format)) throw new Error(`Unknown format "${format}". Known: ${knownFormats.join(", ")}`);
  for (const key of ["maxSize", "padding", "extrude"]) if (!Number.isInteger(config[key]) || config[key] < 0) throw new Error(`${key} must be a non-negative integer`);
  if (config.maxSize < 16) throw new Error("maxSize must be at least 16");
  if (config.rotate && config.formats.some((f) => f.startsWith("godot") || f.startsWith("unity"))) throw new Error("rotate is not supported by Godot/Unity exports; set rotate: false");
  if (!/^[\w.-]+$/.test(config.name)) throw new Error(`name "${config.name}" may only contain letters, digits, _ . -`);
  // An output folder equal to an input folder would feed the atlas back in as a frame.
  // An output folder nested inside an input folder is allowed and skipped by listImages.
  for (const input of config.input) {
    if (path.relative(input, config.output) === "") throw new Error(`output "${config.output}" must not be the input folder itself; use a separate folder (it may be a subfolder, which is skipped)`);
  }
  return config;
}

const samePath = (a, b) => (process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

/** Image files under the inputs. `output` (a folder) is never descended into. */
export async function listImages(inputs, { recursive = true, output = null } = {}) {
  const files = [];
  const excluded = [].concat(output || []);
  async function walk(entry, folderTag) {
    if (excluded.some((dir) => samePath(dir, entry))) return;
    const stats = await fs.stat(entry).catch(() => null);
    if (!stats) throw new Error(`Input not found: ${entry}`);
    if (stats.isFile()) { if (imageExtensions.has(path.extname(entry).toLowerCase())) files.push({ file: entry, folderTag }); return; }
    const children = (await fs.readdir(entry, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (child.name.startsWith(".") || child.name === "not used") continue;
      const full = path.join(entry, child.name);
      if (child.isDirectory()) { if (recursive && !excluded.some((dir) => samePath(dir, full))) await walk(full, child.name); }
      else if (imageExtensions.has(path.extname(child.name).toLowerCase())) files.push({ file: full, folderTag });
    }
  }
  for (const input of inputs) await walk(input, null);
  return files;
}

/** Decodes a file to RGBA frames. GIF/WebP animations yield one frame per page. */
export async function decodeImage(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".bmp") return [{ ...decodeBmp(await fs.readFile(file)), delay: null }];
  const animated = ext === ".gif" || ext === ".webp";
  const image = sharp(file, { animated, limitInputPixels: 268402689 });
  const metadata = await image.metadata();
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pages = animated ? metadata.pages || 1 : 1;
  const pageHeight = animated && pages > 1 ? metadata.pageHeight : info.height;
  const frameBytes = info.width * pageHeight * 4;
  return Array.from({ length: pages }, (_, page) => ({ width: info.width, height: pageHeight, rgba: Buffer.from(data.subarray(page * frameBytes, (page + 1) * frameBytes)), delay: metadata.delay?.[page] ?? null }));
}

function frameNamesFor(base, count) {
  const digits = String(count - 1).length < 2 ? 2 : String(count - 1).length;
  return Array.from({ length: count }, (_, i) => (count === 1 ? base : `${base}_${String(i).padStart(digits, "0")}`));
}

export async function collectFrames(config, files) {
  const frames = [];
  for (const { file, folderTag } of files) {
    const base = path.basename(file).replace(/\.[^.]+$/, "");
    let decoded;
    try { decoded = await decodeImage(file); } catch (error) { throw new Error(`Cannot read ${file}: ${error.message}`); }
    let images = decoded;
    if (config.background && config.background !== "none") {
      const options = typeof config.background === "object" ? config.background : { mode: "auto" };
      images = images.map((image) => ({ ...removeBackground(image, options).image, delay: image.delay }));
    }
    if (config.slice) {
      images = images.flatMap((image) => {
        const cells = config.slice.mode === "auto" ? sliceAuto(image, config.slice) : sliceGrid(image, config.slice);
        return cells.map((cell) => crop(image, cell.x, cell.y, cell.width, cell.height));
      });
    }
    const names = frameNamesFor(base, images.length);
    images.forEach((image, i) => {
      const name = folderTag && config.prefixFolder ? `${folderTag}/${names[i]}` : names[i];
      const parsed = parseFrameName(names[i]);
      const trimmed = config.trim ? trim(image, config.alphaThreshold) : { image, offset: { x: 0, y: 0 } };
      const frame = {
        name, file, folderTag, animation: parsed.animation, index: parsed.index,
        width: trimmed.image.width, height: trimmed.image.height, rgba: trimmed.image.rgba,
        offset: trimmed.offset, sourceSize: { w: image.width, h: image.height },
        trimmed: trimmed.image.width !== image.width || trimmed.image.height !== image.height,
      };
      frame.hash = frameHash(frame);
      frame.tags = tagsFor(frame, config.tags);
      frames.push(frame);
    });
  }
  const seen = new Set();
  for (const frame of frames) {
    if (seen.has(frame.name)) throw new Error(`Duplicate frame name "${frame.name}" (from ${frame.file}); rename the file or enable prefixFolder`);
    seen.add(frame.name);
  }
  return frames;
}

export function planPages(config, uniqueFrames) {
  const border = config.extrude * 2 + config.padding;
  const items = uniqueFrames.map((frame) => ({ id: frame.name, w: frame.width + border, h: frame.height + border }));
  return packMaxRects(items, { maxSize: config.maxSize, rotate: config.rotate, powerOfTwo: config.powerOfTwo, square: config.square });
}

/** Runs the whole pipeline in memory. Returns { atlas, pages: [{ image }], files: [{ file, text }] }. */
export async function buildAtlas(rawConfig, { baseDir = process.cwd(), write = true } = {}) {
  const config = resolveConfig(rawConfig, baseDir);
  const files = await listImages(config.input, config);
  if (!files.length) throw new Error(`No images found in ${config.input.join(", ")}`);
  const frames = await collectFrames(config, files);
  const { unique, aliasOf } = config.deduplicate ? deduplicate(frames) : { unique: frames, aliasOf: new Map() };
  const plan = planPages(config, unique);
  const byName = new Map(unique.map((frame) => [frame.name, frame]));
  const half = config.extrude + Math.floor(config.padding / 2);
  const pages = plan.pages.map((page, index) => ({ file: plan.pages.length === 1 ? `${config.name}.png` : `${config.name}-${index}.png`, width: page.width, height: page.height, image: createImage(page.width, page.height) }));
  const placed = new Map();
  plan.pages.forEach((page, pageIndex) => {
    for (const rect of page.rects) {
      const frame = byName.get(rect.id);
      const x = rect.x + half, y = rect.y + half;
      blit(pages[pageIndex].image, frame, x, y, { extrude: config.extrude, rotated: rect.rotated });
      placed.set(frame.name, { page: pageIndex, x, y, rotated: rect.rotated });
    }
  });
  const atlasFrames = frames.map((frame) => {
    const target = placed.get(aliasOf.get(frame.name) ?? frame.name);
    return {
      name: frame.name, page: target.page, x: target.x, y: target.y, w: frame.width, h: frame.height, rotated: target.rotated,
      trimmed: frame.trimmed, spriteSourceSize: { x: frame.offset.x, y: frame.offset.y, w: frame.width, h: frame.height }, sourceSize: frame.sourceSize,
      pivot: { ...config.pivot }, animation: frame.animation, index: frame.index, tags: frame.tags, duplicateOf: aliasOf.get(frame.name) ?? null,
    };
  });
  const animations = Object.fromEntries(Object.entries(groupAnimations(atlasFrames)).map(([name, list]) => [name, list.map((frame) => frame.name)]));
  const atlas = { name: config.name, app: "Chuba Sprite Lab", version: "1", fps: config.fps, pages: pages.map(({ file, width, height }) => ({ file, width, height })), frames: atlasFrames, animations };
  const outputs = config.formats.flatMap((format) => exportAtlas(atlas, format));
  const stats = { sources: files.length, frames: frames.length, unique: unique.length, duplicates: frames.length - unique.length, pages: pages.length, fill: Math.round((unique.reduce((s, f) => s + f.width * f.height, 0) / pages.reduce((s, p) => s + p.width * p.height, 0)) * 1000) / 10 };
  let removedStale = [];
  if (write) {
    await fs.mkdir(config.output, { recursive: true });
    const written = [];
    for (const page of pages) {
      const png = await sharp(page.image.rgba, { raw: { width: page.width, height: page.height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
      await writeAtomic(path.join(config.output, page.file), png); written.push(page.file);
    }
    for (const output of outputs) {
      const target = path.join(config.output, output.file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await writeAtomic(target, output.text); written.push(output.file);
    }
    removedStale = await removeStalePages(config.output, config.name, written);
  }
  return { config, atlas, pages, outputs, stats, removedStale };
}

/** Writes through a temp file and a rename so a hot-reloading engine never reads half a file. */
export async function writeAtomic(target, data) {
  const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await fs.writeFile(temp, data);
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Removes page files left from an earlier build with more (or fewer) pages: `<name>-<n><suffix>`
 * and `<name><suffix>` where the suffix is one this build wrote for its own pages
 * (".png", ".json", ".png.meta", ...). Files of other names are never touched.
 */
export async function removeStalePages(dir, name, written) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pageName = new RegExp(`^${escaped}(?:-\\d+)?(\\..+)$`);
  const keep = new Set(written);
  const suffixes = new Set(written.map((file) => pageName.exec(file)?.[1]).filter(Boolean));
  const removed = [];
  let entries = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return removed; }
  for (const entry of entries) {
    if (!entry.isFile() || keep.has(entry.name)) continue;
    const match = pageName.exec(entry.name);
    if (!match || !suffixes.has(match[1])) continue;
    // Only page-shaped names: "<name>-<n>.<ext>" or "<name>.<ext>" with a page suffix.
    await fs.rm(path.join(dir, entry.name), { force: true });
    removed.push(entry.name);
  }
  return removed;
}
