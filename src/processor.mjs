import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { currentAIProvider, segmentSubject } from "./ai-segmentation.mjs";
import { applyMaskEdits } from "./mask-edits.mjs";
import { cleanMagentaFringe } from "./edge-cleanup.mjs";
import { pixelate } from "./pixelate.mjs";
import { toneRgba } from "./toning.mjs";
import { decontaminateEdges } from "./edge-decontaminate.mjs";
import { refineEdgeRgba } from "./edge-refine.mjs";
import { findBodyAnchor } from "./body-anchor.mjs";
import { compositeAttachments, trackAttachmentPlacements } from "./attachment-tracker.mjs";
import { inspectAtlas } from "./atlas-inspector.mjs";
import { findWhiteRemainders } from "./white-remainders.mjs";
import { makeTempWorkspace, finishQuickPreview } from "./temp-workspace.mjs";
import { resolveAuxModel } from "./model-paths.mjs";
import { loadAuxSession, inpaintLama, interpolateRife, upscaleEsrgan, estimateDepth } from "./aux-ai.mjs";

export const supportedImageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".avif"]);
const naturalCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare;
const frameKeyCache = new Map();
const videoFrameCache = new Map();
sharp.cache({ memory: 32, files: 0, items: 32 });

function rememberFrameKey(cacheKey, result) {
  frameKeyCache.set(cacheKey, result);
  while (frameKeyCache.size > 12) frameKeyCache.delete(frameKeyCache.keys().next().value);
  return result;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function safeName(value) {
  return String(value || "sprite-animation")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80) || "sprite-animation";
}

async function exists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

const auxiliarySessions = new Map();
async function auxiliarySession(id, options, appRoot) {
  const file = await resolveAuxModel(id, { ...options, appRoot });
  if (!auxiliarySessions.has(file)) auxiliarySessions.set(file, loadAuxSession(file));
  return auxiliarySessions.get(file);
}

async function nextAvailableBatchName(outputDir, requestedName, reservedNames) {
  const baseName = safeName(requestedName);
  let candidate = baseName;
  let version = 2;
  while (reservedNames.has(candidate) || await exists(path.join(outputDir, candidate))) {
    candidate = safeName(`${baseName}-${version}`);
    version += 1;
  }
  reservedNames.add(candidate);
  return candidate;
}

// Exported so the self test checks the same files the pipeline resolves, instead of assuming a
// packaged build: from a source checkout process.resourcesPath points into Electron itself.
export async function resolveBinary(name, appRoot) {
  const executable = process.platform === "win32" ? `${name}.exe` : name;
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, "vendor", executable) : null,
    path.join(appRoot, "vendor", executable),
  ].filter(Boolean);
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  return executable;
}

