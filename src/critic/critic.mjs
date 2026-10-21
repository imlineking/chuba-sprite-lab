import path from "node:path";
import sharp from "sharp";
import { runChecks, algorithmicVerdict } from "./checks.mjs";
import { defaults as buildDefaults } from "../pipeline/build.mjs";
import { artifactFingerprint, algorithmRevisionFingerprint } from './review-data.mjs';

// Acceptance checks are deterministic; no language model, server or GPU is used.
const verdictRank = { accepted: 0, needs_fix: 1, rejected: 2 };

/** Atlas page preview with frame rectangles (blue) and pivots (red) drawn on top. */
export async function renderPreview(result, { maxSide = 768 } = {}) {
  const page = result.pages[0]?.image;
  if (!page) return null;
  const scale = Math.min(1, maxSide / Math.max(page.width, page.height));
  const W = Math.max(1, Math.round(page.width * scale)), H = Math.max(1, Math.round(page.height * scale));
  const rects = result.atlas.frames.filter((f) => f.page === 0 && !f.duplicateOf).map((f) => {
    const x = f.x * scale, y = f.y * scale, w = (f.rotated ? f.h : f.w) * scale, h = (f.rotated ? f.w : f.h) * scale;
    const px = (f.x + (f.pivot.x * f.sourceSize.w - f.spriteSourceSize.x)) * scale, py = (f.y + (f.pivot.y * f.sourceSize.h - f.spriteSourceSize.y)) * scale;
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#2563eb" stroke-width="1"/><circle cx="${px}" cy="${py}" r="2" fill="#dc2626"/>`;
  }).join("");
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${rects}</svg>`);
  const checker = await sharp({ create: { width: W, height: H, channels: 4, background: "#bbbbbb" } }).png().toBuffer();
  const base = await sharp(page.rgba, { raw: { width: page.width, height: page.height, channels: 4 } }).resize(W, H, { kernel: "nearest" }).png().toBuffer();
  return sharp(checker).composite([{ input: base }, { input: svg }]).png().toBuffer();
}

/** Always recompute checks from the actual atlas; no cached verdict bypass. */
export async function reviewAtlas(result, { buildError = null } = {}) {
  const started = performance.now();
  const checks = runChecks(result, { buildError });
  return { mode: "light", ...algorithmicVerdict(checks.issues), issues: checks.issues, metrics: checks.metrics,
    artifactId: artifactFingerprint(result), criticRevision: await algorithmRevisionFingerprint(),
    elapsedMs: Math.round(performance.now() - started), fallbackReason: buildError ? "Сборка не удалась" : null };
}

// Keys a suggested fix may change. Everything else (output, input, name, formats, paths,
// rotate, ...) is dropped: a suggested fix must never redirect where files are read or written.
export const fixableKeys = Object.freeze(["pivot", "padding", "extrude", "trim", "background", "slice", "deduplicate", "fps", "maxSize"]);
const advisoryKeys = new Set(["sortBy", "anchor", "order"]); // handled by the UI
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const hexColor = /^#[0-9a-f]{6}$/i;
const fixValidators = {
  pivot: (v) => v && typeof v === "object" && Object.keys(v).every((k) => (k === "x" || k === "y") && typeof v[k] === "number" && v[k] >= 0 && v[k] <= 1),
  padding: (v) => isInt(v, 0, 64),
  extrude: (v) => isInt(v, 0, 32),
  trim: (v) => typeof v === "boolean",
  deduplicate: (v) => typeof v === "boolean",
  fps: (v) => isInt(v, 1, 120),
  maxSize: (v) => isInt(v, 16, 8192),
  background: (v) => v === "none" || (v && typeof v === "object" && ["auto", "key"].includes(v.mode ?? "auto")
    && Object.keys(v).every((k) => ["mode", "color", "tolerance"].includes(k)) && (v.color === undefined || hexColor.test(v.color)) && (v.tolerance === undefined || isInt(v.tolerance, 0, 255))),
  slice: (v) => v === null || (v && typeof v === "object" && ((v.mode === "auto" && Object.keys(v).every((k) => ["mode", "mergeDistance"].includes(k)) && (v.mergeDistance === undefined || isInt(v.mergeDistance, 0, 256)))
    || (v.mode === "grid" && Object.entries(v).every(([k, n]) => k === "mode" || (["cols", "rows", "cellWidth", "cellHeight", "margin", "spacing"].includes(k) && isInt(n, 0, 8192)))))),
};

/** Splits a fix into allowed, validated keys and rejected ones. */
export function sanitizeFix(fix) {
  const allowed = {}, rejected = [];
  if (!fix || typeof fix !== "object" || Array.isArray(fix)) return { allowed, rejected };
  for (const [key, value] of Object.entries(fix)) {
    if (advisoryKeys.has(key)) continue;
    if (fixableKeys.includes(key) && fixValidators[key](value)) allowed[key] = value; else rejected.push(key);
  }
  return { allowed, rejected };
}

/** Applies a suggested fix (whitelisted pipeline parameters only) to a build config. */
export function applyFix(config, fix) {
  const next = { ...config };
  const { allowed } = sanitizeFix(fix);
  for (const [key, value] of Object.entries(allowed)) {
    next[key] = value && typeof value === "object" && !Array.isArray(value) && config[key] && typeof config[key] === "object" ? { ...config[key], ...value } : value;
  }
  return next;
}

const configKeys = new Set([...Object.keys(buildDefaults), "prefixFolder", "frameMetadata", "animationMetadata", "animationLoop"]);
const absolute = (value) => typeof value === "string" && value.length < 1024 && !value.includes("\0") && path.isAbsolute(value);

/**
 * Validates a build config that arrives over IPC (critic:review / critic:apply-fix) from the
 * renderer: known keys only, absolute input/output paths, output not a drive root and not the
 * same as or inside an input folder. Returns a clean copy; throws on anything else.
 */
export function validateCriticConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Конфигурация приёмки должна быть объектом.");
  const unknown = Object.keys(config).filter((key) => !configKeys.has(key));
  if (unknown.length) throw new Error(`Недопустимые ключи конфигурации: ${unknown.join(", ")}`);
  const input = [].concat(config.input ?? []);
  if (!input.length || input.length > 64 || !input.every(absolute)) throw new Error("input: нужен список абсолютных путей.");
  if (!absolute(config.output)) throw new Error("output: нужен абсолютный путь.");
  const output = path.resolve(config.output);
  if (path.parse(output).root === output) throw new Error("output не может быть корнем диска.");
  for (const entry of input.map((p) => path.resolve(p))) {
    const rel = path.relative(entry, output);
    if (rel === "" ) throw new Error("output не может совпадать с папкой кадров.");
  }
  if (config.name !== undefined && (typeof config.name !== "string" || !/^[\w.-]{1,128}$/.test(config.name))) throw new Error("name: только буквы, цифры, _ . -");
  if (config.formats !== undefined && (!Array.isArray(config.formats) || !config.formats.every((f) => typeof f === "string"))) throw new Error("formats: нужен список строк.");
  for (const key of ["frameMetadata", "animationMetadata"]) if (config[key] != null && (typeof config[key] !== "object" || Array.isArray(config[key]) || Object.keys(config[key]).length > 4096)) throw new Error(`${key}: нужен объект метаданных до 4096 элементов.`);
  if (config.animationLoop != null && (!Number.isInteger(config.animationLoop) || config.animationLoop < 0 || config.animationLoop > 65535)) throw new Error("animationLoop: целое число от 0 до 65535.");
  for (const frame of Object.values(config.frameMetadata || {})) {
    if (!frame || typeof frame !== "object") throw new Error("Повреждены метаданные кадра.");
    if (frame.name != null && (typeof frame.name !== "string" || !frame.name || frame.name.length > 256 || path.isAbsolute(frame.name) || frame.name.split(/[\\/]/).includes(".."))) throw new Error("Имя кадра не может выходить за папку результата.");
  }
  return { ...config, input, output };
}

export function verdictLabel(verdict) { return { accepted: "Принято", needs_fix: "Нужны правки", rejected: "Отклонено" }[verdict] || verdict; }
export { verdictRank };
