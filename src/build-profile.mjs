import fs from "node:fs/promises";
import path from "node:path";
import { pixelDithers, pixelModes, pixelPalettes } from "./pixelate.mjs";

// A build profile is the complete recipe of one export: the sources plus every
// processing option. The command line and the desktop window accept the same options,
// so running an unchanged profile twice has to produce the same atlas. Unknown keys
// are rejected instead of ignored, because a typo such as "keymode" would otherwise
// silently fall back to the default and produce a plausible but wrong result.
//
// Every path in a profile is resolved against the folder that holds the profile, not
// against the current working directory, so a recipe stays valid when it is run from
// somewhere else.

export const profileFormat = "chuba-sprite-lab-profile";
export const profileVersion = 1;

export const profileOptionKeys = new Set([
  "fps", "columns", "cellWidth", "cellHeight", "padding", "maxFrames", "tolerance",
  "blackOutline", "blackFeather", "trimStart", "trimEnd", "keyMode", "anchor",
  "autoSize", "autoColumns", "pixelPerfect", "removeDuplicates", "outputBackground",
  "excludedFrames", "exports", "aiCutoff", "aiSoftness", "aiEdits", "previewFrameIndex",
  "fringeCleanup", "fringeStrength", "edgeDecontaminate", "keyColor", "aiProvider", "aiQuality", "aiForceModel", "pixelate", "frameParallelism", "attachments", "attachmentPlacements",
  "frameOverrides", "frameTransforms", "fitEachFrame", "timeline", "loopMode",
  "loopRange", "packing", "exportFormat", "atlasMaxSize", "atlasOverflow",
  "cleanOutput", "animationName", "auxAI",
]);

const sourceKinds = ["video", "frames", "sheet"];
const enumValues = {
  keyMode: ["auto", "alpha", "ai", "white", "black", "green", "blue", "custom"],
  aiProvider: ["auto", "cpu", "dml"],
  aiQuality: ["fast", "balanced", "max"],
  anchor: ["ground", "center", "motion", "body"],
  exportFormat: ["chuba", "phaser3", "godot", "texturepacker", "unity"],
  packing: ["grid", "tight"],
  atlasOverflow: ["warn", "scale", "columns", "split"],
  outputBackground: ["transparent", "white"],
  loopMode: ["loop", "pingpong", "range"],
};
const exportParts = ["sheet", "frames", "metadata", "preview"];
const sheetModes = ["objects", "grid", "manual"];

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedInteger(value, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : null;
}