function runProcess(command, args, { onLine, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      onLine?.(text);
    });
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(new Error("Обработка отменена."));
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(command)} завершился с кодом ${code}.\n${stderr.slice(-1600)}`));
    });
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error("Обработка отменена.");
}

async function probeVideo(filePath, appRoot) {
  const ffmpeg = await resolveBinary("ffmpeg", appRoot);
  const { stderr } = await runProcess(ffmpeg, [
    "-hide_banner",
    "-i", filePath,
    "-map", "0:v:0",
    "-frames:v", "0",
    "-f", "null",
    "-",
  ]);
  const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/i);
  const videoLine = stderr.split(/\r?\n/).find((line) => /Video:/i.test(line)) || "";
  const dimensionsMatch = videoLine.match(/(?:^|\D)(\d{2,5})x(\d{2,5})(?:\D|$)/);
  const fpsMatch = videoLine.match(/([\d.]+)\s+fps\b/i);
  const duration = durationMatch
    ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
    : 0;
  const fps = fpsMatch ? Number(fpsMatch[1]) : 0;
  const estimatedFrames = Math.round(duration * fps);
  return {
    width: Number(dimensionsMatch?.[1] || 0),
    height: Number(dimensionsMatch?.[2] || 0),
    duration,
    fps,
    estimatedFrames,
  };
}

async function makeVideoFramePreview(filePath, time, appRoot) {
  const previewDir = await makeTempWorkspace("chuba-sprite-source-");
  const previewPath = path.join(previewDir, "first-frame.png");
  const ffmpeg = await resolveBinary("ffmpeg", appRoot);
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  if (Number(time) > 0) args.push("-ss", String(time));
  args.push("-i", filePath,
    "-map", "0:v:0",
    "-frames:v", "1",
    "-update", "1",
    previewPath,
  );
  await runProcess(ffmpeg, args);
  return previewPath;
}

export async function makeSourcePreview(filePath, kind, appRoot, time = 0) {
  return kind === "video" ? makeVideoFramePreview(filePath, time, appRoot) : filePath;
}

async function makeSourceSamples(filePath, kind, duration, fps, framePaths, appRoot) {
  if (kind !== "video") {
    const indexes = [...new Set([0, Math.floor((framePaths.length - 1) / 2), framePaths.length - 1])];
    return indexes.map((index) => framePaths[index]).filter(Boolean);
  }
  const lastTime = Math.max(0, duration - (fps > 0 ? 1 / fps : 0.04));
  const times = [...new Set([0, duration / 2, lastTime].map((value) => Math.max(0, Math.round(value * 1000) / 1000)))];
  const samples = [];
  for (const time of times) samples.push(await makeVideoFramePreview(filePath, time, appRoot));
  return samples;
}

async function detectSuggestedKeyMode(filePath) {
  const { data, info } = await sharp(filePath).resize({ width: 320, height: 320, fit: "inside" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let transparentBorder = 0;
  let borderCount = 0;
  const count = (x, y) => { borderCount += 1; if (data[(y * width + x) * channels + 3] < 16) transparentBorder += 1; };
  for (let x = 0; x < width; x += 1) { count(x, 0); count(x, height - 1); }
  for (let y = 1; y < height - 1; y += 1) { count(0, y); count(width - 1, y); }
  if (transparentBorder / Math.max(1, borderCount) > 0.55) return "alpha";
  const [r, g, b] = borderKeyColor(data, info);
  // A single-color key can erase parts of a subject when the border contains a scene.
  // Recommend the bundled local model only when the sampled edge is clearly varied.
  let opaqueBorder = 0;
  let matchingBorder = 0;
  const sample = (x, y) => {
    const offset = (y * width + x) * channels;
    if (data[offset + 3] < 16) return;
    opaqueBorder += 1;
    if (colorDistance(data, offset, [r, g, b]) <= 42) matchingBorder += 1;
  };
  for (let x = 0; x < width; x += 1) { sample(x, 0); sample(x, height - 1); }
  for (let y = 1; y < height - 1; y += 1) { sample(0, y); sample(width - 1, y); }
  if (opaqueBorder && matchingBorder / opaqueBorder < 0.62) return "ai";
  if (Math.max(r, g, b) < 58) return "black";
  if (Math.min(r, g, b) > 215) return "white";
  if (g > r * 1.35 && g > b * 1.35) return "green";
  if (b > r * 1.35 && b > g * 1.2) return "blue";
  return "auto";
}

async function detectFastAIKeyMode(filePath) {
  const { data, info } = await sharp(filePath).resize({ width: 320, height: 320, fit: "inside" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const candidates = [
    ["white", [255, 255, 255], 55],
    ["black", [0, 0, 0], 55],
    ["green", [0, 255, 0], 82],
    ["blue", [0, 0, 255], 82],
  ];
  let best = null;
  for (const [mode, key, threshold] of candidates) {
    const visited = new Uint8Array(width * height);
    const queue = new Int32Array(width * height);
    let head = 0;
    let tail = 0;
    let borderCount = 0;
    let matchingBorder = 0;
    const enqueue = (x, y, border = false) => {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      const index = y * width + x;
      if (border) borderCount += 1;
      if (visited[index] || colorDistance(data, index * channels, key) > threshold) return;
      if (border) matchingBorder += 1;
      visited[index] = 1;
      queue[tail++] = index;
    };
    for (let x = 0; x < width; x += 1) { enqueue(x, 0, true); enqueue(x, height - 1, true); }
    for (let y = 1; y < height - 1; y += 1) { enqueue(0, y, true); enqueue(width - 1, y, true); }
    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);
      enqueue(x - 1, y);
      enqueue(x + 1, y);
      enqueue(x, y - 1);
      enqueue(x, y + 1);
    }
    const borderRatio = matchingBorder / Math.max(1, borderCount);
    const connectedRatio = tail / Math.max(1, width * height);
    const score = borderRatio * 0.7 + connectedRatio * 0.3;
    if (borderRatio >= 0.5 && connectedRatio >= 0.12 && (!best || score > best.score)) best = { mode, score };
  }
  return best?.mode || null;
}

async function recommendSource(samplePaths, video = {}) {
  const modes = [];
  for (const samplePath of samplePaths) modes.push(await detectSuggestedKeyMode(samplePath));
  const counts = new Map();
  for (const mode of modes) counts.set(mode, (counts.get(mode) || 0) + 1);
  const [keyMode, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || ["auto", 0];
  let maxWidth = 0;
  let maxHeight = 0;
  // The model runs when the user checks the preview. Until then its silhouette size is unknown.
  if (keyMode !== "ai") for (const samplePath of samplePaths) {
    const keyed = await keyFrame(samplePath, keyMode, 28, 3, 0);
    if (keyed.bounds) {
      maxWidth = Math.max(maxWidth, keyed.bounds.width);
      maxHeight = Math.max(maxHeight, keyed.bounds.height);
    }
  }
  const sourceFps = Number(video.fps) || 0;
  const fps = sourceFps > 16 ? Math.max(8, Math.round(sourceFps / 2)) : sourceFps ? Math.round(sourceFps) : 8;
  return {
    keyMode,
    confidence: samplePaths.length ? count / samplePaths.length : 0,
    fps,
    anchor: "ground",
    cellWidth: maxWidth ? maxWidth + 40 : 0,
    cellHeight: maxHeight ? maxHeight + 40 : 0,
    estimatedFrames: video.duration ? Math.max(1, Math.round(video.duration * fps)) : 0,
  };
}

// Per-file info for the "sprite sheet from images" workflow (JPG/PNG/WEBP, any size).
export async function describeImageFiles(paths) {
  const images = [];
  for (const filePath of paths.slice(0, 1000)) {
    try {
      const meta = await sharp(filePath).metadata();
      images.push({ name: path.basename(filePath), format: String(meta.format || path.extname(filePath).slice(1)).toLowerCase(), width: meta.width || 0, height: meta.height || 0, hasAlpha: Boolean(meta.hasAlpha) });
    } catch {
      throw new Error(`Не удалось прочитать изображение: ${path.basename(filePath)}`);
    }
  }
  return images;
}

function describeImageFormats(images) {
  const counts = new Map();
  for (const image of images) {
    const label = image.format === "jpeg" ? "JPG" : image.format.toUpperCase();
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => `${label} ${count}`).join(" · ");
}

export async function inspectSource({ kind, paths, appRoot }) {
  const orderedPaths = [...paths].sort(naturalCompare);
  if (!orderedPaths.length) throw new Error("В выбранном источнике нет поддерживаемых кадров.");
  const first = orderedPaths[0];
  const fileStats = await fs.stat(first);
  if (kind === "video") {
    const video = await probeVideo(first, appRoot);
    const samplePaths = await makeSourceSamples(first, kind, video.duration, video.fps, [], appRoot);
    const previewPath = samplePaths[0];
    const recommendations = await recommendSource(samplePaths, video);
    return {
      kind,
      paths: [first],
      title: path.basename(first),
      detail: `${video.width}×${video.height} · ${video.duration.toFixed(1)} с · ${video.fps.toFixed(2)} fps`,
      sizeBytes: fileStats.size,
      previewPath,
      suggestedKeyMode: recommendations.keyMode,
      samplePaths,
      recommendations,
      ...video,
    };
  }
  const metadata = await sharp(first).metadata();
  const samplePaths = await makeSourceSamples(first, kind, 0, 0, orderedPaths, appRoot);
  const recommendations = await recommendSource(samplePaths, {});
  const images = await describeImageFiles(orderedPaths);
  const sizes = new Set(images.map((image) => `${image.width}×${image.height}`));
  const formats = describeImageFormats(images);
  const sizeText = sizes.size > 1
    ? `разные размеры ${Math.min(...images.map((image) => image.width))}–${Math.max(...images.map((image) => image.width))} × ${Math.min(...images.map((image) => image.height))}–${Math.max(...images.map((image) => image.height))}`
    : `${metadata.width || 0}×${metadata.height || 0}`;
  return {
    kind: "frames",
    paths: orderedPaths,
    title: orderedPaths.length === 1 ? path.basename(first) : `${path.basename(path.dirname(first))} · ${orderedPaths.length} кадров`,
    detail: `${sizeText} · ${orderedPaths.length} файлов${formats ? ` · ${formats}` : ""}`,
    images,
    mixedSizes: sizes.size > 1,
    opaqueImages: images.filter((image) => !image.hasAlpha).length,
    sizeBytes: fileStats.size,
    previewPath: first,
    suggestedKeyMode: recommendations.keyMode,
    samplePaths,
    recommendations,
    width: metadata.width || 0,
    height: metadata.height || 0,
    estimatedFrames: orderedPaths.length,
    fps: 0,
    duration: 0,
  };
}

function borderKeyColor(data, info) {
  const { width, height, channels } = info;
  const histogram = new Map();
  const add = (x, y) => {
    const offset = (y * width + x) * channels;
    if (data[offset + 3] < 16) return;
    const r = data[offset] >> 4;
    const g = data[offset + 1] >> 4;
    const b = data[offset + 2] >> 4;
    const key = `${r},${g},${b}`;
    histogram.set(key, (histogram.get(key) || 0) + 1);
  };
  const stepX = Math.max(1, Math.floor(width / 180));
  const stepY = Math.max(1, Math.floor(height / 180));
  for (let x = 0; x < width; x += stepX) { add(x, 0); add(x, height - 1); }
  for (let y = 0; y < height; y += stepY) { add(0, y); add(width - 1, y); }
  let winner = "15,15,15";
  let winnerCount = -1;
  for (const [key, count] of histogram) {
    if (count > winnerCount) { winner = key; winnerCount = count; }
  }
  return winner.split(",").map((part) => Number(part) * 16 + 8);
}

function colorDistance(data, offset, key) {
  const dr = data[offset] - key[0];
  const dg = data[offset + 1] - key[1];
  const db = data[offset + 2] - key[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function alphaBounds(data, info, threshold = 12) {
  const { width, height, channels } = info;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * channels + 3] <= threshold) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function scaledBlackOutlineRadius(level, width, height) {
  const resolutionScale = clamp(Math.sqrt(width * height) / 512, 1, 3);
  return clamp(Math.round(level * resolutionScale), 0, 24);
}

function clearMaskOutsideProtectedContour(mask, width, height, radius) {
  if (radius <= 0) return mask;

  const clearMask = Uint8Array.from(mask);
  const distance = new Int16Array(mask.length);
  distance.fill(-1);
  const queue = new Int32Array(mask.length);
  let head = 0;
  let tail = 0;

  // Every non-background pixel is a subject seed. Expanding from those seeds
  // protects the original dark pixels nearest the coloured silhouette, even
  // when the black outline itself is connected to a black background.
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index]) continue;
    distance[index] = 0;
    queue[tail++] = index;
  }

  const visit = (index, nextDistance) => {
    if (index < 0 || index >= mask.length || distance[index] !== -1 || !mask[index]) return;
    distance[index] = nextDistance;
    clearMask[index] = 0;
    if (nextDistance < radius) queue[tail++] = index;
  };

  while (head < tail) {
    const index = queue[head++];
    const nextDistance = distance[index] + 1;
    if (nextDistance > radius) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    if (x > 0) visit(index - 1, nextDistance);
    if (x + 1 < width) visit(index + 1, nextDistance);
    if (y > 0) visit(index - width, nextDistance);
    if (y + 1 < height) visit(index + width, nextDistance);
    if (x > 0 && y > 0) visit(index - width - 1, nextDistance);
    if (x + 1 < width && y > 0) visit(index - width + 1, nextDistance);
    if (x > 0 && y + 1 < height) visit(index + width - 1, nextDistance);
    if (x + 1 < width && y + 1 < height) visit(index + width + 1, nextDistance);
  }

  return clearMask;
}

// Unmixing an edge needs a background to unmix from, so the border is only trusted when
// enough of it is opaque. An already transparent source has no background to remove.
function borderOpaqueRatio(data, info) {
  const { width, height, channels } = info;
  const step = Math.max(1, Math.floor(Math.min(width, height) / 60));
  let total = 0;
  let opaque = 0;
  const sample = (x, y) => {
    total += 1;
    if (data[(y * width + x) * channels + 3] >= 16) opaque += 1;
  };
  for (let x = 0; x < width; x += step) { sample(x, 0); sample(x, height - 1); }
  for (let y = 0; y < height; y += step) { sample(0, y); sample(width - 1, y); }
  return total ? opaque / total : 0;
}

async function applyCorrectionsToResult(result, inputPath, context = {}) {
  const edits = context.aiEdits || [];
  if (!edits.length && !context.fringeCleanup && !context.edgeDecontaminate) return result;
  const [{ data, info }, original] = await Promise.all([
    sharp(result.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(inputPath).ensureAlpha().raw().toBuffer(),
  ]);
  const maskTracking = applyMaskEdits(data, original, info, edits, context.frameIndex).tracked;
  // A soft matte keeps a blend of the old background, which reads as a pale halo around fur
  // and thin edges once the sprite stands on anything else.
  if (context.edgeDecontaminate && borderOpaqueRatio(original, info) > 0.6) {
    decontaminateEdges(data, info, borderKeyColor(original, info));
  }
  if (context.fringeCleanup) cleanMagentaFringe(data, info, context.fringeStrength);
  return {
    ...result,
    buffer: await sharp(data, { raw: info }).png().toBuffer(),
    info,
    bounds: alphaBounds(data, info),
    maskTracking,
  };
}

export async function keyFrame(inputPath, mode, tolerance, blackOutline = 3, blackFeather = 0, context = {}) {
  const fileStats = await fs.stat(inputPath);
  const correctionSignature = JSON.stringify([
    context.fringeCleanup, context.fringeStrength,
    context.edgeDecontaminate,
    context.keyScope,
    Array.isArray(context.keyColor) ? context.keyColor.slice(0, 3) : null,
    mode === "ai" ? context.aiProvider : null,
    mode === "ai" ? context.aiQuality : null,
    mode === "ai" ? context.aiCutoff : null,
    mode === "ai" ? context.aiSoftness : null,
    mode === "ai" ? context.aiForceModel : null,
    // The mask depends on which model ran, so the model belongs in the cache key too.
    mode === "ai" ? context.aiModel || "u2netp" : null,
    context.aiEdits?.length ? context.frameIndex : null,
    context.aiEdits || [],
  ]);
  const cacheKey = `${inputPath}|${fileStats.mtimeMs}|${mode}|${tolerance}|${blackOutline}|${blackFeather}|${correctionSignature}`;
  if (frameKeyCache.has(cacheKey)) return frameKeyCache.get(cacheKey);

  if (mode === "ai") {
    const edits = context.aiEdits || [];
    const fastMode = !context.aiForceModel ? await detectFastAIKeyMode(inputPath) : null;
    if (fastMode) {
      const fastResult = await keyFrame(inputPath, fastMode, tolerance, blackOutline, blackFeather, {});
      const edited = await applyCorrectionsToResult({ ...fastResult, aiFastPath: fastMode }, inputPath, context);
      return rememberFrameKey(cacheKey, edited);
    }
    const segmented = await segmentSubject(inputPath, {
      appRoot: context.appRoot,
      cutoff: context.aiCutoff,
      softness: context.aiSoftness,
      provider: context.aiProvider,
      quality: context.aiQuality,
      model: context.aiModel,
      modelDirs: context.aiModelDirs || [],
    });
    const result = await applyCorrectionsToResult({
      buffer: await sharp(segmented.data, { raw: segmented.info }).png().toBuffer(),
      info: segmented.info,
      bounds: alphaBounds(segmented.data, segmented.info),
      keyColor: null,
      // What the model actually did belongs in the report: it explains a mask that looks wrong.
      aiMetrics: {
        provider: segmented.provider,
        model: segmented.model,
        modelName: segmented.modelName,
        inputSize: segmented.inputSize,
        quality: segmented.quality,
        tiles: segmented.tiles,
        tta: segmented.tta,
        autoThreshold: segmented.autoThreshold,
        threshold: segmented.threshold,
        coverage: segmented.coverage,
      },
    }, inputPath, context);
    return rememberFrameKey(cacheKey, result);
  }

  const { data, info } = await sharp(inputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const original = Buffer.from(data);
  if (mode === "alpha") {
    const maskTracking = applyMaskEdits(data, original, info, context.aiEdits || [], context.frameIndex).tracked;
    if (context.fringeCleanup) cleanMagentaFringe(data, info, context.fringeStrength);
    const result = { buffer: await sharp(data, { raw: info }).png().toBuffer(), info, bounds: alphaBounds(data, info), keyColor: null, maskTracking };
    return rememberFrameKey(cacheKey, result);
  }

  const keys = {
    white: [255, 255, 255],
    black: [0, 0, 0],
    green: [0, 255, 0],
    blue: [0, 0, 255],
  };
  const customKey = Array.isArray(context.keyColor) && context.keyColor.length >= 3
    ? context.keyColor.slice(0, 3).map((value) => clamp(Math.round(Number(value) || 0), 0, 255))
    : null;
  const keyColor = mode === "custom" && customKey ? customKey : (keys[mode] || borderKeyColor(data, info));
  const threshold = clamp(Number(tolerance) || 28, 1, 100) * (mode === "black" ? 1.8 : 2.6);
  const { width, height, channels } = info;

  if (context.keyScope === "all" || (!context.keyScope && (mode === "green" || mode === "blue"))) {
    for (let index = 0; index < width * height; index += 1) {
      const offset = index * channels;
      const distance = colorDistance(data, offset, keyColor);
      if (distance <= threshold) data[offset + 3] = 0;
      else if (distance <= threshold * 1.55) {
        const fraction = (distance - threshold) / (threshold * 0.55);
        data[offset + 3] = Math.min(data[offset + 3], Math.round(255 * fraction));
      }
      if (data[offset + 3] > 0 && mode === "green") {
        data[offset + 1] = Math.min(data[offset + 1], Math.round((data[offset] + data[offset + 2]) / 2 + 20));
      }
      if (data[offset + 3] > 0 && mode === "blue") {
        data[offset + 2] = Math.min(data[offset + 2], Math.round((data[offset] + data[offset + 1]) / 2 + 20));
      }
    }
  } else {
    const visited = new Uint8Array(width * height);
    const queue = new Int32Array(width * height);
    let head = 0;
    let tail = 0;
    const enqueue = (x, y) => {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      const index = y * width + x;
      if (visited[index]) return;
      const offset = index * channels;
      if (data[offset + 3] === 0 || colorDistance(data, offset, keyColor) <= threshold) {
        visited[index] = 1;
        queue[tail++] = index;
      }
    };
    for (let x = 0; x < width; x += 1) { enqueue(x, 0); enqueue(x, height - 1); }
    for (let y = 0; y < height; y += 1) { enqueue(0, y); enqueue(width - 1, y); }
    // Existing transparency is background too, including disconnected cut-outs.
    // Seed it before flooding the selected colour; enclosed opaque details stay protected.
    for (let index = 0; index < width * height; index += 1) {
      if (data[index * channels + 3] === 0) enqueue(index % width, Math.floor(index / width));
    }
    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);
      enqueue(x - 1, y);
      enqueue(x + 1, y);
      enqueue(x, y - 1);
      enqueue(x, y + 1);
    }

    const outlineLevel = clamp(Math.round(Number(blackOutline) || 0), 0, 12);
    const outlineRadius = mode === "black" ? scaledBlackOutlineRadius(outlineLevel, width, height) : 0;
    const clearMask = mode === "black" && outlineRadius > 0
      ? clearMaskOutsideProtectedContour(visited, width, height, outlineRadius)
      : visited;
    for (let index = 0; index < clearMask.length; index += 1) {
      if (clearMask[index]) data[index * channels + 3] = 0;
    }

    if (mode === "black" && Number(blackFeather) > 0) {
      const feather = clamp(Math.round(Number(blackFeather)), 1, 3);
      const alpha = new Uint8Array(width * height);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const index = y * width + x;
          const offset = index * channels;
          if (data[offset + 3] === 0) continue;
          let nearest = feather + 1;
          for (let dy = -feather; dy <= feather; dy += 1) {
            const ny = y + dy;
            if (ny < 0 || ny >= height) continue;
            for (let dx = -feather; dx <= feather; dx += 1) {
              const nx = x + dx;
              if (nx < 0 || nx >= width || !clearMask[ny * width + nx]) continue;
              nearest = Math.min(nearest, Math.max(Math.abs(dx), Math.abs(dy)));
            }
          }
          if (nearest <= feather) alpha[index] = Math.round(255 * nearest / (feather + 1));
        }
      }
      for (let index = 0; index < alpha.length; index += 1) {
        if (alpha[index]) data[index * channels + 3] = Math.min(data[index * channels + 3], alpha[index]);
      }
    }

    const softened = new Uint8Array(width * height);
    if (mode !== "black") {
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x;
        const offset = index * channels;
        if (data[offset + 3] === 0) continue;
        const touchesClear = data[offset - channels + 3] === 0 || data[offset + channels + 3] === 0
          || data[offset - width * channels + 3] === 0 || data[offset + width * channels + 3] === 0;
        if (!touchesClear) continue;
        const distance = colorDistance(data, offset, keyColor);
        if (distance < threshold * 1.65) {
          softened[index] = Math.round(255 * clamp((distance - threshold) / (threshold * 0.65), 0, 1));
        }
      }
    }
    }
    for (let index = 0; index < softened.length; index += 1) {
      if (softened[index]) data[index * channels + 3] = Math.min(data[index * channels + 3], softened[index]);
    }
  }

  // In a solid-key mode the background colour is known exactly, so a soft edge can be
  // unmixed rather than left as a pale rim.
  if (context.edgeDecontaminate && Array.isArray(keyColor)) decontaminateEdges(data, info, keyColor);
  const maskTracking = applyMaskEdits(data, original, info, context.aiEdits || [], context.frameIndex).tracked;
  if (context.fringeCleanup) cleanMagentaFringe(data, info, context.fringeStrength);
  const bounds = alphaBounds(data, info);
  const result = {
    buffer: await sharp(data, { raw: info }).png().toBuffer(),
    info,
    bounds,
    keyColor,
    maskTracking,
  };
  return rememberFrameKey(cacheKey, result);
}

async function extractVideoFrames(videoPath, outputDir, fps, maxFrames, appRoot, onProgress, trimStart = 0, trimEnd = 0, signal) {
  const ffmpeg = await resolveBinary("ffmpeg", appRoot);
  await fs.mkdir(outputDir, { recursive: true });
  const pattern = path.join(outputDir, "source-%05d.png");
  const filter = `fps=${clamp(Number(fps) || 8, 1, 60)}`;
  const args = ["-hide_banner", "-loglevel", "warning", "-y"];
  const start = Math.max(0, Number(trimStart) || 0);
  const end = Math.max(0, Number(trimEnd) || 0);
  if (start > 0) args.push("-ss", String(start));
  args.push("-i", videoPath);
  if (end > start) args.push("-t", String(end - start));
  args.push(
    "-vf", filter,
    "-frames:v", String(clamp(Number(maxFrames) || 192, 1, 1000)),
    "-start_number", "0",
    pattern,
  );
  await runProcess(ffmpeg, args, { signal, onLine: () => onProgress?.({ stage: "extract", value: 0.12, message: "Извлекаю кадры из видео…" }) });
  const names = (await fs.readdir(outputDir)).filter((name) => name.endsWith(".png")).sort(naturalCompare);
  return names.map((name) => path.join(outputDir, name));
}

async function exactFrameHash(buffer) {
  const raw = await sharp(buffer).resize(24, 24, { fit: "fill" }).ensureAlpha().raw().toBuffer();
  return crypto.createHash("sha1").update(raw).digest("hex");
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}


async function alphaDifference(left, right) {
  const decode = (buffer) => sharp(buffer).resize(32, 32, { fit: "fill" }).ensureAlpha().raw().toBuffer();
  const [a, b] = await Promise.all([decode(left), decode(right)]);
  let difference = 0;
  for (let index = 3; index < a.length; index += 4) difference += Math.abs(a[index] - b[index]);
  return difference / (32 * 32 * 255);
}

async function warnLoopSeam(rendered, prepared, options) {
  if (options.loopMode === "pingpong" || rendered.length < 3) return null;
  const { sequence } = buildSequence(prepared, options);
  const loop = resolveLoop(options, sequence.length);
  if (loop.to - loop.from < 2) return null;
  const frame = (position) => rendered[sequence[position].image].buffer;
  const seam = await alphaDifference(frame(loop.from), frame(loop.to));
  const steps = [];
  const stride = Math.max(1, Math.ceil((loop.to - loop.from) / 12));
  for (let index = loop.from; index < loop.to; index += stride) steps.push(await alphaDifference(frame(index), frame(index + 1)));
  const sorted = steps.sort((a, b) => a - b);
  const normal = sorted[Math.floor(sorted.length / 2)] || 0;
  return seam > 0.12 && seam > normal * 1.65
    ? `Цикл: заметный скачок силуэта между кадрами ${loop.to + 1} и ${loop.from + 1}. Проверьте переход.`
    : null;
}

function makeReport(frames, skipped, keyMode) {
  const widths = frames.map((frame) => frame.bounds.width);
  const heights = frames.map((frame) => frame.bounds.height);
  const averageWidth = mean(widths);
  const averageHeight = mean(heights);
  const entries = [];
  // The message keeps a human-readable number, the structured list carries the source
  // index, so the interface never has to parse "Кадр N" back out of the text. The number
  // itself is the source index: it used to be the position inside the filtered list,
  // which disagreed with the frame the user saw once some frames were excluded.
  const warn = (message, frameIndex = null) => entries.push({ message, frameIndex });
  frames.forEach((frame) => {
    const number = frame.sourceIndex + 1;
    if (Math.abs(frame.bounds.width - averageWidth) / Math.max(1, averageWidth) > 0.2) warn(`Кадр ${number}: ширина силуэта отличается более чем на 20%.`, frame.sourceIndex);
    if (Math.abs(frame.bounds.height - averageHeight) / Math.max(1, averageHeight) > 0.2) warn(`Кадр ${number}: высота силуэта отличается более чем на 20%.`, frame.sourceIndex);
    const { bounds, info } = frame;
    if (bounds.left <= 1 || bounds.top <= 1 || bounds.left + bounds.width >= info.width - 1 || bounds.top + bounds.height >= info.height - 1) {
      warn(`Кадр ${number}: объект касается края исходного изображения.`, frame.sourceIndex);
    }
  });
  const unique = new Map();
  for (const entry of entries) if (!unique.has(entry.message)) unique.set(entry.message, entry);
  const list = [...unique.values()].slice(0, 100);
  return {
    generatedAt: new Date().toISOString(),
    keyMode,
    sourceFrames: frames.length + skipped.empty + skipped.duplicates + (skipped.excluded || 0),
    outputFrames: frames.length,
    skipped,
    silhouette: {
      averageWidth: Math.round(averageWidth * 100) / 100,
      averageHeight: Math.round(averageHeight * 100) / 100,
      minimumWidth: Math.min(...widths),
      maximumWidth: Math.max(...widths),
      minimumHeight: Math.min(...heights),
      maximumHeight: Math.max(...heights),
    },
    warnings: list.map((entry) => entry.message),
    frameIssues: list.filter((entry) => entry.frameIndex != null).map((entry) => ({ frameIndex: entry.frameIndex, message: entry.message })),
  };
}

function resolveFrameTransform(options, sourceIndex) {
  const transforms = options.frameTransforms;
  if (!transforms || typeof transforms !== "object") return null;
  const value = transforms[sourceIndex] || transforms[String(sourceIndex)] || transforms["*"];
  if (!value || typeof value !== "object") return null;
  return {
    scaleX: clamp(Number(value.scaleX) || 1, 0.25, 2.5),
    scaleY: clamp(Number(value.scaleY) || 1, 0.25, 2.5),
    offsetX: clamp(Number(value.offsetX) || 0, -100, 100),
    offsetY: clamp(Number(value.offsetY) || 0, -100, 100),
    skewX: clamp(Number(value.skewX) || 0, -35, 35),
    skewY: clamp(Number(value.skewY) || 0, -35, 35),
    fill: value.fill === "stretch" ? "stretch" : null,
  };
}

async function placeTransformedSprite({ sprite, width, height, left, top, canvasWidth, canvasHeight, transform, kernel, background }) {
  let targetWidth = transform.fill === "stretch" ? canvasWidth : Math.max(1, Math.round(width * transform.scaleX));
  let targetHeight = transform.fill === "stretch" ? canvasHeight : Math.max(1, Math.round(height * transform.scaleY));
  let transformed = await sharp(sprite).resize({ width: targetWidth, height: targetHeight, fit: "fill", kernel }).png().toBuffer();
  if ((transform.skewX || transform.skewY) && transform.fill !== "stretch") {
    transformed = await sharp(transformed).affine([
      [1, Math.tan(transform.skewX * Math.PI / 180)],
      [Math.tan(transform.skewY * Math.PI / 180), 1],
    ], { background: { r: 0, g: 0, b: 0, alpha: 0 }, interpolator: "bicubic" }).png().toBuffer();
    const metadata = await sharp(transformed).metadata();
    targetWidth = metadata.width || targetWidth; targetHeight = metadata.height || targetHeight;
  }
  let targetLeft = transform.fill === "stretch"
    ? 0
    : Math.round(left + width / 2 - targetWidth / 2 + transform.offsetX / 100 * canvasWidth);
  let targetTop = transform.fill === "stretch"
    ? 0
    : Math.round(top + height / 2 - targetHeight / 2 + transform.offsetY / 100 * canvasHeight);
  const cropLeft = Math.max(0, -targetLeft); const cropTop = Math.max(0, -targetTop);
  const visibleWidth = Math.min(targetWidth - cropLeft, canvasWidth - Math.max(0, targetLeft));
  const visibleHeight = Math.min(targetHeight - cropTop, canvasHeight - Math.max(0, targetTop));
  const canvas = sharp({ create: { width: canvasWidth, height: canvasHeight, channels: 4, background } });
  if (visibleWidth <= 0 || visibleHeight <= 0) return { buffer: await canvas.png().toBuffer(), left: targetLeft, top: targetTop, width: targetWidth, height: targetHeight };
  if (cropLeft || cropTop || visibleWidth !== targetWidth || visibleHeight !== targetHeight) {
    transformed = await sharp(transformed).extract({ left: cropLeft, top: cropTop, width: visibleWidth, height: visibleHeight }).png().toBuffer();
  }
  targetLeft = Math.max(0, targetLeft); targetTop = Math.max(0, targetTop);
  return {
    buffer: await canvas.composite([{ input: transformed, left: targetLeft, top: targetTop }]).png().toBuffer(),
    left: targetLeft, top: targetTop, width: visibleWidth, height: visibleHeight,
  };
}

// Frames are handled with a bounded pool: the width follows the machine unless the caller pins
// it, and results are always restored by index, so scheduling never changes the output. Measured
// on the development machine (20 logical cores, 12 real frames) both the cleanup and the placing
// stage drop about 2.5x from width 1 to width 4. Neural inference itself is serialised inside the
// model module, so a wide pool only overlaps decoding with it.
function parallelismFor(options = {}) {
  const requested = Math.round(Number(options.frameParallelism) || 0);
  return requested > 0 ? clamp(requested, 1, 8) : clamp(Math.floor(os.cpus().length / 3), 1, 4);
}

// A single page cannot be split across threads, so pooling only pays off once the atlas has
// several pages.
function parallelismOfPages(pageCount, options) {
  return pageCount > 1 ? parallelismFor(options) : 1;
}

// Runs indexed tasks with a bounded pool and restores the original order, so scheduling can
// never change the produced atlas. Used everywhere per-frame sharp work happens.
async function runPooled(items, width, task) {
  const results = new Array(items.length);
  const inFlight = new Map();
  let next = 0;
  for (let index = 0; index < items.length; index += 1) {
    while (next < items.length && next < index + width) {
      const scheduled = next;
      inFlight.set(scheduled, task(items[scheduled], scheduled).then(
        (value) => ({ value }),
        (error) => ({ error }),
      ));
      next += 1;
    }
    const outcome = await inFlight.get(index);
    inFlight.delete(index);
    if (outcome.error) throw outcome.error;
    results[index] = outcome.value;
  }
  return results;
}

// Redraws one prepared frame as pixel art. The silhouette is measured again, because the hitbox and
// the layout must describe the art that is actually exported, not the art before the redraw.
async function applyPixelation(frame, options) {
  const { data, info } = await sharp(frame.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const result = pixelate(data, info, options);
  return {
    ...frame,
    buffer: await sharp(result.data, { raw: result.info }).png().toBuffer(),
    info: result.info,
    bounds: alphaBounds(result.data, result.info),
    pixelArt: { gridWidth: result.gridWidth, gridHeight: result.gridHeight, colors: result.colors, mode: result.mode },
  };
}

async function applyToning(frame, options) {
  if (!options || Number(options.strength) <= 0) return frame;
  const { data, info } = await sharp(frame.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { ...frame, buffer: await sharp(toneRgba(data, info, options), { raw: info }).png().toBuffer() };
}

async function applyEdgeRefine(frame, options) {
  if (!options || (options.mode === "none" && !options.removeWhiteExterior)) return frame;
  const { data, info } = await sharp(frame.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const refined = refineEdgeRgba(data, info, options);
  return { ...frame, buffer: await sharp(refined, { raw: info }).png().toBuffer(), info, bounds: alphaBounds(refined, info) };
}

async function renderFrames(frames, options) {
  const maxWidth = Math.ceil(Math.max(...frames.map((frame) => frame.bounds.width * (resolveFrameTransform(options, frame.sourceIndex)?.scaleX || 1))));
  const maxHeight = Math.ceil(Math.max(...frames.map((frame) => frame.bounds.height * (resolveFrameTransform(options, frame.sourceIndex)?.scaleY || 1))));
  const anchor = ["ground", "center", "motion", "body"].includes(options.anchor) ? options.anchor : "ground";
  // A long, thin appendage may extend the full bounds without moving the body.
  // Locate the dense core independently of thin tails. Full bounds still determine
  // the cell size, so no pixel of a thread is discarded.
  const bodyPoints = anchor === "body" ? await Promise.all(frames.map(async (frame) => {
    const { data, info } = await sharp(frame.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return findBodyAnchor(data, info);
  })) : [];
  const bodyExtents = anchor === "body" ? frames.reduce((extent, frame, index) => {
    const transform = resolveFrameTransform(options, frame.sourceIndex);
    const point = bodyPoints[index];
    const sx = transform?.scaleX || 1; const sy = transform?.scaleY || 1;
    return {
      left: Math.max(extent.left, (point.x - frame.bounds.left) * sx),
      right: Math.max(extent.right, (frame.bounds.left + frame.bounds.width - point.x) * sx),
      top: Math.max(extent.top, (point.y - frame.bounds.top) * sy),
      bottom: Math.max(extent.bottom, (frame.bounds.top + frame.bounds.height - point.y) * sy),
    };
  }, { left: 0, right: 0, top: 0, bottom: 0 }) : null;
  const requestedPadding = clamp(Math.round(Number(options.padding) || 20), 0, 512);
  // The pixel grid has to divide the cell exactly: otherwise the blocks along the far edge come out
  // one pixel wider than the rest and the sprite looks uneven.
  const pixelSize = Math.max(1, Math.round(Number(options.pixelate?.size) || 1));
  const snapToGrid = (value) => (pixelSize > 1 ? Math.ceil(value / pixelSize) * pixelSize : Math.ceil(value));
  const cellWidth = options.autoSize
    ? clamp(snapToGrid((bodyExtents ? Math.max(maxWidth, 2 * Math.max(bodyExtents.left, bodyExtents.right)) : maxWidth) + requestedPadding * 2), 64, 4096)
    : clamp(snapToGrid(Math.round(Number(options.cellWidth) || 600)), 64, 4096);
  const cellHeight = options.autoSize
    ? clamp(snapToGrid((bodyExtents ? Math.max(maxHeight, 2 * Math.max(bodyExtents.top, bodyExtents.bottom)) : maxHeight) + requestedPadding * 2), 64, 4096)
    : clamp(snapToGrid(Math.round(Number(options.cellHeight) || 400)), 64, 4096);
  const padding = clamp(requestedPadding, 0, Math.floor(Math.min(cellWidth, cellHeight) / 3));
  const background = options.outputBackground === "white"
    ? { r: 255, g: 255, b: 255, alpha: 1 }
    : { r: 0, g: 0, b: 0, alpha: 0 };
  const scale = Math.min(
    options.autoSize ? 1 : Infinity,
    (cellWidth - padding * 2) / Math.max(1, maxWidth),
    (cellHeight - padding * 2) / Math.max(1, maxHeight),
    bodyExtents ? (cellWidth / 2 - padding) / Math.max(1, bodyExtents.left, bodyExtents.right) : Infinity,
    bodyExtents ? (cellHeight / 2 - padding) / Math.max(1, bodyExtents.top, bodyExtents.bottom) : Infinity,
  );
  const kernel = options.pixelPerfect ? sharp.kernel.nearest : sharp.kernel.lanczos3;

  const renderOne = async (frame, frameIndex) => {
    let sprite;
    let spriteWidth;
    let spriteHeight;
    let left;
    let top;

    if (anchor === "motion") {
      spriteWidth = Math.max(1, cellWidth - padding * 2);
      spriteHeight = Math.max(1, cellHeight - padding * 2);
      sprite = await sharp(frame.buffer)
        .resize({ width: spriteWidth, height: spriteHeight, fit: "contain", kernel, background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png().toBuffer();
      left = padding;
      top = padding;
    } else {
      const frameScale = options.fitEachFrame && anchor !== "body"
        ? Math.min((cellWidth - padding * 2) / Math.max(1, frame.bounds.width), (cellHeight - padding * 2) / Math.max(1, frame.bounds.height))
        : scale;
      spriteWidth = Math.max(1, Math.round(frame.bounds.width * frameScale));
      spriteHeight = Math.max(1, Math.round(frame.bounds.height * frameScale));
      sprite = await sharp(frame.buffer)
        .extract(frame.bounds)
        .resize({ width: spriteWidth, height: spriteHeight, fit: "fill", kernel })
        .png().toBuffer();
      left = Math.round((cellWidth - spriteWidth) / 2);
      top = anchor === "ground"
        ? cellHeight - padding - spriteHeight
        : Math.round((cellHeight - spriteHeight) / 2);
      if (anchor === "body") {
        const point = bodyPoints[frameIndex];
        left = Math.round(cellWidth / 2 - (point.x - frame.bounds.left) * frameScale);
        top = Math.round(cellHeight / 2 - (point.y - frame.bounds.top) * frameScale);
      }
    }

    const transform = resolveFrameTransform(options, frame.sourceIndex);
    if (transform) {
      return placeTransformedSprite({
        sprite, width: spriteWidth, height: spriteHeight, left, top,
        canvasWidth: cellWidth, canvasHeight: cellHeight, transform, kernel, background,
      });
    }
    const output = await sharp({ create: { width: cellWidth, height: cellHeight, channels: 4, background } })
      .composite([{ input: sprite, left, top }])
      .png().toBuffer();
    return { buffer: output, left, top, width: spriteWidth, height: spriteHeight };
  };

  // Placing frames is pure sharp work with no shared state.
  const rendered = await runPooled(frames, parallelismFor(options), renderOne);
  const bodyAlignment = anchor === "body" ? { method: "dense-core", x: cellWidth / 2, y: cellHeight / 2, referenceDiameter: Math.max(...bodyPoints.map(point => point.radius * 2)) * scale, frames: bodyPoints } : null;
  return { rendered, cellWidth, cellHeight, padding, anchor, bodyAlignment };
}

async function makeAnimatedPreview(framePattern, outputPath, fps, appRoot, signal) {
  const ffmpeg = await resolveBinary("ffmpeg", appRoot);
  try {
    await runProcess(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-framerate", String(clamp(Number(fps) || 8, 1, 60)),
      "-i", framePattern,
      "-loop", "0",
      "-c:v", "libwebp_anim",
      "-lossless", "1",
      "-compression_level", "4",
      outputPath,
    ], { signal });
    return outputPath;
  } catch {
    if (signal?.aborted) throw new Error("Обработка отменена.");
    return null;
  }
}

// ---------------------------------------------------------------------------
// 1.7: render cache, frame timeline, loop modes, atlas planning and exporters.
// ---------------------------------------------------------------------------

const renderCache = new Map();
const RENDER_CACHE_LIMIT = 4;
const RENDER_CACHE_MAX_BYTES = 700 * 1024 * 1024;
const postRenderOptionKeys = new Set([
  "exports", "cleanOutput", "previewFrameIndex", "attachmentPlacements", "columns", "autoColumns",
  "atlasMaxSize", "atlasOverflow", "atlasPowerOfTwo", "packing", "exportFormat", "timeline", "loopMode", "loopRange", "animationName",
  // Scheduling only: the pool width changes nothing about the produced atlas.
  "frameParallelism",
]);
export const exportFormats = ["chuba", "phaser3", "godot", "texturepacker", "unity"];
// The version that ends up inside exported metadata. It lives in one place because it
// used to be duplicated per exporter and would drift on the next release.
const APP_VERSION = "1.8.0";

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

async function fileSignature(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return `${filePath}|${stats.size}|${Math.round(stats.mtimeMs)}`;
  } catch {
    return `${filePath}|missing`;
  }
}

async function renderCacheKey(source, options = {}) {
  const relevant = Object.fromEntries(Object.entries(options).filter(([key]) => !postRenderOptionKeys.has(key)));
  if (source.kind !== "video") delete relevant.fps;
  const files = await Promise.all([
    ...(source.paths || []),
    ...Object.values(options.frameOverrides || {}),
    ...(options.auxAI?.inpaintMaskPath ? [options.auxAI.inpaintMaskPath] : []),
  ].map((item) => fileSignature(String(item))));
  return stableStringify({ kind: source.kind, files, options: relevant });
}

function rememberRender(key, built) {
  renderCache.delete(key);
  renderCache.set(key, built);
  let total = [...renderCache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  while (renderCache.size > RENDER_CACHE_LIMIT || (total > RENDER_CACHE_MAX_BYTES && renderCache.size > 1)) {
    const oldest = renderCache.keys().next().value;
    total -= renderCache.get(oldest).bytes;
    renderCache.delete(oldest);
  }
}

// Drops every cache the processor keeps. Diagnostic tools need this between runs: otherwise
// the keyed frames and the extracted video frames are reused and a comparison measures nothing.
export function clearRenderCache() {
  renderCache.clear();
  frameKeyCache.clear();
  videoFrameCache.clear();
}

async function buildAnimation({ source, options = {}, appRoot, onProgress, signal, tempRoot }) {
  if (!source?.paths?.length) throw new Error("Сначала выберите видео или кадры.");
  const key = await renderCacheKey(source, options);
  const cached = renderCache.get(key);
  if (cached) {
    rememberRender(key, cached);
    onProgress?.({ stage: "reuse", value: 0.7, message: "Использую готовый результат предпросмотра…" });
    return { ...cached, reused: true };
  }
  const startedAt = performance.now();
  const extractedDir = path.join(tempRoot, "source");
  onProgress?.({ stage: "prepare", value: 0.03, message: "Подготавливаю источник…" });
  let inputFrames;
  if (source.kind === "video") {
    const cacheKey = `${await fileSignature(source.paths[0])}|${options.fps}|${options.maxFrames}|${options.trimStart || 0}|${options.trimEnd || 0}`;
    const cachedFrames = videoFrameCache.get(cacheKey);
    inputFrames = cachedFrames?.length && await exists(cachedFrames[0])
      ? cachedFrames
      : await extractVideoFrames(source.paths[0], extractedDir, options.fps, options.maxFrames, appRoot, onProgress, options.trimStart, options.trimEnd, signal);
    videoFrameCache.set(cacheKey, inputFrames);
    if (videoFrameCache.size > 6) videoFrameCache.delete(videoFrameCache.keys().next().value);
  } else {
    inputFrames = [...source.paths].sort(naturalCompare).slice(0, clamp(Number(options.maxFrames) || 192, 1, 1000));
  }
  const extractedAt = performance.now();
  if (!inputFrames.length) throw new Error("Не удалось получить ни одного кадра.");
  if (options.frameOverrides && typeof options.frameOverrides === "object") {
    inputFrames = await Promise.all(inputFrames.map(async (framePath, index) => {
      const overridePath = options.frameOverrides[index];
      return overridePath && await exists(overridePath) ? overridePath : framePath;
    }));
  }

  const attachmentPlacements = await trackAttachmentPlacements(inputFrames, options.attachments || [], { onProgress, signal });
  const trackedAt = performance.now();

  const auxiliary = options.auxAI || {};
  const lama = auxiliary.inpaintMaskPath ? await auxiliarySession("lama", options, appRoot) : null;
  const esrgan = auxiliary.upscale ? await auxiliarySession("real-esrgan", options, appRoot) : null;
  const rife = auxiliary.interpolate ? await auxiliarySession("rife", options, appRoot) : null;
  if (rife && Number(options.fps || 8) > 30) throw new Error("RIFE: задайте FPS не выше 30 до интерполяции (после неё частота удвоится).");

  const prepared = [];
  const aiFrameMetrics = [];
  const skipped = { empty: 0, duplicates: 0, excluded: 0, emptyIndexes: [], duplicateIndexes: [] };
  const excludedFrames = new Set((options.excludedFrames || []).map(Number));
  const pixelateOptions = options.pixelate && Number(options.pixelate.size) > 1 ? options.pixelate : null;
  let previousHash = null;
  // Keep at most `parallelism` frames in flight: order is preserved and memory stays bounded.
  // Neural inference shares one session and stays serial, because running it concurrently is
  // explicitly unsupported on DirectML.
  const parallelism = lama || esrgan ? 1 : parallelismFor(options);
  const inFlight = new Map();
  let nextToSchedule = 0;
  const prepareFrame = async (index) => {
    let framePath = inputFrames[index];
    if (lama) {
      throwIfAborted(signal);
      const filled = await inpaintLama(lama, framePath, auxiliary.inpaintMaskPath);
      framePath = path.join(tempRoot, `inpaint-${index}.png`);
      await fs.mkdir(tempRoot, { recursive: true });
      await fs.writeFile(framePath, filled.buffer);
    }
    let keyed = await keyFrame(framePath, options.keyMode || "auto", options.tolerance ?? 28, options.blackOutline ?? 3, options.blackFeather ?? 0, {
      appRoot, frameIndex: index, aiCutoff: options.aiCutoff, aiSoftness: options.aiSoftness,
      aiEdits: options.aiEdits, keyScope: options.keyScope, fringeCleanup: options.fringeCleanup, fringeStrength: options.fringeStrength,
      edgeDecontaminate: options.edgeDecontaminate, keyColor: options.keyColor, aiProvider: options.aiProvider,
      aiForceModel: options.aiForceModel, aiQuality: options.aiQuality, aiModel: options.aiModel, aiModelDirs: options.aiModelDirs,
    });
    if (options.edgeRefine) keyed = await applyEdgeRefine(keyed, options.edgeRefine);
    keyed = await compositeAttachments(keyed, attachmentPlacements[index]);
    if (esrgan) {
      throwIfAborted(signal);
      const enlarged = await upscaleEsrgan(esrgan, keyed.buffer);
      const { data, info } = await sharp(enlarged.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      keyed = { ...keyed, buffer: enlarged.buffer, info, bounds: alphaBounds(data, info) };
    }
    // Pixel art runs after the background is gone, otherwise the palette would repaint the
    // background instead of the sprite. Per frame, so it stays inside the same pool.
    if (pixelateOptions) keyed = await applyPixelation(keyed, pixelateOptions);
    if (options.toning) keyed = await applyToning(keyed, options.toning);
    return keyed;
  };
  for (let index = 0; index < inputFrames.length; index += 1) {
    throwIfAborted(signal);
    while (nextToSchedule < inputFrames.length && nextToSchedule < index + parallelism) {
      if (!excludedFrames.has(nextToSchedule)) inFlight.set(nextToSchedule, prepareFrame(nextToSchedule).then(result => ({ result }), error => ({ error })));
      nextToSchedule += 1;
    }
    if (excludedFrames.has(index)) {
      skipped.excluded += 1;
      continue;
    }
    const outcome = await inFlight.get(index);
    inFlight.delete(index);
    if (outcome.error) {
      // Neighbours that were already scheduled must settle before the job reports
      // a failure, otherwise they keep decoding into a workspace nobody reads.
      await Promise.allSettled([...inFlight.values()]);
      inFlight.clear();
      throw outcome.error;
    }
    const keyed = outcome.result;
    if (keyed.aiMetrics) aiFrameMetrics.push({ sourceIndex: index, ...keyed.aiMetrics });
    if (!keyed.bounds) {
      skipped.empty += 1;
      skipped.emptyIndexes.push(index);
      continue;
    }
    if (options.removeDuplicates) {
      const hash = await exactFrameHash(keyed.buffer);
      if (hash === previousHash) {
        skipped.duplicates += 1;
        skipped.duplicateIndexes.push(index);
        continue;
      }
      previousHash = hash;
    }
    prepared.push({ sourcePath: inputFrames[index], sourceIndex: index, ...keyed });
    onProgress?.({
      stage: "key",
      value: 0.16 + (index + 1) / inputFrames.length * 0.34,
      message: `${keyed.aiFastPath ? "Быстро очищаю фон" : options.keyMode === "ai" ? "ИИ выделяет объект" : "Очищаю фон"} · ${index + 1}/${inputFrames.length}`,
    });
  }
  if (!prepared.length) throw new Error("После удаления фона не осталось ни одного непустого кадра. Уменьшите допуск цвета.");

  if (rife && prepared.length > 1) {
    const withIntermediate = [];
    for (let index = 0; index < prepared.length; index += 1) {
      throwIfAborted(signal);
      const first = prepared[index];
      withIntermediate.push(first);
      const second = prepared[index + 1];
      if (!second || second.sourceIndex !== first.sourceIndex + 1) continue;
      const middle = await interpolateRife(rife, first.buffer, second.buffer);
      const { data, info } = await sharp(middle.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      withIntermediate.push({ ...first, sourceIndex: first.sourceIndex + 0.5, sourcePath: null, buffer: middle.buffer, info, bounds: alphaBounds(data, info) });
      onProgress?.({ stage: "interpolate", value: 0.52, message: `RIFE · ${index + 1}/${prepared.length - 1}` });
    }
    prepared.splice(0, prepared.length, ...withIntermediate);
  }

  const keyedAt = performance.now();
  const report = makeReport(prepared, skipped, options.keyMode || "auto");
  const warnings = [...report.warnings];
  const frameIssues = [...(report.frameIssues || [])];
  const addWarning = (message, frameIndex = null) => {
    if (warnings.includes(message)) return;
    warnings.push(message);
    if (frameIndex != null) frameIssues.push({ frameIndex, message });
  };
  if (source.kind === "sheet") {
    const drop = /ширина силуэта|высота силуэта|касается края исходного изображения/;
    for (let index = warnings.length - 1; index >= 0; index -= 1) if (drop.test(warnings[index])) warnings.splice(index, 1);
    for (let index = frameIssues.length - 1; index >= 0; index -= 1) if (drop.test(frameIssues[index].message)) frameIssues.splice(index, 1);
  }
  for (const frame of prepared) {
    if ((frame.maskTracking || []).some((tracking) => !tracking.matched || tracking.confidence < 0.18)) {
      addWarning(`Кадр ${frame.sourceIndex + 1}: умная область не найдена уверенно.`, frame.sourceIndex);
    }
    for (const placement of attachmentPlacements[frame.sourceIndex] || []) {
      if ((placement.points || []).some((point) => Number(point.confidence) < 0.22)) {
        addWarning(`Кадр ${frame.sourceIndex + 1}: низкая уверенность привязки PNG «${placement.title || "элемент"}».`, frame.sourceIndex);
      }
    }
  }
  for (const metrics of aiFrameMetrics) {
    if (metrics.coverage > 0.9) {
      addWarning(`Кадр ${metrics.sourceIndex + 1}: ИИ-маска занимает ${Math.round(metrics.coverage * 100)}% кадра — фон, скорее всего, не отделился.`, metrics.sourceIndex);
    } else if (metrics.coverage < 0.005) {
      addWarning(`Кадр ${metrics.sourceIndex + 1}: ИИ-маска почти пуста — объект не найден.`, metrics.sourceIndex);
    }
  }
  report.warnings = warnings.slice(0, 100);
  const keptWarnings = new Set(report.warnings);
  report.frameIssues = frameIssues.filter((issue) => keptWarnings.has(issue.message));
  onProgress?.({ stage: "normalize", value: 0.55, message: "Выравниваю кадры…" });
  const normalized = await renderFrames(prepared, options);
  const seamWarning = await warnLoopSeam(normalized.rendered, prepared, options);
  if (seamWarning && !report.warnings.includes(seamWarning)) report.warnings.push(seamWarning);
  const normalizedAt = performance.now();
  report.timingsMs = { extract: Math.round(extractedAt - startedAt), tracking: Math.round(trackedAt - extractedAt), key: Math.round(keyedAt - trackedAt), normalize: Math.round(normalizedAt - keyedAt) };
  // Which accelerator actually ran belongs in the report: DirectML and the processor can differ
  // by a hair on soft edges, so two machines reproducing the same recipe need to know.
  if ((options.keyMode || "auto") === "ai") report.aiProvider = currentAIProvider();
  // The full picture of what the model did: which mode ran, how many tiles and whether the
  // threshold was chosen automatically. It turns "the mask looks off" into something checkable.
  if (aiFrameMetrics.length) {
    report.ai = {
      provider: aiFrameMetrics[0].provider,
      quality: aiFrameMetrics[0].quality,
      tiles: aiFrameMetrics[0].tiles,
      tta: aiFrameMetrics[0].tta,
      autoThreshold: aiFrameMetrics[0].autoThreshold,
      thresholds: [...new Set(aiFrameMetrics.map((item) => item.threshold))],
      coverage: {
        min: Math.round(Math.min(...aiFrameMetrics.map((item) => item.coverage)) * 1000) / 1000,
        max: Math.round(Math.max(...aiFrameMetrics.map((item) => item.coverage)) * 1000) / 1000,
      },
    };
  }
  if (lama || esrgan || rife || auxiliary.depth) report.aiStages = {
    lama: Boolean(lama), rife: Boolean(rife), realEsrgan: Boolean(esrgan), depthAnythingV2: Boolean(auxiliary.depth),
  };
  const built = {
    key,
    inputFrames,
    skipped,
    attachmentPlacements,
    prepared: prepared.map(({ sourcePath, sourceIndex, bounds }) => ({ sourcePath, sourceIndex, bounds })),
    report,
    normalized,
    auxiliary: { inpaint: Boolean(lama), upscale: Boolean(esrgan), interpolate: Boolean(rife), depth: Boolean(auxiliary.depth) },
    bytes: normalized.rendered.reduce((sum, frame) => sum + frame.buffer.length, 0),
  };
  rememberRender(key, built);
  return { ...built, reused: false };
}

export function buildSequence(prepared, options = {}) {
  const fps = clamp(Number(options.fps) || 8, 1, 60);
  const baseDurationMs = Math.round(1000 / fps);
  const byIndex = new Map(prepared.map((frame, index) => [frame.sourceIndex, index]));
  const sequence = [];
  const used = new Set();
  if (Array.isArray(options.timeline) && options.timeline.length) {
    for (const entry of options.timeline) {
      const image = byIndex.get(Number(entry?.src));
      if (image == null) continue;
      used.add(image);
      const custom = Number(entry.durationMs);
      const hasCustom = Number.isFinite(custom) && custom > 0;
      sequence.push({ image, durationMs: hasCustom ? clamp(Math.round(custom), 10, 10000) : baseDurationMs, custom: hasCustom });
    }
  }
  prepared.forEach((_frame, image) => {
    if (!used.has(image)) sequence.push({ image, durationMs: baseDurationMs, custom: false });
  });
  return { sequence, fps, baseDurationMs };
}

export function resolveLoop(options = {}, length = 1) {
  const mode = ["loop", "pingpong", "range"].includes(options.loopMode) ? options.loopMode : "loop";
  const last = Math.max(0, length - 1);
  let from = 0;
  let to = last;
  if (mode === "range") {
    from = clamp(Math.round(Number(options.loopRange?.from) || 0), 0, last);
    const requestedTo = options.loopRange?.to == null ? last : Math.round(Number(options.loopRange.to));
    to = clamp(Number.isFinite(requestedTo) ? requestedTo : last, from, last);
  }
  return { mode, from, to };
}

export function playbackOrder(length, loop) {
  const range = [];
  for (let index = loop.from; index <= loop.to && index < length; index += 1) range.push(index);
  if (loop.mode === "pingpong" && range.length > 2) return [...range, ...range.slice(1, -1).reverse()];
  return range;
}

function layoutAtlas(groups, { packing, limitW = 0, limitH = 0, columnsOverride = null, gap = 2 }) {
  const pages = [];
  let page = { width: 0, height: 0, rects: [] };
  const pushPage = () => { if (page.rects.length) pages.push(page); page = { width: 0, height: 0, rects: [] }; };
  if (packing === "tight") {
    const items = groups.flatMap((group) => group.items);
    const totalArea = items.reduce((sum, item) => sum + (item.width + gap) * (item.height + gap), 0);
    const widest = Math.max(1, ...items.map((item) => item.width));
    const pageWidth = limitW || Math.max(widest, Math.ceil(Math.sqrt(totalArea * 1.15)));
    const ordered = [...items].sort((a, b) => b.height - a.height || b.width - a.width);
    let x = 0; let y = 0; let shelf = 0;
    for (const item of ordered) {
      if (x > 0 && x + item.width > pageWidth) { y += shelf + gap; x = 0; shelf = 0; }
      if (limitH && y + item.height > limitH && page.rects.length) { pushPage(); x = 0; y = 0; shelf = 0; }
      page.rects.push({ item, x, y });
      x += item.width + gap;
      shelf = Math.max(shelf, item.height);
      page.width = Math.max(page.width, x - gap);
      page.height = Math.max(page.height, y + item.height);
    }
    pushPage();
    return pages;
  }
  let y = 0;
  for (const group of groups) {
    let columns = columnsOverride?.(group) ?? group.columns;
    if (limitW) columns = Math.max(1, Math.min(columns, Math.floor(limitW / group.cellWidth)));
    for (let start = 0; start < group.items.length; start += columns) {
      if (limitH && y + group.cellHeight > limitH && page.rects.length) { pushPage(); y = 0; }
      group.items.slice(start, start + columns).forEach((item, column) => {
        page.rects.push({ item, x: column * group.cellWidth, y });
        page.width = Math.max(page.width, (column + 1) * group.cellWidth);
      });
      y += group.cellHeight;
      page.height = Math.max(page.height, y);
    }
    group.layoutColumns = columns;
  }
  pushPage();
  return pages;
}

function scaleHitbox(hitbox, scale) {
  if (!hitbox) return null;
  return { x: Math.round(hitbox.x * scale), y: Math.round(hitbox.y * scale), width: Math.max(1, Math.round(hitbox.width * scale)), height: Math.max(1, Math.round(hitbox.height * scale)) };
}

function scaleGroups(groups, scale) {
  return groups.map((group) => ({
    ...group,
    cellWidth: Math.max(1, Math.floor(group.cellWidth * scale)),
    cellHeight: Math.max(1, Math.floor(group.cellHeight * scale)),
    items: group.items.map((item) => ({ ...item, width: Math.max(1, Math.floor(item.width * scale)), height: Math.max(1, Math.floor(item.height * scale)), hitbox: scaleHitbox(item.hitbox, scale) })),
  }));
}

function pagesExceed(pages, limit) {
  return Boolean(limit) && pages.some((page) => page.width > limit || page.height > limit);
}

function floorPowerOfTwo(value) {
  let size = 1;
  while (size * 2 <= value) size *= 2;
  return size;
}

function padAtlasPages(pages, powerOfTwo) {
  if (!powerOfTwo) return pages;
  const ceilPowerOfTwo = (value) => {
    let size = 1;
    while (size < value) size *= 2;
    return size;
  };
  return pages.map((page) => ({ ...page, width: ceilPowerOfTwo(page.width), height: ceilPowerOfTwo(page.height) }));
}

export function planAtlas(groups, { packing = "grid", maxSize = 0, overflow = "warn", powerOfTwo = false } = {}) {
  const limit = Number(maxSize) > 0 ? Number(maxSize) : 0;
  // A non-power-of-two CLI limit (for example 3000) can only fit a 2048 page.
  const layoutLimit = limit && powerOfTwo ? floorPowerOfTwo(limit) : limit;
  const tight = packing === "tight";
  const layout = (plannedGroups, settings) => padAtlasPages(layoutAtlas(plannedGroups, settings), powerOfTwo);
  const natural = layout(groups, { packing, limitW: tight ? layoutLimit : 0 });
  const naturalWidth = Math.max(...natural.map((page) => page.width));
  const naturalHeight = natural.reduce((sum, page) => Math.max(sum, page.height), 0);
  const exceeds = pagesExceed(natural, limit);
  const base = { exceeds, limit, naturalWidth, naturalHeight, requested: overflow, powerOfTwo: Boolean(powerOfTwo) };
  if (!exceeds || !limit || overflow === "warn") {
    return { ...base, pages: natural, groups, scale: 1, applied: exceeds ? "warn" : "none", note: exceeds ? `Лист ${naturalWidth}×${naturalHeight} больше ${limit} px` : "" };
  }
  const largestItem = Math.max(...groups.flatMap((group) => group.items.map((item) => Math.max(item.width, item.height))));
  if (overflow === "columns" && !tight) {
    const pages = layout(groups, { packing, columnsOverride: (group) => Math.max(1, Math.floor(layoutLimit / group.cellWidth)) });
    if (!pagesExceed(pages, limit)) return { ...base, pages, groups, scale: 1, applied: "columns", note: "Столбцы пересчитаны под лимит" };
  }
  if (overflow === "scale") {
    let scale = Math.min(1, layoutLimit / Math.max(1, naturalWidth), layoutLimit / Math.max(1, naturalHeight));
    if (tight) scale = Math.min(1, Math.sqrt((layoutLimit * layoutLimit) / Math.max(1, naturalWidth * naturalHeight)));
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const scaledGroups = scaleGroups(groups, scale);
      const pages = layout(scaledGroups, { packing, limitW: tight ? layoutLimit : 0 });
      if (!pagesExceed(pages, limit) && pages.length === 1) {
        return { ...base, pages, groups: scaledGroups, scale, applied: "scale", note: `Кадры уменьшены до ${Math.round(scale * 100)}%` };
      }
      scale *= 0.94;
    }
  }
  // Split into several pages; a single frame larger than the limit is scaled down first.
  const scale = largestItem > layoutLimit ? layoutLimit / largestItem : 1;
  const scaledGroups = scale < 1 ? scaleGroups(groups, scale) : groups;
  const pages = layout(scaledGroups, { packing, limitW: layoutLimit, limitH: layoutLimit });
  const note = overflow === "columns" && !tight ? "Столбцы не помогли — лист разбит на страницы" : `Разбито на листов: ${pages.length}`;
  return { ...base, pages, groups: scaledGroups, scale, applied: "split", note: scale < 1 ? `${note} · кадры уменьшены до ${Math.round(scale * 100)}%` : note };
}

// A pixel belongs to the sprite hitbox above this alpha. Trimming uses a lower
// threshold so the faint anti-aliased ring around the silhouette is not cut away.
const ALPHA_HITBOX = 16;
const ALPHA_TRIM = 0;

// One decode per rendered cell: the same pixels yield both the hitbox (cell
// coordinates) and the trimming rectangle. Decoding a 4K cell twice for the same
// data was the most expensive part of packing.
async function inspectRenderedCell(buffer) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const hitboxBounds = alphaBounds(data, info, ALPHA_HITBOX);
  return {
    info,
    hitbox: hitboxBounds ? { x: hitboxBounds.left, y: hitboxBounds.top, width: hitboxBounds.width, height: hitboxBounds.height } : null,
    trimBounds: alphaBounds(data, info, ALPHA_TRIM),
  };
}

async function trimRendered(buffer, trimBounds) {
  const bounds = trimBounds || (await inspectRenderedCell(buffer)).trimBounds || { left: 0, top: 0, width: 1, height: 1 };
  const trimmed = await sharp(buffer).extract(bounds).png().toBuffer();
  return { buffer: trimmed, bounds };
}

async function makeSequencePreview(imagePaths, order, sequence, outputPath, fps, appRoot, signal) {
  if (!order.length) return null;
  const listDir = path.dirname(imagePaths[0]);
  const listPath = path.join(listDir, `.sequence-${crypto.randomUUID()}.ffconcat`);
  const lines = ["ffconcat version 1.0"];
  for (const position of order) {
    const entry = sequence[position];
    lines.push(`file '${path.relative(listDir, imagePaths[entry.image]).replace(/\\/g, "/").replace(/'/g, "")}'`);
    lines.push(`duration ${(entry.durationMs / 1000).toFixed(3)}`);
  }
  lines.push(`file '${path.relative(listDir, imagePaths[sequence[order.at(-1)].image]).replace(/\\/g, "/").replace(/'/g, "")}'`);
  await fs.writeFile(listPath, `${lines.join("\n")}\n`, "utf8");
  const ffmpeg = await resolveBinary("ffmpeg", appRoot);
  try {
    await runProcess(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "concat", "-safe", "0", "-i", listPath,
      "-fps_mode", "vfr",
      "-loop", "0", "-c:v", "libwebp_anim", "-lossless", "1", "-compression_level", "4",
      outputPath,
    ], { signal });
    return outputPath;
  } catch {
    if (signal?.aborted) throw new Error("Обработка отменена.");
    // Older FFmpeg builds: fall back to a constant-rate preview of the ordered frames.
    const fallbackDir = path.join(listDir, `.ordered-${crypto.randomUUID()}`);
    await fs.mkdir(fallbackDir, { recursive: true });
    for (const [index, position] of order.entries()) {
      await fs.copyFile(imagePaths[sequence[position].image], path.join(fallbackDir, `${String(index).padStart(4, "0")}.png`));
    }
    return makeAnimatedPreview(path.join(fallbackDir, "%04d.png"), outputPath, fps, appRoot, signal);
  } finally {
    await fs.rm(listPath, { force: true }).catch(() => {});
  }
}

