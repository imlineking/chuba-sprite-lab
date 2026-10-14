// Input type detection for the "Конвейер" window. The type is decided by the file
// content (magic bytes), the extension is only a tie-breaker and a source of warnings.
// Pure helpers (sniffBuffer, countIslands, classify) are exported for the tests; the
// async detectInput() reads only the file header and, for images, a downscaled alpha mask.
import fs from "node:fs/promises";
import path from "node:path";

const HEADER_BYTES = 64 * 1024;
const ascii = (buf, start, end) => buf.toString("latin1", start, end);

// Byte format of one file. Returns { format, animated?, container? }.
export function sniffBuffer(buf, { name = "" } = {}) {
  if (!buf || buf.length < 4) return { format: "unknown" };
  const b = buf;
  if (b[0] === 0x89 && ascii(b, 1, 4) === "PNG") return { format: "png", animated: pngHasActl(b) };
  if (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a") return { format: "gif", animated: gifFrameCount(b) > 1 };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { format: "jpeg" };
  if (ascii(b, 0, 4) === "RIFF" && b.length >= 12) {
    const kind = ascii(b, 8, 12);
    if (kind === "WEBP") return { format: "webp", animated: webpAnimated(b) };
    if (kind === "AVI ") return { format: "avi", container: "video" };
    if (kind === "WAVE") return { format: "wav" };
  }
  if (b[0] === 0x42 && b[1] === 0x4d && b.length > 26) return { format: "bmp" };
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a)) return { format: "tiff" };
  if (ascii(b, 0, 4) === "8BPS") return { format: "psd" };
  if (ascii(b, 0, 5) === "%PDF-") return { format: "pdf" };
  if (b.length >= 12 && ascii(b, 4, 8) === "ftyp") {
    const brands = [ascii(b, 8, 12), ...Array.from({ length: Math.max(0, Math.min(8, (b.readUInt32BE(0) - 16) / 4)) }, (_, i) => ascii(b, 16 + i * 4, 20 + i * 4))];
    if (brands.some((x) => x === "avif" || x === "avis")) return { format: "avif", animated: brands.includes("avis") };
    if (brands.some((x) => /^(heic|heix|hevc|mif1)$/.test(x))) return { format: "heic" };
    if (brands[0] === "qt  ") return { format: "mov", container: "video" };
    return { format: "mp4", container: "video" };
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    const head = ascii(b, 0, Math.min(b.length, 4096));
    return { format: head.includes("webm") ? "webm" : "mkv", container: "video" };
  }
  // Aseprite: u32 file size, then magic 0xA5E0 little-endian.
  if (b.length >= 6 && b.readUInt16LE(4) === 0xa5e0) return { format: "aseprite" };
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return { format: "zip" };
  const text = textHead(b);
  if (text !== null) {
    const trimmed = text.replace(/^\uFEFF/, "").trimStart();
    if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(trimmed)) return { format: "svg" };
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      if (/\.cslab$/i.test(name) || /"chuba-sprite-lab-project"/.test(trimmed)) return { format: "cslab" };
      return { format: "json", atlas: /"frames"\s*:/.test(trimmed) || /"textures"\s*:/.test(trimmed) };
    }
    return { format: "text" };
  }
  return { format: "unknown" };
}

function textHead(b) {
  const n = Math.min(b.length, 2048);
  for (let i = 0; i < n; i++) { const c = b[i]; if (c === 0 || (c < 9) || (c > 13 && c < 32 && c !== 27)) return null; }
  return b.toString("utf8", 0, n);
}

function pngHasActl(b) {
  let p = 8;
  while (p + 8 <= b.length) {
    const len = b.readUInt32BE(p), type = ascii(b, p + 4, p + 8);
    if (type === "acTL") return true;
    if (type === "IDAT" || type === "IEND") return false;
    p += len + 12;
  }
  return false;
}

function gifFrameCount(b) {
  // Count image descriptors (0x2C) after skipping the global colour table and blocks.
  let p = 13, frames = 0;
  if (b[10] & 0x80) p += 3 * (1 << ((b[10] & 7) + 1));
  while (p < b.length) {
    const id = b[p];
    if (id === 0x2c) {
      frames += 1; if (frames > 1) return frames;
      let q = p + 10; if (b[p + 9] & 0x80) q += 3 * (1 << ((b[p + 9] & 7) + 1));
      q += 1; // LZW min code size
      while (q < b.length && b[q] !== 0) q += b[q] + 1;
      p = q + 1;
    } else if (id === 0x21) {
      let q = p + 2; while (q < b.length && b[q] !== 0) q += b[q] + 1; p = q + 1;
    } else break;
  }
  return frames;
}