function normalizeOptions(value, problem, label, baseDir) {
  if (!isPlainObject(value)) {
    problem(`${label}: ожидался объект с настройками.`);
    return {};
  }
  const options = {};
  for (const [key, item] of Object.entries(value)) {
    if (!profileOptionKeys.has(key)) problem(`${label}.${key}: неизвестная настройка.`);
    else options[key] = item;
  }
  for (const [key, allowed] of Object.entries(enumValues)) {
    if (options[key] === undefined) continue;
    if (!allowed.includes(options[key])) problem(`${label}.${key}: ожидается одно из ${allowed.join(", ")}.`);
  }
  if (options.exports !== undefined) {
    if (!isPlainObject(options.exports)) {
      problem(`${label}.exports: ожидался объект с sheet/frames/metadata/preview.`);
    } else {
      for (const [key, item] of Object.entries(options.exports)) {
        if (!exportParts.includes(key)) problem(`${label}.exports.${key}: неизвестный формат.`);
        else if (typeof item !== "boolean") problem(`${label}.exports.${key}: ожидалось true или false.`);
      }
      if (exportParts.every((part) => options.exports[part] === false)) {
        problem(`${label}.exports: выберите хотя бы один формат (${exportParts.join(", ")}).`);
      }
    }
  }
  if (options.pixelate !== undefined && options.pixelate !== null) {
    if (!isPlainObject(options.pixelate)) {
      problem(`${label}.pixelate: ожидался объект с настройками пиксель-арта.`);
    } else {
      const known = ["size", "colors", "palette", "mode", "dither", "shadingSteps", "softAlpha", "edgeThreshold", "ditherStrength", "inkColor"];
      for (const key of Object.keys(options.pixelate)) {
        if (!known.includes(key)) problem(`${label}.pixelate.${key}: неизвестная настройка.`);
      }
      const size = Number(options.pixelate.size);
      if (!Number.isInteger(size) || size < 2 || size > 64) problem(`${label}.pixelate.size: ожидалось целое 2…64.`);
      const colors = Number(options.pixelate.colors);
      if (options.pixelate.colors !== undefined && (!Number.isInteger(colors) || colors < 2 || colors > 256)) {
        problem(`${label}.pixelate.colors: ожидалось целое 2…256.`);
      }
      const palette = options.pixelate.palette ?? "auto";
      if (palette !== "auto" && !Object.keys(pixelPalettes).includes(palette)) {
        problem(`${label}.pixelate.palette: ожидается auto или одна из ${Object.keys(pixelPalettes).join(", ")}.`);
      }
      if (options.pixelate.mode !== undefined && !pixelModes.includes(options.pixelate.mode)) {
        problem(`${label}.pixelate.mode: ожидается одна из ${pixelModes.join(", ")}.`);
      }
      if (options.pixelate.dither !== undefined && !pixelDithers.includes(options.pixelate.dither)) {
        problem(`${label}.pixelate.dither: ожидается одна из ${pixelDithers.join(", ")}.`);
      }
    }
  }
  if (options.auxAI !== undefined) {
    if (!isPlainObject(options.auxAI)) problem(`${label}.auxAI: ожидался объект.`);
    else {
      for (const [key, item] of Object.entries(options.auxAI)) {
        if (["interpolate", "upscale", "depth"].includes(key)) {
          if (typeof item !== "boolean") problem(`${label}.auxAI.${key}: ожидалось true или false.`);
        } else if (key === "inpaintMaskPath") {
          if (item !== null && (typeof item !== "string" || !item.trim())) problem(`${label}.auxAI.inpaintMaskPath: ожидался путь к PNG-маске.`);
          else if (item) options.auxAI.inpaintMaskPath = path.resolve(baseDir, item);
        } else problem(`${label}.auxAI.${key}: неизвестная настройка.`);
      }
    }
  }
  if (options.aiCutoff !== undefined && options.aiCutoff !== "auto") {
    const cutoff = Number(options.aiCutoff);
    if (!Number.isFinite(cutoff) || cutoff < 1 || cutoff > 99) problem(`${label}.aiCutoff: ожидалось число 1…99 или "auto".`);
  }
  if (options.keyColor !== undefined) {
    const color = Array.isArray(options.keyColor) ? options.keyColor : null;
    const usable = color && color.length >= 3
      && color.slice(0, 3).every((value) => Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 255);
    if (!usable) problem(`${label}.keyColor: ожидался массив из трёх чисел 0…255.`);
    else options.keyColor = color.slice(0, 3).map(Number);
  }
  // The custom mode has no meaning without its colour, and silently falling back to a
  // sampled border colour would produce a plausible but different result.
  if (options.keyMode === "custom" && !Array.isArray(options.keyColor)) {
    problem(`${label}.keyColor: для режима custom нужен свой цвет фона.`);
  }
  if (options.frameOverrides !== undefined) {
    if (!isPlainObject(options.frameOverrides)) {
      problem(`${label}.frameOverrides: ожидался объект вида { "3": "правка.png" }.`);
    } else {
      options.frameOverrides = Object.fromEntries(Object.entries(options.frameOverrides).map(([key, item]) => {
        if (typeof item !== "string" || !item.trim()) {
          problem(`${label}.frameOverrides.${key}: ожидался путь к файлу.`);
          return [key, item];
        }
        return [key, path.resolve(baseDir, item)];
      }));
    }
  }
  if (options.attachments !== undefined) {
    if (!Array.isArray(options.attachments)) {
      problem(`${label}.attachments: ожидался список.`);
    } else {
      options.attachments = options.attachments.map((attachment, index) => {
        if (!isPlainObject(attachment)) {
          problem(`${label}.attachments[${index}]: ожидался объект.`);
          return attachment;
        }
        if (attachment.path === undefined) return attachment;
        if (typeof attachment.path !== "string" || !attachment.path.trim()) {
          problem(`${label}.attachments[${index}].path: ожидался путь к PNG.`);
          return attachment;
        }
        return { ...attachment, path: path.resolve(baseDir, attachment.path) };
      });
    }
  }
  return options;
}

function normalizeSheetOptions(value, problem, label) {
  if (value === undefined) return { mode: "objects" };
  if (!isPlainObject(value)) {
    problem(`${label}.sheetOptions: ожидался объект.`);
    return { mode: "objects" };
  }
  const mode = sheetModes.includes(value.mode) ? value.mode : "objects";
  if (value.mode !== undefined && !sheetModes.includes(value.mode)) {
    problem(`${label}.sheetOptions.mode: ожидается одно из ${sheetModes.join(", ")}.`);
  }
  const options = { mode };
  if (mode === "grid") {
    options.columns = boundedInteger(value.columns, 1, 64) ?? 4;
    options.rows = boundedInteger(value.rows, 1, 64) ?? 4;
  }
  if (mode === "manual") {
    const cells = Array.isArray(value.cells) ? value.cells : [];
    if (!cells.length) problem(`${label}.sheetOptions.cells: для режима manual нужен непустой список рамок.`);
    else options.cells = cells.map((cell) => ({ left: Number(cell?.left), top: Number(cell?.top), width: Number(cell?.width), height: Number(cell?.height) }));
  }
  return options;
}