function frameName(prefix, index) {
  return `${prefix}_${String(index).padStart(4, "0")}`;
}

function describeFrames(animations, atlas, pageFiles) {
  const rectByItem = new Map();
  atlas.pages.forEach((page, pageIndex) => page.rects.forEach((rect) => rectByItem.set(rect.item, { ...rect, page: pageIndex })));
  const frames = [];
  const tags = [];
  for (const animation of animations) {
    const from = frames.length;
    const group = atlas.groups[animation.groupIndex];
    animation.sequence.forEach((entry, position) => {
      const item = group.items[entry.image];
      const rect = rectByItem.get(item);
      frames.push({
        name: frameName(animation.prefix, position),
        animation: animation.name,
        position,
        sourceFrameIndex: animation.prepared[entry.image].sourceIndex,
        sourceName: animation.source.sheetFrameNames?.[animation.prepared[entry.image].sourceIndex] || null,
        sourceRect: animation.source.sheetCells?.[animation.prepared[entry.image].sourceIndex] || null,
        page: rect.page,
        image: pageFiles[rect.page],
        x: rect.x, y: rect.y, width: item.width, height: item.height,
        trimmed: Boolean(item.trimmed),
        spriteSourceSize: { x: item.offsetX, y: item.offsetY, w: item.width, h: item.height },
        sourceSize: { w: group.cellWidth, h: group.cellHeight },
        durationMs: entry.durationMs,
        pivot: animation.pivot,
        hitbox: item.hitbox || null,
        // The hitbox lives in cell coordinates, the same space as sourceSize.
        hitboxSpace: "cell",
        transform: resolveFrameTransform(animation.options, animation.prepared[entry.image].sourceIndex),
      });
    });
    tags.push({
      name: animation.name,
      from,
      to: frames.length - 1,
      direction: animation.loop.mode === "pingpong" ? "pingpong" : "forward",
      loop: animation.loop,
      fps: animation.fps,
      frameCount: animation.sequence.length,
      cellWidth: group.cellWidth,
      cellHeight: group.cellHeight,
      pivot: animation.pivot,
      anchor: animation.anchor,
    });
  }
  return { frames, tags };
}

