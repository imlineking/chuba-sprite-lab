import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { familyInputSize, modelById, modelFamilies, readSessionShapes } from "./ai-models.mjs";

const BUNDLED_MODEL = "u2netp.onnx";
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
// A tile about this size keeps the subject large inside the model input, whatever size that is.
const TILE_TARGET = 640;
const MAX_TILES_PER_AXIS = 4;
const TILE_OVERLAP = 0.25;
let loadedSession = null;
let loadedModelPath = null;
let loadedProvider = null;
let loadedMode = null;
let loadedInputSize = null;
// The session is shared, and running it concurrently is explicitly unsupported on DirectML.
// Only the inference itself is serialised: decoding, resizing and mask post-processing stay free
// to overlap with it.
let runQueue = Promise.resolve();

export const aiProviders = ["auto", "cpu", "dml"];
export const aiQualityModes = ["fast", "balanced", "max"];

export function withSessionLock(task) {
  const result = runQueue.then(task, task);
  runQueue = result.then(() => undefined, () => undefined);
  return result;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

async function exists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

// Every extra model is looked up by its own file name. The bundled one stays the fallback, so a
// missing download degrades to the shipped model instead of stopping the build.
export async function resolveAIModel(appRoot, { file = BUNDLED_MODEL, extraDirs = [] } = {}) {
  const candidates = [
    ...extraDirs.map((directory) => path.join(directory, file)),
    process.resourcesPath ? path.join(process.resourcesPath, "models", file) : null,
    path.join(appRoot, "models", file),
    // The bundled fallback is always available.
    process.resourcesPath ? path.join(process.resourcesPath, "models", BUNDLED_MODEL) : null,
    path.join(appRoot, "models", BUNDLED_MODEL),
  ].filter(Boolean);
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  throw new Error(`Локальная ИИ-модель не найдена (${file}). Загрузите её в окне «Модели ИИ» или переустановите Chuba Sprite Lab.`);
}

// DirectML runs the same model on the graphics card. Measured on the development machine the raw
// inference drops from ≈68 ms to ≈9 ms, but on real frames the whole per-frame step only goes from
// ≈264 ms to ≈118 ms, because decoding and resizing dominate it. The first start costs about 1.5 s
// more, so the accelerator pays off after roughly ten frames. Masks are not guaranteed to be
// bit-identical across devices, so the provider that actually ran is reported and the choice can
// be pinned to "cpu" when two machines have to agree.
export function providerAttempts(mode = "auto", platform = process.platform) {
  const requested = aiProviders.includes(mode) ? mode : "auto";
  if (requested === "cpu") return ["cpu"];
  if (requested === "dml") return ["dml", "cpu"];
  return platform === "win32" ? ["dml", "cpu"] : ["cpu"];
}

export function currentAIProvider() {
  return loadedProvider;
}

// The model always receives 320x320, so a 2048 pixel frame reaches it six times downscaled and a
// small subject turns into a few pixels. Splitting the frame into overlapping tiles gives the model
// a much closer look; the overlap is averaged, so no seam appears between tiles.
export function tilePlan(width, height, quality = "balanced") {
  const requested = aiQualityModes.includes(quality) ? quality : "balanced";
  if (requested === "fast") return { across: 1, down: 1, useTiles: false, quality: requested };
  const across = clamp(Math.round(width / TILE_TARGET), 1, MAX_TILES_PER_AXIS);
  const down = clamp(Math.round(height / TILE_TARGET), 1, MAX_TILES_PER_AXIS);
  return { across, down, useTiles: across > 1 || down > 1, quality: requested };
}

export function tileRects(width, height, { across = 1, down = 1 } = {}) {
  const rects = [];
  const stepX = width / across;
  const stepY = height / down;
  const padX = (stepX * TILE_OVERLAP) / 2;
  const padY = (stepY * TILE_OVERLAP) / 2;
  for (let row = 0; row < down; row += 1) {
    for (let column = 0; column < across; column += 1) {
      const left = Math.max(0, Math.round(column * stepX - padX));
      const top = Math.max(0, Math.round(row * stepY - padY));
      const right = Math.min(width, Math.round((column + 1) * stepX + padX));
      const bottom = Math.min(height, Math.round((row + 1) * stepY + padY));
      rects.push({ left, top, width: right - left, height: bottom - top });
    }
  }
  return rects;
}

// Otsu's method over the probability histogram: the split that minimises the variance inside both
// classes. A fixed 50% cuts a small subject away when the map is not balanced, so the threshold is
// derived from the frame itself instead of from a global constant.
export function otsuThreshold(counts) {
  if (!Array.isArray(counts) || !counts.length) return null;
  const total = counts.reduce((sum, value) => sum + value, 0);
  if (!total) return null;
  let weightedSum = 0;
  for (let level = 0; level < counts.length; level += 1) weightedSum += level * counts[level];
  let backgroundWeight = 0;
  let backgroundSum = 0;
  let best = null;
  let bestVariance = -1;
  for (let level = 0; level < counts.length; level += 1) {
    backgroundWeight += counts[level];
    if (!backgroundWeight) continue;
    const foregroundWeight = total - backgroundWeight;
    if (!foregroundWeight) break;
    backgroundSum += level * counts[level];
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (weightedSum - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      best = level;
    }
  }
  return best;
}

export function resetAISessionForTests() {
  loadedSession = null;
  loadedModelPath = null;
  loadedProvider = null;
  loadedMode = null;
  loadedInputSize = null;
  runQueue = Promise.resolve();
}

// The input size is read from the model itself: an export that takes 1024×1024 instead of 320×320 must
// keep working, and no table of guesses can know that in advance. The family only supplies a fallback
// for exports with dynamic dimensions.
async function getSession(appRoot, mode, { file = BUNDLED_MODEL, family = "u2net", extraDirs = [] } = {}) {
  const modelPath = await resolveAIModel(appRoot, { file, extraDirs });
  if (loadedSession && loadedModelPath === modelPath && loadedMode === mode) {
    return { session: loadedSession, inputSize: loadedInputSize, modelPath };
  }
  let lastError = null;
  for (const provider of providerAttempts(mode)) {
    try {
      const session = await ort.InferenceSession.create(modelPath, {
        executionProviders: [provider],
        graphOptimizationLevel: "all",
        executionMode: "sequential",
        ...(provider === "cpu"
          ? { intraOpNumThreads: Math.max(1, Math.min(2, os.cpus().length - 1)), interOpNumThreads: 1 }
          : {}),
      });
      const shapes = readSessionShapes(session);
      loadedSession = session;
      loadedModelPath = modelPath;
      loadedProvider = provider;
      loadedMode = mode;
      loadedInputSize = shapes.inputSize || familyInputSize(family);
      return { session, inputSize: loadedInputSize, modelPath, shapes };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Не удалось запустить локальную ИИ-модель: ${lastError?.message || "нет доступного ускорителя"}`);
}

function flopPlane(values, width, height, channels = 1) {
  const flipped = new values.constructor(values.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width * channels;
    for (let x = 0; x < width; x += 1) {
      const from = row + (width - 1 - x) * channels;
      const to = row + x * channels;
      for (let channel = 0; channel < channels; channel += 1) flipped[to + channel] = values[from + channel];
    }
  }
  return flipped;
}

async function runModel(session, rgb, size) {
  const plane = size * size;
  const tensorData = new Float32Array(plane * 3);
  for (let index = 0; index < plane; index += 1) {
    tensorData[index] = (rgb[index * 3] / 255 - MEAN[0]) / STD[0];
    tensorData[plane + index] = (rgb[index * 3 + 1] / 255 - MEAN[1]) / STD[1];
    tensorData[plane * 2 + index] = (rgb[index * 3 + 2] / 255 - MEAN[2]) / STD[2];
  }
  const tensor = new ort.Tensor("float32", tensorData, [1, 3, size, size]);
  const outputs = await withSessionLock(() => session.run({ [session.inputNames[0]]: tensor }));
  return outputs[session.outputNames[0]].data;
}

async function readRegionRgb(inputPath, rect, fullSize, size) {
  let pipeline = sharp(inputPath);
  if (rect.left || rect.top || rect.width !== fullSize.width || rect.height !== fullSize.height) {
    pipeline = pipeline.extract(rect);
  }
  return pipeline
    .removeAlpha()
    .resize(size, size, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .raw()
    .toBuffer();
}

async function toRegionSize(bytes, rect, size) {
  if (rect.width === size && rect.height === size) return bytes;
  const { data } = await sharp(bytes, { raw: { width: size, height: size, channels: 1 } })
    .resize(rect.width, rect.height, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .extractChannel(0)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data;
}

async function predictRegion(session, inputPath, rect, fullSize, useTta, size) {
  const rgb = await readRegionRgb(inputPath, rect, fullSize, size);
  const passes = [await runModel(session, rgb, size)];
  // Averaging a mirrored pass removes the model's own left/right bias, at the cost of one more run.
  if (useTta) passes.push(flopPlane(await runModel(session, flopPlane(rgb, size, size, 3), size), size, size));

  // One shared range for every pass: stretching each pass on its own would distort their average.
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const pass of passes) {
    for (const value of pass) {
      if (value < minimum) minimum = value;
      if (value > maximum) maximum = value;
    }
  }
  const range = Math.max(1e-6, maximum - minimum);
  const plane = size * size;
  const bytes = Buffer.alloc(plane);
  for (let index = 0; index < plane; index += 1) {
    let total = 0;
    for (const pass of passes) total += clamp((pass[index] - minimum) / range, 0, 1);
    bytes[index] = Math.round((total / passes.length) * 255);
  }
  return toRegionSize(bytes, rect, size);
}

export async function segmentSubject(inputPath, { appRoot, cutoff = 50, softness = 0, provider = "auto", quality = "balanced", model = null, modelDirs = [] } = {}) {
  if (!appRoot) throw new Error("Не указан путь к локальной ИИ-модели.");
  // An unknown or not-yet-downloaded model is not an error: the bundled one takes over and the report
  // says which model actually ran.
  const requested = model ? modelById(model) : null;
  const loader = await getSession(appRoot, provider, {
    file: requested?.file || BUNDLED_MODEL,
    family: requested?.family || "u2net",
    extraDirs: modelDirs,
  });
  const session = loader.session;
  const inputSize = loader.inputSize;
  const usedModel = requested && path.basename(loader.modelPath).toLowerCase() === requested.file.toLowerCase() ? requested : modelById("u2netp");
  const { data: source, info } = await sharp(inputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const fullSize = { width: info.width, height: info.height };
  const plan = tilePlan(info.width, info.height, quality);
  const useTta = plan.quality === "max";
  const rects = plan.useTiles ? tileRects(info.width, info.height, plan) : [fullSize];

  let mask;
  if (rects.length === 1 && !useTta) {
    mask = await predictRegion(session, inputPath, rects[0], fullSize, false, inputSize);
  } else {
    const sum = new Float32Array(info.width * info.height);
    const counts = new Uint8Array(info.width * info.height);
    for (const rect of rects) {
      const tile = await predictRegion(session, inputPath, rect, fullSize, useTta, inputSize);
      for (let y = 0; y < rect.height; y += 1) {
        const target = (rect.top + y) * info.width + rect.left;
        const from = y * rect.width;
        for (let x = 0; x < rect.width; x += 1) {
          sum[target + x] += tile[from + x];
          counts[target + x] += 1;
        }
      }
    }
    mask = Buffer.alloc(info.width * info.height);
    for (let index = 0; index < mask.length; index += 1) {
      mask[index] = counts[index] ? Math.round(sum[index] / counts[index]) : 0;
    }
  }
  if (mask.length !== info.width * info.height) {
    throw new Error("ИИ-маска имеет неверный формат. Обработка остановлена без изменения кадра.");
  }

  // The threshold is either the requested one or the one the frame itself suggests.
  let threshold;
  let autoThreshold = false;
  if (cutoff === "auto" || cutoff === null) {
    const histogram = new Array(256).fill(0);
    for (let index = 0; index < mask.length; index += 1) histogram[mask[index]] += 1;
    const split = otsuThreshold(histogram);
    threshold = (split == null ? 128 : clamp(split, 1, 254)) / 255;
    autoThreshold = true;
  } else {
    const parsedCutoff = Number(cutoff);
    threshold = clamp(Number.isFinite(parsedCutoff) ? parsedCutoff : 50, 1, 99) / 100;
  }

  const parsedSoftness = Number(softness);
  const edgeSoftness = clamp(Number.isFinite(parsedSoftness) ? parsedSoftness : 0, 0, 4);
  const alpha = new Uint8Array(info.width * info.height);
  const transition = 0.035 + edgeSoftness * 0.045;
  let opaque = 0;
  for (let index = 0; index < alpha.length; index += 1) {
    const probability = mask[index] / 255;
    let value;
    if (!edgeSoftness) {
      value = probability >= threshold ? 255 : 0;
    } else {
      const fraction = clamp((probability - threshold + transition) / (transition * 2), 0, 1);
      value = Math.round((fraction * fraction * (3 - 2 * fraction)) * 255);
    }
    const original = source[index * info.channels + 3];
    alpha[index] = Math.round((original * value) / 255);
    if (alpha[index] > 0) opaque += 1;
  }
  for (let index = 0; index < alpha.length; index += 1) source[index * info.channels + 3] = alpha[index];

  return {
    data: source,
    info,
    provider: loadedProvider,
    model: usedModel?.id || "u2netp",
    modelName: usedModel?.name || "U²-Net small",
    inputSize,
    quality: plan.quality,
    tiles: rects.length,
    tta: useTta,
    autoThreshold,
    threshold: Math.round(threshold * 100) / 100,
    coverage: info.width * info.height ? opaque / (info.width * info.height) : 0,
  };
}