function normalizeSource(value, baseDir, label, problem) {
  if (!isPlainObject(value)) {
    problem(`${label}: ожидался объект с kind и paths.`);
    return null;
  }
  const kind = String(value.kind || "");
  if (!sourceKinds.includes(kind)) problem(`${label}.kind: ожидается одно из ${sourceKinds.join(", ")}.`);
  const rawPaths = Array.isArray(value.paths) ? value.paths : [];
  if (!rawPaths.length) problem(`${label}.paths: нужен непустой список файлов.`);
  if (rawPaths.some((item) => typeof item !== "string" || !item.trim())) problem(`${label}.paths: все пути должны быть непустыми строками.`);
  const paths = rawPaths.filter((item) => typeof item === "string" && item.trim()).map((item) => path.resolve(baseDir, item));
  if (!paths.length || !sourceKinds.includes(kind)) return null;
  const source = {
    kind,
    paths,
    title: typeof value.title === "string" && value.title.trim() ? value.title.trim() : path.basename(paths[0]),
  };
  if (kind === "sheet") {
    source.sheetPath = typeof value.sheetPath === "string" && value.sheetPath.trim() ? path.resolve(baseDir, value.sheetPath) : paths[0];
    source.paths = [source.sheetPath];
    source.sheetOptions = normalizeSheetOptions(value.sheetOptions, problem, label);
  }
  return source;
}

export function readProfile(raw, { baseDir = process.cwd() } = {}) {
  if (!isPlainObject(raw)) throw new Error("Профиль сборки отклонён:\n· ожидался объект JSON.");
  const problems = [];
  const problem = (message) => problems.push(message);

  if (raw.format !== profileFormat) problem(`format: ожидается "${profileFormat}".`);
  if (Number(raw.version) !== profileVersion) problem(`version: поддерживается только ${profileVersion}.`);
  if (raw.options === undefined) problem("options: секция обязательна.");

  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "";
  if (!name) problem("name: укажите имя набора.");
  const outputDir = typeof raw.outputDir === "string" && raw.outputDir.trim() ? path.resolve(baseDir, raw.outputDir) : "";

  const options = normalizeOptions(raw.options ?? {}, problem, "options", baseDir);
  const animations = [];
  if (raw.animations !== undefined) {
    if (!Array.isArray(raw.animations) || !raw.animations.length) {
      problem("animations: нужен непустой список анимаций.");
    } else {
      raw.animations.forEach((entry, index) => {
        const label = `animations[${index}]`;
        if (!isPlainObject(entry)) { problem(`${label}: ожидался объект.`); return; }
        const animationName = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : "";
        if (!animationName) problem(`${label}.name: укажите имя анимации.`);
        const source = normalizeSource(entry.source, baseDir, `${label}.source`, problem);
        const entryOptions = entry.options === undefined ? {} : normalizeOptions(entry.options, problem, `${label}.options`, baseDir);
        if (source && animationName) animations.push({ name: animationName, source, options: { ...options, ...entryOptions } });
      });
    }
  } else {
    const source = normalizeSource(raw.source, baseDir, "source", problem);
    if (source && name) animations.push({ name: String(options.animationName || name), source, options });
  }

  // A batch of videos becomes one set per file, so it cannot be combined with other
  // animations inside a single atlas.
  const batches = animations.filter((animation) => animation.source.kind === "video" && animation.source.paths.length > 1);
  if (batches.length && animations.length > 1) {
    problem("source.paths: пакет из нескольких видео поддерживается только как единственный источник профиля.");
  }

  if (problems.length) throw new Error(`Профиль сборки отклонён:\n· ${problems.join("\n· ")}`);
  return { name, outputDir, options, animations };
}

export async function loadProfileFile(filePath) {
  const absolute = path.resolve(filePath);
  let text;
  try {
    text = await fs.readFile(absolute, "utf8");
  } catch {
    throw new Error(`Не удалось прочитать профиль: ${absolute}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`Профиль не является корректным JSON: ${error.message}`);
  }
  return { path: absolute, profile: readProfile(raw, { baseDir: path.dirname(absolute) }) };
}