function tagFrames(frames, tag) {
  const list = frames.slice(tag.from, tag.to + 1);
  const order = playbackOrder(list.length, tag.loop);
  return order.map((position) => list[position]);
}

function phaserFiles(spriteName, frames, tags, atlas, pageFiles) {
  const textures = atlas.pages.map((page, pageIndex) => ({
    image: pageFiles[pageIndex],
    format: "RGBA8888",
    size: { w: page.width, h: page.height },
    scale: 1,
    frames: frames.filter((frame) => frame.page === pageIndex).map((frame) => ({
      filename: frame.name,
      rotated: false,
      trimmed: frame.trimmed,
      sourceSize: frame.sourceSize,
      spriteSourceSize: frame.spriteSourceSize,
      frame: { x: frame.x, y: frame.y, w: frame.width, h: frame.height },
      pivot: frame.pivot,
    })),
  }));
  const anims = tags.map((tag) => {
    const base = Math.round(1000 / tag.fps);
    return {
      key: tag.name,
      type: "frame",
      frames: tagFrames(frames, tag).map((frame) => ({ key: spriteName, frame: frame.name, duration: Math.max(0, frame.durationMs - base) })),
      frameRate: tag.fps,
      repeat: -1,
      yoyo: false,
    };
  });
  return [
    { file: `${spriteName}.phaser.json`, content: { textures, meta: { app: "Chuba Sprite Lab", version: APP_VERSION, note: `this.load.multiatlas('${spriteName}', '${spriteName}.phaser.json')` } } },
    { file: `${spriteName}.phaser-anims.json`, content: { anims } },
  ];
}

