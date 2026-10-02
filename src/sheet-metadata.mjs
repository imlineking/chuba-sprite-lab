// Frame rectangles read from a sprite-sheet manifest that sits next to the image.
// Three shapes exist in the wild: Chuba's own array of frames carrying "name",
// Aseprite's array carrying "filename", and object-style manifests such as
// TexturePacker that key every frame by its file name.

export function frameNameWithoutExtension(value) {
  const base = String(value ?? "").split(/[\\/]/).pop() || "";
  return base.replace(/\.(png|webp|jpe?g|avif|tiff?|gif)$/i, "");
}

import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

export function readSheetFrameRects(manifest) {
  const frames = manifest?.frames;
  const raw = Array.isArray(frames)
    ? frames.map((entry) => ({ name: entry?.name ?? entry?.filename ?? "", entry }))
    : Object.entries(frames || {}).map(([name, entry]) => ({ name, entry }));
  return raw.map(({ name, entry }) => {
    const rect = entry?.frame || entry || {};
    return {
      name: frameNameWithoutExtension(name),
      x: Number(rect.x),
      y: Number(rect.y),
      width: Number(rect.w ?? rect.width ?? manifest?.frameWidth),
      height: Number(rect.h ?? rect.height ?? manifest?.frameHeight),
    };
  }).filter((entry) => [entry.x, entry.y, entry.width, entry.height].every(Number.isFinite));
}

const frameKeys = new Set(["frame", "name", "filename", "index", "page", "image", "x", "y", "width", "height", "rotated", "trimmed", "sourceSize", "spriteSourceSize", "duration", "durationMs", "pivot", "animation", "sourceFrameIndex", "sourceName", "sourceRect", "hitbox", "hitboxSpace", "transform", "anchorPoints"]);
const rootKeys = new Set(["frames", "meta", "textures", "pages", "image", "name", "frameWidth", "frameHeight", "columns", "rows", "fps", "frameDurationMs", "frameCount", "anchor", "pivot", "animations", "loop", "packing", "formatVersion", "transparent", "powerOfTwo", "scale", "extrude", "gap", "rotation", "bodyAlignment"]);
export function normalizeSheetManifest(manifest, defaultImage) {
  if (!manifest || typeof manifest !== "object") throw new Error("JSON атласа пуст или повреждён.");
  const textures = manifest.textures;
  const pages = textures ? textures.map(t => ({ image: t.image, width: t.size?.w, height: t.size?.h })) : manifest.pages || [{ image: manifest.meta?.image || manifest.image || defaultImage, width: manifest.meta?.size?.w, height: manifest.meta?.size?.h }];
  const groups = textures ? textures.map((t, page) => ({ frames: t.frames, page })) : [{ frames: manifest.frames, page: null }];
  const frames = groups.flatMap(group => (Array.isArray(group.frames) ? group.frames.map((entry, i) => [entry.name || entry.filename || `frame_${i}`, entry]) : Object.entries(group.frames || {})).map(([name, entry]) => {
    const r = entry.frame || entry;
    const width = Number(r.w ?? r.width), height = Number(r.h ?? r.height), rotated = entry.rotated === true;
    const sourceSize = entry.sourceSize || { w: rotated ? height : width, h: rotated ? width : height };
    const box = entry.spriteSourceSize || { x: 0, y: 0, w: rotated ? height : width, h: rotated ? width : height };
    return { name: frameNameWithoutExtension(name), page: group.page ?? Number(entry.page || 0), x: Number(r.x), y: Number(r.y), width, height, rotated, sourceSize, spriteSourceSize: box, trimmed: entry.trimmed === true, durationMs: Number(entry.durationMs ?? entry.duration ?? manifest.frameDurationMs ?? 100), pivot: entry.pivot || manifest.pivot || { x: .5, y: .5 }, tag: entry.animation || null, anchorPoints: entry.anchorPoints || [], extra: Object.fromEntries(Object.entries(entry).filter(([key]) => !frameKeys.has(key))) };
  }));
  if (!frames.length || frames.length > 4096 || pages.length > 256) throw new Error("JSON должен содержать от 1 до 4096 кадров и не больше 256 страниц.");
  const tags = manifest.animations || manifest.meta?.frameTags || [];
  for (const [i, frame] of frames.entries()) if (!frame.tag) frame.tag = tags.find(t => Number(t.from) <= i && i <= Number(t.to))?.name || null;
  const names = new Set();
  for (const f of frames) {
    if (names.has(f.name)) throw new Error(`Повтор имени кадра: ${f.name}.`); names.add(f.name);
    if (![f.x, f.y, f.width, f.height, f.page, f.sourceSize.w, f.sourceSize.h, f.spriteSourceSize.x, f.spriteSourceSize.y, f.spriteSourceSize.w, f.spriteSourceSize.h].every(Number.isInteger) || f.x < 0 || f.y < 0 || f.width < 1 || f.height < 1 || f.sourceSize.w < 1 || f.sourceSize.h < 1 || f.sourceSize.w * f.sourceSize.h > 16777216 || !pages[f.page]) throw new Error(`Кадр ${f.name}: неверная геометрия или страница.`);
    const b = f.spriteSourceSize;
    if (b.x < 0 || b.y < 0 || b.x + b.w > f.sourceSize.w || b.y + b.h > f.sourceSize.h || b.w !== (f.rotated ? f.height : f.width) || b.h !== (f.rotated ? f.width : f.height)) throw new Error(`Кадр ${f.name}: trim не согласован с sourceSize и rotated.`);
    if (!(f.durationMs > 0) || ![f.pivot.x, f.pivot.y].every(n => Number.isFinite(n) && n >= 0 && n <= 1)) throw new Error(`Кадр ${f.name}: неверная длительность или опора.`);
  }
  for (let i = 0; i < frames.length; i++) for (const b of frames.slice(i + 1)) {
    const a = frames[i];
    if (a.page === b.page && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height && !(a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height)) throw new Error(`Пересечение кадров ${a.name} и ${b.name}.`);
  }
  const extra = Object.fromEntries(Object.entries(manifest).filter(([key]) => !rootKeys.has(key)));
  const metaExtra = Object.fromEntries(Object.entries(manifest.meta || {}).filter(([key]) => !["image", "size", "scale", "format", "app", "version", "frameTags", "note"].includes(key)));
  if (Object.keys(metaExtra).length) extra.meta = metaExtra;
  return { pages, frames, animations: manifest.animations || manifest.meta?.frameTags || [], extra, warnings: Object.keys(extra).length || frames.some(f => Object.keys(f.extra).length) ? ["Пользовательские поля JSON сохраняются; другие игровые профили могут их не понимать."] : [] };
}