function webpAnimated(b) {
  if (ascii(b, 12, 16) !== "VP8X") return false;
  return Boolean(b[20] & 0x02);
}

// Connected islands in a binary mask (4-neighbourhood); used to tell a sprite sheet
// (many separate opaque objects on transparency) from a single picture.
export function countIslands(mask, width, height, { minArea = 2 } = {}) {
  const seen = new Uint8Array(width * height); let islands = 0; const stack = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let area = 0; stack.push(start); seen[start] = 1;
    while (stack.length) {
      const i = stack.pop(); area += 1; const x = i % width, y = (i - x) / width;
      for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1]) {
        if (j >= 0 && mask[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    if (area >= minArea) islands += 1;
  }
  return islands;
}

const extensionFormats = {
  ".png": "png", ".apng": "png", ".gif": "gif", ".jpg": "jpeg", ".jpeg": "jpeg", ".webp": "webp", ".bmp": "bmp",
  ".tif": "tiff", ".tiff": "tiff", ".avif": "avif", ".heic": "heic", ".psd": "psd", ".pdf": "pdf", ".svg": "svg",
  ".mp4": "mp4", ".m4v": "mp4", ".mov": "mov", ".webm": "webm", ".mkv": "mkv", ".avi": "avi",
  ".ase": "aseprite", ".aseprite": "aseprite", ".json": "json", ".cslab": "cslab",
};
const equivalent = { mp4: ["mp4", "mov"], mov: ["mp4", "mov"], webm: ["webm", "mkv"], mkv: ["webm", "mkv"], cslab: ["cslab", "json"], json: ["json", "cslab"] };
export function extensionMismatch(file, format) {
  const expected = extensionFormats[path.extname(file).toLowerCase()];
  if (!expected || format === "unknown") return null;
  if (expected === format || (equivalent[expected] || []).includes(format)) return null;
  return `Расширение «${path.extname(file)}» не совпадает с содержимым (${format}); файл открыт по содержимому.`;
}

export const rasterFormats = new Set(["png", "jpeg", "webp", "tiff", "avif"]);
export const videoFormats = new Set(["mp4", "mov", "webm", "mkv", "avi"]);

// Single-file classification from sniff results and optional image facts.
export function classifyFile(sniff, facts = {}, { name = "" } = {}) {
  const f = sniff.format;
  if (videoFormats.has(f)) return "video";
  if (f === "gif") return sniff.animated ? "animated-image" : "image";
  if ((f === "png" || f === "webp") && sniff.animated) return "animated-image";
  // Animated AVIF has no frame decoder in the app yet: it is handled as a still image.
  if (rasterFormats.has(f)) return facts.sheet || looksLikeSheetName(name) ? "sprite-sheet" : "image";
  if (f === "aseprite") return "aseprite";
  if (f === "json") return sniff.atlas ? "atlas-json" : "unknown";
  if (f === "cslab") return "project";
  if (f === "bmp") return "bmp";
  if (f === "pdf" || f === "svg" || f === "psd" || f === "heic") return f;
  return "unknown";
}

export function looksLikeSheetName(name) { return /(sprite[-_ ]?sheet|spritesheet|\.sheet|atlas|[-_]sheet\b|tileset)/i.test(path.basename(name)); }

// Multi-path classification. entries: [{ path, type, isDirectory, childTypes? }]
export function classifyMany(entries) {
  if (!entries.length) return "unknown";
  if (entries.length === 1) {
    const [e] = entries;
    if (!e.isDirectory) return e.type;
    const kids = e.childTypes || [];
    const frames = kids.filter((t) => t === "image" || t === "sprite-sheet");
    if (frames.length >= 1) return "frames-folder";
    return "empty-folder";
  }
  if (entries.some((e) => e.isDirectory)) return "mixed";
  const types = new Set(entries.map((e) => e.type));
  if ([...types].every((t) => t === "video")) return "video-batch";
  if ([...types].every((t) => t === "image" || t === "sprite-sheet")) return "image-set";
  return "mixed";
}

async function readHead(file) {
  const handle = await fs.open(file, "r");
  try { const buf = Buffer.alloc(HEADER_BYTES); const { bytesRead } = await handle.read(buf, 0, HEADER_BYTES, 0); return buf.subarray(0, bytesRead); }
  finally { await handle.close(); }
}

// Cheap sprite-sheet heuristic: a sibling atlas JSON, or a big image with alpha whose
// downscaled mask holds several separate objects.
export async function sheetFacts(file, sniff, { sharp = null } = {}) {
  const stem = path.parse(file).name;
  for (const candidate of [stem + ".json", stem.replace(/\.sheet(?:-\d+)?$/, "") + ".json"]) {
    try { if ((await fs.stat(path.join(path.dirname(file), candidate))).isFile()) return { sheet: true, reason: "рядом лежит JSON атласа" }; } catch { /* none */ }
  }
  if (!sharp || !rasterFormats.has(sniff.format)) return { sheet: false };
  try {
    const meta = await sharp(file).metadata();
    if (!meta.hasAlpha || Math.max(meta.width, meta.height) < 128) return { sheet: false, width: meta.width, height: meta.height };
    const side = 96;
    const { data, info } = await sharp(file).ensureAlpha().extractChannel(3).resize(side, side, { fit: "inside", kernel: "nearest" }).raw().toBuffer({ resolveWithObject: true });
    const mask = new Uint8Array(info.width * info.height);
    let opaque = 0;
    for (let i = 0; i < mask.length; i++) if (data[i] > 24) { mask[i] = 1; opaque += 1; }
    const islands = countIslands(mask, info.width, info.height, { minArea: 4 });
    const transparentShare = 1 - opaque / mask.length;
    return { sheet: islands >= 4 && transparentShare > 0.25, islands, width: meta.width, height: meta.height, reason: islands >= 4 ? `${islands} отдельных объектов на прозрачном фоне` : undefined };
  } catch { return { sheet: false }; }
}

export async function detectFile(file, { sharp = null } = {}) {
  const head = await readHead(file);
  const sniff = sniffBuffer(head, { name: file });
  if (sniff.format === "gif" && !sniff.animated && head.length === HEADER_BYTES) sniff.animated = gifFrameCount(await fs.readFile(file)) > 1;
  if (sniff.format === "png" && !sniff.animated && head.length === HEADER_BYTES) sniff.animated = pngHasActl(await fs.readFile(file));
  const facts = rasterFormats.has(sniff.format) && !sniff.animated ? await sheetFacts(file, sniff, { sharp }) : {};
  const type = classifyFile(sniff, facts, { name: file });
  return { path: file, format: sniff.format, animated: Boolean(sniff.animated), type, facts, warning: extensionMismatch(file, sniff.format) };
}

// Detect the type of whatever the user dropped. Folders are scanned one level deep.
export async function detectInput(paths, { sharp = null, maxFolderFiles = 4096 } = {}) {
  const list = (paths || []).map((p) => path.resolve(String(p)));
  if (!list.length) return { type: "unknown", paths: [], files: [], warnings: ["Ничего не выбрано."] };
  const entries = [], warnings = [];
  for (const item of list) {
    const stat = await fs.stat(item);
    if (stat.isDirectory()) {
      const names = (await fs.readdir(item, { withFileTypes: true })).filter((d) => d.isFile()).map((d) => d.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).slice(0, maxFolderFiles);
      const files = [];
      for (const name of names) {
        try { const f = await detectFile(path.join(item, name)); if (f.type !== "unknown") files.push(f); } catch { /* unreadable */ }
      }
      const frames = files.filter((f) => f.type === "image" || f.type === "sprite-sheet");
      entries.push({ path: item, isDirectory: true, childTypes: files.map((f) => f.type), frames });
      if (frames.length && frames.length !== files.length) warnings.push(`В папке есть файлы другого типа (${files.length - frames.length}); взяты только кадры.`);
    } else {
      const f = await detectFile(item, { sharp: list.length === 1 ? sharp : null });
      if (f.warning) warnings.push(f.warning);
      entries.push({ ...f, isDirectory: false });
    }
  }
  const type = classifyMany(entries);
  const files = entries.length === 1 && entries[0].isDirectory ? entries[0].frames.map((f) => f.path) : entries.filter((e) => !e.isDirectory).map((e) => e.path);
  const first = entries[0];
  return { type, paths: list, files, format: first.isDirectory ? "folder" : first.format, facts: first.facts || {}, warnings };
}