function texturePackerFiles(spriteName, frames, tags, atlas, pageFiles) {
  return atlas.pages.map((page, pageIndex) => {
    const pageFrames = {};
    frames.filter((frame) => frame.page === pageIndex).forEach((frame) => {
      pageFrames[`${frame.name}.png`] = {
        frame: { x: frame.x, y: frame.y, w: frame.width, h: frame.height },
        rotated: false,
        trimmed: frame.trimmed,
        spriteSourceSize: frame.spriteSourceSize,
        sourceSize: frame.sourceSize,
        duration: frame.durationMs,
        pivot: frame.pivot,
      };
    });
    return {
      file: atlas.pages.length === 1 ? `${spriteName}.texturepacker.json` : `${spriteName}-${pageIndex}.texturepacker.json`,
      content: {
        frames: pageFrames,
        meta: {
          app: "Chuba Sprite Lab",
          version: APP_VERSION,
          image: pageFiles[pageIndex],
          format: "RGBA8888",
          size: { w: page.width, h: page.height },
          scale: String(atlas.scale || 1),
          frameTags: pageIndex === 0 ? tags.map((tag) => ({ name: tag.name, from: tag.from, to: tag.to, direction: tag.direction })) : [],
        },
      },
    };
  });
}

function godotFile(spriteName, frames, tags, atlas, pageFiles) {
  const lines = [];
  const subResources = [];
  const subIds = new Map();
  const animationBlocks = tags.map((tag) => {
    const base = 1000 / tag.fps;
    const entries = tagFrames(frames, tag).map((frame) => {
      if (!subIds.has(frame.name)) {
        const id = `AtlasTexture_${subIds.size}`;
        subIds.set(frame.name, id);
        const marginW = frame.sourceSize.w - frame.width;
        const marginH = frame.sourceSize.h - frame.height;
        subResources.push([
          `[sub_resource type="AtlasTexture" id="${id}"]`,
          `atlas = ExtResource("${frame.page + 1}_sheet")`,
          `region = Rect2(${frame.x}, ${frame.y}, ${frame.width}, ${frame.height})`,
          frame.trimmed ? `margin = Rect2(${frame.spriteSourceSize.x}, ${frame.spriteSourceSize.y}, ${marginW}, ${marginH})` : null,
          "",
        ].filter((line) => line !== null).join("\n"));
      }
      return `{\n"duration": ${(frame.durationMs / base).toFixed(3)},\n"texture": SubResource("${subIds.get(frame.name)}")\n}`;
    });
    return `{\n"frames": [${entries.join(", ")}],\n"loop": true,\n"name": &"${tag.name.replace(/"/g, "")}",\n"speed": ${tag.fps.toFixed(1)}\n}`;
  });
  lines.push(`[gd_resource type="SpriteFrames" load_steps=${atlas.pages.length + subResources.length + 1} format=3]`, "");
  pageFiles.forEach((file, index) => lines.push(`[ext_resource type="Texture2D" path="res://${file}" id="${index + 1}_sheet"]`));
  lines.push("", ...subResources, "[resource]", `animations = [${animationBlocks.join(", ")}]`, "");
  return { file: `${spriteName}.tres`, text: lines.join("\n") };
}