export async function importSheetManifest(jsonPath, outputDir, defaultImage) {
  const raw = JSON.parse(await fs.readFile(jsonPath, "utf8"));
  const normalized = normalizeSheetManifest(raw, defaultImage);
  const base = path.dirname(jsonPath);
  const pagePaths = normalized.pages.map(page => {
    const file = path.resolve(base, String(page.image || defaultImage));
    const relative = path.relative(base, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Страница атласа должна находиться рядом с JSON.");
    return file;
  });
  const sizes = await Promise.all(pagePaths.map(file => sharp(file).metadata()));
  await fs.mkdir(outputDir, { recursive: true });
  const framePaths = [];
  for (const [i, frame] of normalized.frames.entries()) {
    const size = sizes[frame.page];
    if (frame.x + frame.width > size.width || frame.y + frame.height > size.height) throw new Error(`Кадр ${frame.name} выходит за PNG.`);
    let sprite = await sharp(pagePaths[frame.page]).extract({ left: frame.x, top: frame.y, width: frame.width, height: frame.height }).png().toBuffer();
    if (frame.rotated) sprite = await sharp(sprite).rotate(270).png().toBuffer();
    const file = path.join(outputDir, `${String(i).padStart(4, "0")}.png`);
    await sharp({ create: { width: frame.sourceSize.w, height: frame.sourceSize.h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: sprite, left: frame.spriteSourceSize.x, top: frame.spriteSourceSize.y }]).png().toFile(file);
    framePaths.push(file);
  }
  return { ...normalized, framePaths, pagePaths, metadataPath: jsonPath };
}

// Give every detected cell the name of the frame rectangle that contains its centre.
export function matchSheetFrameNames(cells, rects) {
  return (cells || []).map((cell) => {
    const centerX = cell.left + cell.width / 2;
    const centerY = cell.top + cell.height / 2;
    const match = (rects || []).find((entry) => centerX >= entry.x && centerX < entry.x + entry.width && centerY >= entry.y && centerY < entry.y + entry.height);
    return match?.name || null;
  });
}