// Collision data for engine exports. Godot's .tres only accepts known resource
// properties, and the Phaser/TexturePacker consumers vary in how strictly they read
// their JSON, so the hitbox ships as a sidecar for every engine format instead of
// being folded into one of them. It is the part a platformer actually needs.
// Unity keeps frames in a .meta asset rather than in the JSON, and a .meta cannot be hand-written
// safely (it links to the texture by GUID). What is genuinely missing there is the slicing step
// itself, so the export is a small editor script with the rectangles already converted.
//
// Two conversions matter and both live here, where they can be tested:
//   * Unity's rectangle origin is the bottom-left corner, the manifest's is the top-left;
//   * Unity's pivot is normalised inside the sprite rectangle, while the manifest describes it in
//     cell coordinates.
function unitySlicerFile(spriteName, frames, atlas, pageFiles) {
  const rows = frames.map((frame) => {
    const page = atlas.pages[frame.page];
    const rectY = Math.max(0, page.height - frame.y - frame.height);
    const sprite = frame.spriteSourceSize || { x: 0, y: 0, w: frame.width, h: frame.height };
    const cellWidth = frame.sourceSize?.w || frame.width;
    const cellHeight = frame.sourceSize?.h || frame.height;
    // The manifest pivot counts from the top of the cell, Unity counts from the bottom of the sprite.
    const fromCellTop = (frame.pivot?.y ?? 1) * cellHeight;
    const pivotX = clamp((((frame.pivot?.x ?? 0.5) * cellWidth) - sprite.x) / Math.max(1, sprite.w), 0, 1);
    const pivotY = clamp((sprite.y + sprite.h - fromCellTop) / Math.max(1, sprite.h), 0, 1);
    return { name: frame.name, x: frame.x, y: rectY, w: frame.width, h: frame.height, pivotX, pivotY, page: frame.page };
  });

  const lines = [
    "// Сгенерировано Chuba Sprite Lab. Положите файл рядом с PNG внутри Assets/.",
    "// Меню: Tools ▸ Chuba Sprite Lab ▸ Нарезать " + spriteName,
    "//",
    "// Прямоугольники уже переведены в координаты Unity: начало отсчёта снизу слева.",
    "// Точка опоры пересчитана из координат ячейки в координаты обрезанного спрайта.",
    "// Если точка опоры оказалась вне обрезанного прямоугольника, она ограничена его краем:",
    "// Unity не принимает опору за пределами спрайта.",
    "using System.Collections.Generic;",
    "using UnityEditor;",
    "using UnityEngine;",
    "",
    "public static class ChubaSlicer_" + spriteName.replace(/[^A-Za-z0-9_]/g, "_"),
    "{",
    "    private sealed class Slice",
    "    {",
    "        public string name;",
    "        public float x, y, w, h, pivotX, pivotY;",
    "    }",
    "",
    "    [MenuItem(\"Tools/Chuba Sprite Lab/Нарезать " + spriteName + "\")]",
    "    public static void Slice()",
    "    {",
    "        var slices = new List<Slice>",
    "        {",
  ];
  for (const row of rows) {
    lines.push(`            new Slice { name = "${row.name}", x = ${row.x}f, y = ${row.y}f, w = ${row.w}f, h = ${row.h}f, pivotX = ${row.pivotX.toFixed(4)}f, pivotY = ${row.pivotY.toFixed(4)}f },`);
  }
  lines.push(
    "        };",
    "",
    "        string[] sheets = { " + pageFiles.map((file) => `"${file}"`).join(", ") + " };",
    "        foreach (string sheet in sheets)",
    "        {",
    "            string path = FindSheet(sheet);",
    "            if (path == null) { Debug.LogWarning(\"Chuba Sprite Lab: не найден \" + sheet); continue; }",
    "            var importer = (TextureImporter)AssetImporter.GetAtPath(path);",
    "            importer.textureType = TextureImporterType.Sprite;",
    "            importer.spriteImportMode = SpriteImportMode.Multiple;",
    "            var texture = new Texture2D(2, 2);",
    "            texture.LoadImage(System.IO.File.ReadAllBytes(path));",
    "            float height = texture.height;",
    "            Object.DestroyImmediate(texture);",
    "            var metadatas = new List<SpriteMetaData>();",
    "            foreach (var slice in slices)",
    "            {",
    "                metadatas.Add(new SpriteMetaData",
    "                {",
    "                    name = slice.name,",
    "                    // Координаты уже снизу слева, поэтому высота листа здесь не нужна.",
    "                    rect = new Rect(slice.x, slice.y, slice.w, slice.h),",
    "                    alignment = SpriteAlignment.Custom,",
    "                    pivot = new Vector2(slice.pivotX, slice.pivotY),",
    "                });",
    "            }",
    "            metadatas.RemoveAll(metadata => !sheets[0].Equals(sheet) && metadata.rect.y > height);",
    "            importer.spritesheet = metadatas.ToArray();",
    "            importer.SaveAndReimport();",
    "            Debug.Log(\"Chuba Sprite Lab: нарезано \" + metadatas.Count + \" спрайтов в \" + path);",
    "        }",
    "    }",
    "",
    "    private static string FindSheet(string fileName)",
    "    {",
    "        foreach (string guid in AssetDatabase.FindAssets(fileName + \" t:Texture2D\"))",
    "        {",
    "            string path = AssetDatabase.GUIDToAssetPath(guid);",
    "            if (System.IO.Path.GetFileName(path) == fileName) return path;",
    "        }",
    "        return null;",
    "    }",
    "}",
    "",
  );
  return { file: `${spriteName}.unity-slicer.cs`, text: lines.join("\n") };
}

function hitboxFile(spriteName, frames) {
  return {
    file: `${spriteName}.hitboxes.json`,
    content: {
      meta: {
        app: "Chuba Sprite Lab",
        hitboxSpace: "cell",
        note: "hitbox и pivot заданы в координатах ячейки sourceSize, а не в координатах атласа",
      },
      frames: Object.fromEntries(frames.map((frame) => [frame.name, {
        animation: frame.animation,
        hitbox: frame.hitbox,
        hitboxSpace: frame.hitboxSpace,
        pivot: frame.pivot,
        sourceSize: frame.sourceSize,
        spriteSourceSize: frame.spriteSourceSize,
        durationMs: frame.durationMs,
        trimmed: frame.trimmed,
      }])),
    },
  };
}

async function directorySize(candidate) {
  const stats = await fs.stat(candidate).catch(() => null);
  if (!stats) return 0;
  if (!stats.isDirectory()) return stats.size;
  let total = 0;
  const entries = await fs.readdir(candidate, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) total += await directorySize(path.join(candidate, entry.name));
  return total;
}

// Files a previous run of this tool produced and may safely replace.
async function generatedArtifacts(finalRoot, spriteName) {
  const existing = await fs.readdir(finalRoot).catch(() => []);
  return existing.filter((file) => file === "frames" || (file.startsWith(`${spriteName}.`) || file.startsWith(`${spriteName}-`)) && /\.(png|json|webp|tres)$/i.test(file));
}

// Refuse to touch the previous export when the destination clearly cannot hold the
// new one: a copy that fails half-way through the commit cannot be undone. Renaming
// inside one volume needs no extra room, so only a cross-volume copy is checked.
// The guard is best-effort: a filesystem without statfs simply skips it.
async function assertDestinationSpace({ stagingRoot, finalRoot, spriteName, cleanOutput }) {
  const destination = path.dirname(finalRoot);
  const [staging, target] = await Promise.all([
    fs.stat(stagingRoot).catch(() => null),
    fs.stat(finalRoot).catch(() => fs.stat(destination).catch(() => null)),
  ]);
  if (!staging || !target || staging.dev === target.dev) return;
  const needed = await directorySize(stagingRoot);
  if (!needed) return;
  let reclaimable = 0;
  if (cleanOutput) {
    for (const file of await generatedArtifacts(finalRoot, spriteName)) {
      reclaimable += await directorySize(path.join(finalRoot, file));
    }
  }
  const stats = await fs.statfs(destination).catch(() => null);
  if (!stats) return;
  if (stats.bavail * stats.bsize + reclaimable < needed) {
    throw new Error(`В папке назначения мало места: нужно около ${Math.ceil(needed / 1048576)} МБ. Прежний набор не изменён.`);
  }
}

// A finished export replaces the files of the previous one only after the whole
// job succeeded. Items are renamed when staging and destination share a volume
// and copied otherwise. Images are committed before metadata, so a partial
// commit cannot leave a new manifest pointing at images that are not there yet.
async function commitStagedOutput({ stagingRoot, finalRoot, spriteName, cleanOutput }) {
  await assertDestinationSpace({ stagingRoot, finalRoot, spriteName, cleanOutput });
  await fs.mkdir(finalRoot, { recursive: true });
  if (cleanOutput) {
    for (const file of await generatedArtifacts(finalRoot, spriteName)) {
      await fs.rm(path.join(finalRoot, file), { recursive: true, force: true });
    }
  }
  const entries = await fs.readdir(stagingRoot).catch(() => []);
  const rank = (file) => (file === "frames" ? 0 : /\.(json|tres)$/i.test(file) ? 2 : 1);
  for (const entry of entries.sort((left, right) => rank(left) - rank(right))) {
    const from = path.join(stagingRoot, entry);
    const to = path.join(finalRoot, entry);
    await fs.rm(to, { recursive: true, force: true });
    try {
      await fs.rename(from, to);
    } catch (error) {
      if (error?.code !== "EXDEV") throw error;
      await fs.cp(from, to, { recursive: true });
    }
  }
}

async function runAtlasJob({ animations: animationInputs, outputDir, name, options = {}, previewOnly = false, appRoot, onProgress, signal }) {
  if (!animationInputs?.length) throw new Error("Сначала выберите видео или кадры.");
  throwIfAborted(signal);
  const multi = animationInputs.length > 1;
  const firstSource = animationInputs[0].source;
  if (!firstSource?.paths?.length) throw new Error("Сначала выберите видео или кадры.");
  const spriteName = safeName(name || path.parse(firstSource.title || firstSource.paths[0]).name);
  const jobStartedAt = performance.now();
  const tempRoot = await makeTempWorkspace("chuba-sprite-lab-");
  const requestedExports = {
    sheet: options.exports?.sheet !== false,
    frames: options.exports?.frames !== false,
    metadata: options.exports?.metadata !== false,
    preview: options.exports?.preview !== false,
  };
  if (!previewOnly && !Object.values(requestedExports).some(Boolean)) throw new Error("Выберите хотя бы один формат экспорта.");
  const exportSheet = requestedExports.sheet || requestedExports.metadata;
  const exportFormat = exportFormats.includes(options.exportFormat) ? options.exportFormat : "chuba";
  const finalRoot = previewOnly
    ? path.join(tempRoot, "preview")
    : path.join(outputDir || path.dirname(firstSource.paths[0]), spriteName);
  const workingRoot = previewOnly ? finalRoot : path.join(tempRoot, "working");
  // A finished export must survive a failed rebuild. The whole job is written into
  // a staging folder inside its temporary workspace, and only a fully successful
  // job replaces the files in finalRoot. Deleting the previous export before the
  // build started meant any later error destroyed a good set with nothing to show.
  const stagingRoot = previewOnly ? finalRoot : path.join(tempRoot, "staged");
  const outputRoot = stagingRoot;
  const toFinal = (value) => (previewOnly || !value ? value : path.join(finalRoot, path.relative(stagingRoot, value)));
  await fs.mkdir(stagingRoot, { recursive: true });
  await fs.mkdir(workingRoot, { recursive: true });

  const animations = [];
  const usedNames = new Set();
  for (const [animationIndex, input] of animationInputs.entries()) {
    const animOptions = input.options || options;
    const scaleProgress = (progress) => onProgress?.({
      ...progress,
      value: ((animationIndex + Math.max(0, Math.min(1, Number(progress.value) || 0)) * 0.8) / animationInputs.length),
      message: multi ? `Анимация «${input.name}» · ${progress.message || "обработка"}` : progress.message,
    });
    const built = await buildAnimation({ source: input.source, options: animOptions, appRoot, onProgress: scaleProgress, signal, tempRoot: path.join(tempRoot, `anim-${animationIndex}`) });
    let { sequence, fps, baseDurationMs } = buildSequence(built.prepared, animOptions);
    if (built.auxiliary.interpolate && Array.isArray(animOptions.timeline) && animOptions.timeline.length) {
      const ordered = [];
      const positions = new Map(built.prepared.map((frame, index) => [frame.sourceIndex, index]));
      const used = new Set();
      for (const entry of animOptions.timeline) {
        const image = positions.get(Number(entry.src));
        if (image == null) continue;
        used.add(image);
        const midpoint = positions.get(Number(entry.src) + 0.5);
        const duration = Number(entry.durationMs) > 0 ? Number(entry.durationMs) : baseDurationMs;
        if (midpoint != null) {
          used.add(midpoint);
          ordered.push({ image, durationMs: Math.max(10, Math.round(duration / 2)), custom: true });
          ordered.push({ image: midpoint, durationMs: Math.max(10, Math.round(duration / 2)), custom: true });
        } else ordered.push({ image, durationMs: duration, custom: true });
      }
      for (let index = 0; index < built.prepared.length; index += 1) if (!used.has(index)) ordered.push({ image: index, durationMs: baseDurationMs, custom: false });
      sequence.splice(0, sequence.length, ...ordered);
    } else if (built.auxiliary.interpolate) {
      for (const entry of sequence) entry.durationMs = Math.max(10, Math.round(entry.durationMs / 2));
    }
    if (built.auxiliary.interpolate) {
      fps *= 2;
      baseDurationMs = Math.round(1000 / fps);
    }
    const loop = resolveLoop(animOptions, sequence.length);
    let animName = safeName(input.name || animOptions.animationName || spriteName) || `anim-${animationIndex + 1}`;
    while (usedNames.has(animName)) animName = `${animName}-2`;
    usedNames.add(animName);
    const normalized = built.normalized;
    animations.push({
      name: animName,
      prefix: multi ? animName : spriteName,
      source: input.source,
      options: animOptions,
      built,
      prepared: built.prepared,
      normalized,
      sequence,
      fps,
      baseDurationMs,
      loop,
      anchor: normalized.anchor,
      pivot: normalized.anchor === "ground" ? { x: 0.5, y: 1 - normalized.padding / normalized.cellHeight } : { x: 0.5, y: 0.5 },
    });
  }

  const buildsAt = performance.now();

  // Unique rendered images (one per prepared frame) — used by the UI and the preview.
  onProgress?.({ stage: "images", value: 0.8, message: "Сохраняю кадры…" });
  for (const [animationIndex, animation] of animations.entries()) {
    const imageDir = previewOnly
      ? path.join(finalRoot, multi ? path.join("frames", animation.name) : "frames")
      : path.join(workingRoot, "images", String(animationIndex));
    await fs.mkdir(imageDir, { recursive: true });
    animation.imagePaths = [];
    for (let index = 0; index < animation.normalized.rendered.length; index += 1) {
      throwIfAborted(signal);
      const imagePath = path.join(imageDir, `${String(index).padStart(4, "0")}.png`);
      await fs.writeFile(imagePath, animation.normalized.rendered[index].buffer);
      animation.imagePaths.push(imagePath);
    }
    animation.depthFiles = [];
    if (animation.options.auxAI?.depth) {
      const depth = await auxiliarySession("depth-anything-v2", animation.options, appRoot);
      for (let index = 0; index < animation.imagePaths.length; index += 1) {
        throwIfAborted(signal);
        const map = await estimateDepth(depth, animation.imagePaths[index]);
        const file = `${spriteName}.depth.${animation.name}.${String(index).padStart(4, "0")}.png`;
        await fs.writeFile(path.join(outputRoot, file), map.buffer);
        animation.depthFiles.push(file);
        onProgress?.({ stage: "depth", value: 0.8, message: `Карта глубины · ${index + 1}/${animation.imagePaths.length}` });
      }
    }
  }

  const imagesAt = performance.now();

  // Atlas items.
  const packing = options.packing === "tight" ? "tight" : "grid";
  const groups = [];
  for (const animation of animations) {
    const count = animation.normalized.rendered.length;
    const layoutCount = packing === "grid" ? animation.sequence.length : count;
    const columns = animation.options.autoColumns
      ? Math.max(1, Math.ceil(Math.sqrt(layoutCount)))
      : clamp(Math.round(Number(animation.options.columns) || Math.ceil(Math.sqrt(layoutCount))), 1, Math.max(1, layoutCount));
    // Per-frame sharp work with no shared state: the same bounded pool as the rest of the job.
    const items = await runPooled(
      Array.from({ length: count }, (_value, index) => index),
      parallelismFor(options),
      async (index) => {
        const rendered = animation.normalized.rendered[index];
        const cell = await inspectRenderedCell(rendered.buffer);
        if (packing === "tight") {
          const trimmed = await trimRendered(rendered.buffer, cell.trimBounds);
          return {
            buffer: trimmed.buffer, width: trimmed.bounds.width, height: trimmed.bounds.height,
            offsetX: trimmed.bounds.left, offsetY: trimmed.bounds.top, trimmed: true,
            fullWidth: animation.normalized.cellWidth, fullHeight: animation.normalized.cellHeight,
            hitbox: cell.hitbox, sourceBufferSize: { width: trimmed.bounds.width, height: trimmed.bounds.height },
          };
        }
        return {
          buffer: rendered.buffer, width: animation.normalized.cellWidth, height: animation.normalized.cellHeight,
          offsetX: 0, offsetY: 0, trimmed: false, hitbox: cell.hitbox,
          sourceBufferSize: { width: cell.info.width, height: cell.info.height },
        };
      },
    );
    // Grid keeps the legacy one-cell-per-sequence-frame layout so engines that read
    // only frameWidth/columns keep working; duplicates point to the same image.
    let gridItems = items;
    if (packing === "grid") gridItems = animation.sequence.map((entry) => items[entry.image]);
    groups.push({ items: packing === "grid" ? [...new Set(gridItems)] : items, columns, cellWidth: animation.normalized.cellWidth, cellHeight: animation.normalized.cellHeight, imageItems: items });
    animation.groupIndex = groups.length - 1;
  }
  const itemsAt = performance.now();
  const maxSize = Number(options.atlasMaxSize) || 0;
  const atlas = planAtlas(groups.map((group) => ({ ...group, items: group.items })), { packing, maxSize, overflow: options.atlasOverflow || "warn", powerOfTwo: options.atlasPowerOfTwo === true });
  // Map scaled items back to per-image lists in the same order.
  atlas.groups.forEach((group, groupIndex) => {
    const original = groups[groupIndex];
    const scaledByOriginal = new Map(original.items.map((item, index) => [item, group.items[index]]));
    group.items = original.imageItems.map((item) => {
      const scaled = scaledByOriginal.get(item);
      if (!scaled) return item;
      if (atlas.scale !== 1) {
        scaled.offsetX = Math.floor((item.offsetX || 0) * atlas.scale);
        scaled.offsetY = Math.floor((item.offsetY || 0) * atlas.scale);
      }
      return scaled;
    });
    if (atlas.scale !== 1) {
      group.cellWidth = Math.max(1, Math.floor(original.cellWidth * atlas.scale));
      group.cellHeight = Math.max(1, Math.floor(original.cellHeight * atlas.scale));
    }
  });

  onProgress?.({ stage: "sheet", value: 0.86, message: atlas.pages.length > 1 ? `Собираю ${atlas.pages.length} листа…` : "Собираю спрайт-лист…" });
  const sheetBackground = options.outputBackground === "white" ? { r: 255, g: 255, b: 255, alpha: 1 } : { r: 0, g: 0, b: 0, alpha: 0 };
  const pixelKernel = animations.some((animation) => animation.options.pixelPerfect) ? sharp.kernel.nearest : sharp.kernel.lanczos3;
  const pageFiles = atlas.pages.map((_page, index) => (atlas.pages.length === 1 ? `${spriteName}.sheet.png` : `${spriteName}.sheet-${index}.png`));
  const sheetDir = previewOnly || exportSheet ? outputRoot : workingRoot;
  let sheetPrepMs = 0;
  let sheetEncodeMs = 0;
  // Pages are independent images, so a split atlas encodes them in parallel. A single page stays
  // a single sequential PNG encode, which is the floor of this stage.
  const sheetPaths = await runPooled(atlas.pages, parallelismOfPages(atlas.pages.length, options), async (page, pageIndex) => {
    const prepStarted = performance.now();
    const composites = [];
    for (const rect of page.rects) {
      let input = rect.item.buffer;
      const meta = rect.item.sourceBufferSize || await sharp(input).metadata();
      if (meta.width !== rect.item.width || meta.height !== rect.item.height) {
        input = await sharp(input).resize({ width: rect.item.width, height: rect.item.height, fit: "fill", kernel: pixelKernel }).png().toBuffer();
      }
      composites.push({ input, left: rect.x, top: rect.y });
    }
    sheetPrepMs += performance.now() - prepStarted;
    const sheetPath = path.join(sheetDir, pageFiles[pageIndex]);
    const encodeStarted = performance.now();
    await sharp({ create: { width: Math.max(1, page.width), height: Math.max(1, page.height), channels: 4, background: sheetBackground } })
      .composite(composites)
      .png({ compressionLevel: previewOnly ? 6 : 9 })
      .toFile(sheetPath);
    sheetEncodeMs += performance.now() - encodeStarted;
    return sheetPath;
  });

  const sheetAt = performance.now();

  // Frames folder in playback order (duplicates written as separate files).
  let framePaths = [];
  if (!previewOnly && requestedExports.frames) {
    for (const animation of animations) {
      const dir = path.join(outputRoot, multi ? path.join("frames", animation.name) : "frames");
      await fs.mkdir(dir, { recursive: true });
      for (const [position, entry] of animation.sequence.entries()) {
        const framePath = path.join(dir, `${String(position).padStart(4, "0")}.png`);
        await fs.copyFile(animation.imagePaths[entry.image], framePath);
        framePaths.push(framePath);
      }
    }
  } else if (previewOnly) {
    framePaths = animations.flatMap((animation) => animation.imagePaths);
  }

  const { frames, tags } = describeFrames(animations, atlas, pageFiles);
  const primary = animations[0];
  const primaryGroup = atlas.groups[primary.groupIndex];
  const gridLayout = packing === "grid" && atlas.pages.length === 1 && !multi;
  const columns = gridLayout ? (primaryGroup.layoutColumns || primaryGroup.columns) : primaryGroup.columns;
  const rows = gridLayout ? Math.ceil(groups[primary.groupIndex].items.length / Math.max(1, columns)) : Math.ceil(primary.sequence.length / Math.max(1, primaryGroup.columns));
  const manifest = {
    name: spriteName,
    image: pageFiles[0],
    frameWidth: primaryGroup.cellWidth,
    frameHeight: primaryGroup.cellHeight,
    columns,
    rows,
    frameCount: multi ? frames.length : primary.sequence.length,
    fps: primary.fps,
    frameDurationMs: primary.baseDurationMs,
    anchor: primary.anchor,
    pivot: primary.pivot,
    ...(primary.normalized.bodyAlignment ? { bodyAlignment: { ...primary.normalized.bodyAlignment, x: primaryGroup.cellWidth / 2, y: primaryGroup.cellHeight / 2, referenceDiameter: primary.normalized.bodyAlignment.referenceDiameter * atlas.scale } } : {}),
    transparent: options.outputBackground !== "white",
    formatVersion: 2,
    packing,
    powerOfTwo: atlas.powerOfTwo,
    scale: atlas.scale,
    pages: atlas.pages.map((page, index) => ({ image: pageFiles[index], width: page.width, height: page.height })),
    loop: primary.loop,
    animations: tags,
    ...(animations.some((animation) => animation.depthFiles.length) ? { depthMaps: animations.map((animation) => ({ animation: animation.name, images: animation.depthFiles })) } : {}),
    frames: frames.map((frame, index) => ({
      index,
      name: frame.name,
      animation: frame.animation,
      sourceFrameIndex: frame.sourceFrameIndex,
      sourceName: frame.sourceName,
      sourceRect: frame.sourceRect,
      page: frame.page,
      x: frame.x,
      y: frame.y,
      width: frame.width,
      height: frame.height,
      trimmed: frame.trimmed,
      spriteSourceSize: frame.spriteSourceSize,
      sourceSize: frame.sourceSize,
      durationMs: frame.durationMs,
      pivot: frame.pivot,
      hitbox: frame.hitbox,
      hitboxSpace: frame.hitboxSpace,
      transform: frame.transform,
    })),
  };
  const report = multi
    ? {
      generatedAt: new Date().toISOString(),
      animations: animations.map((animation) => ({ name: animation.name, ...animation.built.report })),
      warnings: animations.flatMap((animation) => animation.built.report.warnings.map((warning) => `${animation.name}: ${warning}`)).slice(0, 100),
      frameIssues: animations.flatMap((animation) => (animation.built.report.frameIssues || []).map((issue) => ({ ...issue, animation: animation.name, message: `${animation.name}: ${issue.message}` }))),
    }
    : { ...primary.built.report, generatedAt: new Date().toISOString() };
  if (atlas.exceeds) report.atlas = { naturalWidth: atlas.naturalWidth, naturalHeight: atlas.naturalHeight, limit: atlas.limit, applied: atlas.applied, note: atlas.note };
  // Identifies the recipe behind this result: the same hash means the same sources and
  // the same settings, so two different atlases can be compared instead of guessed at.
  const recipeSignature = stableStringify({
    animations: animations.map((animation) => ({
      name: animation.name,
      renderKey: animation.built.key,
      layoutOptions: Object.fromEntries(Object.entries(animation.options).filter(([key]) => postRenderOptionKeys.has(key) && key !== "frameParallelism")),
    })),
    atlas: { packing, maxSize, overflow: options.atlasOverflow || "warn", powerOfTwo: atlas.powerOfTwo, exportFormat },
  });
  report.recipe = {
    hash: crypto.createHash("sha1").update(recipeSignature).digest("hex").slice(0, 16),
    appVersion: APP_VERSION,
    exportFormat,
    packing,
    atlasMaxSize: maxSize,
    atlasPowerOfTwo: atlas.powerOfTwo,
  };
  // The limit is only re-checked when the plan claims to honour it: with "warn" the
  // user already saw the dedicated atlas card, so repeating it would be noise.
  const inspection = inspectAtlas(manifest, { maxSize: atlas.applied === "warn" ? 0 : maxSize });
  if (inspection.issues.length) {
    // The inspector already resolved every frame number to a source index.
    report.atlasIssues = inspection.issues;
    for (const issue of report.atlasIssues) {
      if (issue.severity !== "error") continue;
      const message = `Лист: ${issue.message}`;
      if (!report.warnings.includes(message)) report.warnings.push(message);
      if (issue.sourceFrameIndex != null) (report.frameIssues ||= []).push({ frameIndex: issue.sourceFrameIndex, message });
    }
    report.warnings = report.warnings.slice(0, 100);
    const keptIssues = new Set(report.warnings);
    if (report.frameIssues) report.frameIssues = report.frameIssues.filter((issue) => keptIssues.has(issue.message));
  }
  // The JSON files are written after everything else: a run that fails half-way then never
  // leaves behind a manifest that points at images which were not produced yet.
  const manifestPath = previewOnly || requestedExports.metadata ? path.join(outputRoot, `${spriteName}.json`) : null;
  const reportPath = previewOnly || requestedExports.metadata ? path.join(outputRoot, `${spriteName}.report.json`) : null;

  const engineFiles = [];
  if (!previewOnly && requestedExports.metadata && exportFormat !== "chuba") {
    const outputs = exportFormat === "phaser3" ? phaserFiles(spriteName, frames, tags, atlas, pageFiles)
      : exportFormat === "texturepacker" ? texturePackerFiles(spriteName, frames, tags, atlas, pageFiles)
        : exportFormat === "unity" ? [unitySlicerFile(spriteName, frames, atlas, pageFiles)]
          : [godotFile(spriteName, frames, tags, atlas, pageFiles)];
    outputs.push(hitboxFile(spriteName, frames));
    for (const output of outputs) {
      const target = path.join(outputRoot, output.file);
      await fs.writeFile(target, output.text ?? `${JSON.stringify(output.content, null, 2)}\n`, "utf8");
      engineFiles.push(target);
    }
  }

  const metaAt = performance.now();
  const previewPaths = [];
  // The animated WebP is an export artifact: the window plays the frames on a canvas and never
  // shows this file. Generating it for a preview-only build used to cost more than everything
  // else together.
  if (!previewOnly && requestedExports.preview) {
    onProgress?.({ stage: "preview", value: 0.92, message: "Собираю анимированное превью…" });
    for (const animation of animations) {
      const order = playbackOrder(animation.sequence.length, animation.loop);
      const target = path.join(outputRoot, multi ? `${spriteName}.${animation.name}.preview.webp` : `${spriteName}.preview.webp`);
      const made = await makeSequencePreview(animation.imagePaths, order, animation.sequence, target, animation.fps, appRoot, signal);
      if (made) previewPaths.push(made);
    }
  }
  // The per-frame stage timings above cover only part of the work: writing the rendered cells,
  // compositing the atlas and encoding the preview used to be invisible, which made any speed
  // comparison misleading.
  const previewAt = performance.now();
  report.buildMs = {
    builds: Math.round(buildsAt - jobStartedAt),
    images: Math.round(imagesAt - buildsAt),
    items: Math.round(itemsAt - imagesAt),
    sheet: Math.round(sheetAt - itemsAt),
    sheetPrep: Math.round(sheetPrepMs),
    sheetEncode: Math.round(sheetEncodeMs),
    metadata: Math.round(metaAt - sheetAt),
    preview: Math.round(previewAt - metaAt),
  };
  if (manifestPath) await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (reportPath) await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (!previewOnly) {
    onProgress?.({ stage: "commit", value: 0.97, message: "Записываю готовый набор…" });
    await commitStagedOutput({ stagingRoot, finalRoot, spriteName, cleanOutput: options.cleanOutput });
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  }
  onProgress?.({ stage: "done", value: 1, message: `Готово · ${frames.length} кадров` });

  // Staged files live in the temporary workspace, so every returned path points
  // at the committed copy inside finalRoot.
  const finalSheetPaths = sheetPaths.map(toFinal);
  const finalFramePaths = framePaths.map(toFinal);
  const finalEngineFiles = engineFiles.map(toFinal);
  const finalPreviewPaths = previewPaths.map(toFinal);
  const finalManifestPath = toFinal(manifestPath);
  const finalReportPath = toFinal(reportPath);
  const finalPreviewPath = finalPreviewPaths[0] || null;
  const revealPath = !previewOnly
    ? (exportSheet ? finalSheetPaths[0] : requestedExports.frames ? finalFramePaths[0] : finalManifestPath || finalPreviewPath)
    : null;

  return {
    name: spriteName,
    outputDir: finalRoot,
    sheetPath: finalSheetPaths[0],
    sheetPaths: finalSheetPaths,
    manifestPath: finalManifestPath,
    reportPath: finalReportPath,
    previewPath: finalPreviewPath,
    previewPaths: finalPreviewPaths,
    engineFiles: finalEngineFiles,
    exportFormat,
    revealPath,
    exports: requestedExports,
    framePaths: finalFramePaths,
    imagePaths: primary.imagePaths,
    depthPaths: primary.depthFiles.map((file) => toFinal(path.join(outputRoot, file))),
    sourceFramePaths: primary.prepared.map((frame) => frame.sourcePath),
    sourceFrameIndexes: primary.prepared.map((frame) => frame.sourceIndex),
    // Bounds the build already measured. The size assistant reuses them instead of
    // keying every frame a second time.
    frameBounds: primary.prepared.map((frame) => ({ index: frame.sourceIndex, width: frame.bounds.width, height: frame.bounds.height })),
    allSourceFramePaths: primary.built.inputFrames,
    frameCount: multi ? frames.length : primary.sequence.length,
    columns,
    rows,
    cellWidth: primaryGroup.cellWidth,
    cellHeight: primaryGroup.cellHeight,
    warnings: report.warnings,
    // Structured companions to the warnings: the same messages with a source frame
    // index, plus the full atlas inspection for the interface.
    frameIssues: report.frameIssues || [],
    atlasIssues: report.atlasIssues || null,
    skipped: primary.built.skipped,
    attachmentPlacements: primary.built.attachmentPlacements,
    reusedRender: animations.every((animation) => animation.built.reused),
    sequence: primary.sequence.map((entry) => ({ sourceIndex: primary.prepared[entry.image].sourceIndex, durationMs: entry.durationMs, custom: entry.custom })),
    loop: primary.loop,
    fps: primary.fps,
    pivot: primary.pivot,
    packing,
    atlas: {
      pages: atlas.pages.map((page, index) => ({ width: page.width, height: page.height, path: finalSheetPaths[index] })),
      width: Math.max(...atlas.pages.map((page) => page.width)),
      height: Math.max(...atlas.pages.map((page) => page.height)),
      naturalWidth: atlas.naturalWidth,
      naturalHeight: atlas.naturalHeight,
      limit: atlas.limit,
      exceeds: atlas.exceeds,
      applied: atlas.applied,
      scale: atlas.scale,
      note: atlas.note,
    },
    animations: animations.map((animation) => ({ name: animation.name, frameCount: animation.sequence.length, fps: animation.fps, loop: animation.loop, reused: animation.built.reused })),
    multi,
  };
}

export async function processSprites({ source, outputDir, name, options = {}, previewOnly = false, appRoot, onProgress, signal }) {
  if (!source?.paths?.length) throw new Error("Сначала выберите видео или кадры.");
  return runAtlasJob({
    animations: [{ name: options.animationName || name, source, options }],
    outputDir, name, options, previewOnly, appRoot, onProgress, signal,
  });
}

export async function processAnimationSet({ animations, outputDir, name, options = {}, previewOnly = false, appRoot, onProgress, signal }) {
  const valid = (animations || []).filter((animation) => animation?.source?.paths?.length);
  if (!valid.length) throw new Error("В проекте нет анимаций с исходниками.");
  return runAtlasJob({ animations: valid, outputDir, name, options, previewOnly, appRoot, onProgress, signal });
}

export async function processVideoBatch({ paths, outputDir, options = {}, appRoot, onProgress, signal, shouldStop }) {
  const videoPaths = [...new Set((paths || []).filter(Boolean))];
  if (!videoPaths.length) throw new Error("Не выбрано ни одного видео для пакетной обработки.");
  if (!outputDir) throw new Error("Выберите папку назначения для пакетной обработки.");
  await fs.mkdir(outputDir, { recursive: true });

  const reservedNames = new Set();
  const results = [];
  const failures = [];
  for (let index = 0; index < videoPaths.length; index += 1) {
    throwIfAborted(signal);
    const videoPath = videoPaths[index];
    const originalName = path.parse(videoPath).name;
    const spriteName = await nextAvailableBatchName(outputDir, originalName, reservedNames);
    onProgress?.({
      stage: "batch",
      value: index / videoPaths.length,
      message: `Видео ${index + 1}/${videoPaths.length} · ${path.basename(videoPath)}`,
    });
    try {
      const result = await processSprites({
        source: { kind: "video", paths: [videoPath], title: path.basename(videoPath) },
        outputDir,
        name: spriteName,
        options: { ...options, trimStart: 0, trimEnd: 0, excludedFrames: [], cleanOutput: false },
        previewOnly: false,
        appRoot,
        signal,
        onProgress: (progress) => onProgress?.({
          ...progress,
          value: (index + Math.max(0, Math.min(1, Number(progress.value) || 0))) / videoPaths.length,
          message: `Видео ${index + 1}/${videoPaths.length} · ${path.basename(videoPath)} · ${progress.message || "Обработка…"}`,
        }),
      });
      results.push(result);
    } catch (error) {
      if (signal?.aborted) throw new Error("Обработка отменена.");
      failures.push({ path: videoPath, name: path.basename(videoPath), error: error.message || String(error) });
    }
    if (shouldStop?.()) break;
  }

  onProgress?.({ stage: "done", value: 1, message: `Готово · ${results.length}/${videoPaths.length} видео` });
  return {
    batch: true,
    total: videoPaths.length,
    completed: results.length,
    failed: failures.length,
    stopped: results.length + failures.length < videoPaths.length,
    failures,
    results,
    outputDir,
    revealPath: outputDir,
  };
}

export async function processFramePreview({ inputPath, options = {}, appRoot }) {
  if (!inputPath) throw new Error("Нет кадра для быстрого предпросмотра.");
  const previewRoot = await makeTempWorkspace("chuba-sprite-live-");
  let keyed = await keyFrame(inputPath, options.keyMode || "auto", options.tolerance ?? 28, options.blackOutline ?? 3, options.blackFeather ?? 0, {
    appRoot,
    frameIndex: options.previewFrameIndex ?? 0,
    aiCutoff: options.aiCutoff,
    aiSoftness: options.aiSoftness,
    aiEdits: options.aiEdits,
    keyScope: options.keyScope,
    fringeCleanup: options.fringeCleanup,
    fringeStrength: options.fringeStrength,
    edgeDecontaminate: options.edgeDecontaminate,
    keyColor: options.keyColor,
    aiProvider: options.aiProvider,
    aiForceModel: options.aiForceModel,
    aiQuality: options.aiQuality,
    aiModel: options.aiModel,
    aiModelDirs: options.aiModelDirs,
  });
  let whiteRemainders = { count: 0, regions: [] };
  if (options.keyScope !== "all" && options.keyMode !== "alpha" && keyed.keyColor?.every((value) => value >= 230)) {
    const raw = await sharp(keyed.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    whiteRemainders = findWhiteRemainders(raw.data, raw.info, keyed.keyColor);
  }
  if (options.edgeRefine) keyed = await applyEdgeRefine(keyed, options.edgeRefine);
  const previewFrameIndex = options.previewFrameIndex ?? 0;
  const placements = options.attachmentPlacements?.[previewFrameIndex]
    || (options.attachments || []).map((attachment) => ({ ...attachment, points: attachment.points || [] }));
  keyed = await compositeAttachments(keyed, placements);
  if (options.pixelate && Number(options.pixelate.size) > 1) keyed = await applyPixelation(keyed, options.pixelate);
  if (options.toning) keyed = await applyToning(keyed, options.toning);
  const transform = resolveFrameTransform(options, previewFrameIndex);
  if (transform && keyed.bounds) {
    const sprite = await sharp(keyed.buffer).extract(keyed.bounds).png().toBuffer();
    const transformed = await placeTransformedSprite({
      sprite, width: keyed.bounds.width, height: keyed.bounds.height, left: keyed.bounds.left, top: keyed.bounds.top,
      canvasWidth: keyed.info.width, canvasHeight: keyed.info.height, transform,
      kernel: options.pixelPerfect ? sharp.kernel.nearest : sharp.kernel.lanczos3,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    });
    const { data, info } = await sharp(transformed.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    keyed = { ...keyed, buffer: transformed.buffer, info, bounds: alphaBounds(data, info) };
  }
  const afterPath = path.join(previewRoot, "after.png");
  await fs.writeFile(afterPath, keyed.buffer);
  await finishQuickPreview(previewRoot);
  return {
    beforePath: inputPath,
    afterPath,
    imageSize: { width: keyed.info.width, height: keyed.info.height },
    bounds: keyed.bounds,
    keyColor: keyed.keyColor,
    whiteRemainders,
  };
}

function frameTransformScale(transforms, index) {
  if (!transforms || typeof transforms !== "object") return { x: 1, y: 1 };
  const value = transforms[index] ?? transforms[String(index)] ?? transforms["*"];
  if (!value || typeof value !== "object") return { x: 1, y: 1 };
  return {
    x: clamp(Number(value.scaleX) || 1, 0.25, 2.5),
    y: clamp(Number(value.scaleY) || 1, 0.25, 2.5),
  };
}

// Pure on purpose: the caller passes the bounds the build already measured plus the
// transforms that will be applied, so the assistant no longer re-keys every frame
// and its numbers describe the sheet that is actually written.
export function analyzeFrameConsistency(measurements, { transforms = {}, referenceIndex = null } = {}) {
  if (!Array.isArray(measurements) || !measurements.length || measurements.length > 256) {
    throw new Error("Сначала соберите анимацию до 256 кадров.");
  }
  const frames = measurements.map((item) => {
    const index = Number(item?.index) || 0;
    const scale = frameTransformScale(transforms, index);
    return {
      index,
      width: Math.max(0, Math.round((Number(item?.width) || 0) * scale.x)),
      height: Math.max(0, Math.round((Number(item?.height) || 0) * scale.y)),
    };
  });
  const heights = frames.map((item) => item.height).filter(Boolean).sort((a, b) => a - b);
  const aspects = frames.filter((item) => item.height).map((item) => item.width / item.height).sort((a, b) => a - b);
  const targetHeight = heights[Math.floor(heights.length / 2)] || 0;
  const targetAspect = aspects[Math.floor(aspects.length / 2)] || 1;
  const reference = referenceIndex == null ? null : frames.find((item) => item.index === Number(referenceIndex));
  if (referenceIndex != null && !reference) throw new Error("Опорный кадр не найден в собранной серии.");
  const chosenHeight = reference?.height || targetHeight;
  const chosenAspect = reference?.height ? reference.width / reference.height : targetAspect;
  const chosenArea = reference ? reference.width * reference.height : 0;
  return {
    targetHeight: chosenHeight,
    referenceIndex: reference?.index ?? null,
    frames: frames.map((item) => {
      const aspect = item.height ? item.width / item.height : 0;
      const samePose = item.height > 0 && Math.abs(aspect - chosenAspect) / chosenAspect < 0.18;
      const proposed = item.height ? clamp(chosenArea ? Math.sqrt(chosenArea / Math.max(1, item.width * item.height)) : chosenHeight / item.height, 0.5, 1.5) : 1;
      return { ...item, proposedScale: samePose ? Math.round(proposed * 100) / 100 : 1, confidence: samePose ? "similar-silhouette" : "different-pose" };
    }),
  };
}
