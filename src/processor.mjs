import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { segmentSubject } from "./ai-segmentation.mjs";

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

function safeName(value) {
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

async function resolveBinary(name, appRoot) {
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
  const previewDir = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-sprite-source-"));
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
  for (const samplePath of samplePaths) {
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
  return {
    kind: "frames",
    paths: orderedPaths,
    title: orderedPaths.length === 1 ? path.basename(first) : `${path.basename(path.dirname(first))} · ${orderedPaths.length} кадров`,
    detail: `${metadata.width || 0}×${metadata.height || 0} · ${orderedPaths.length} файлов`,
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

function erodeConnectedMask(mask, width, height, radius) {
  const eroded = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!mask[index]) continue;
      let keep = true;
      for (let dy = -radius; dy <= radius && keep; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -radius; dx <= radius; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          if (!mask[ny * width + nx]) {
            keep = false;
            break;
          }
        }
      }
      if (keep) eroded[index] = 1;
    }
  }
  return eroded;
}

export async function keyFrame(inputPath, mode, tolerance, blackOutline = 3, blackFeather = 0, context = {}) {
  const fileStats = await fs.stat(inputPath);
  const aiSignature = mode === "ai"
    ? JSON.stringify([context.aiCutoff, context.aiSoftness, context.aiForceModel, context.frameIndex, context.aiEdits || []])
    : "";
  const cacheKey = `${inputPath}|${fileStats.mtimeMs}|${mode}|${tolerance}|${blackOutline}|${blackFeather}|${aiSignature}`;
  if (frameKeyCache.has(cacheKey)) return frameKeyCache.get(cacheKey);

  if (mode === "ai") {
    const edits = context.aiEdits || [];
    const fastMode = !context.aiForceModel && edits.length === 0 ? await detectFastAIKeyMode(inputPath) : null;
    if (fastMode) {
      const fastResult = await keyFrame(inputPath, fastMode, tolerance, blackOutline, blackFeather, {});
      return rememberFrameKey(cacheKey, { ...fastResult, aiFastPath: fastMode });
    }
    const { data, info } = await segmentSubject(inputPath, {
      appRoot: context.appRoot,
      cutoff: context.aiCutoff,
      softness: context.aiSoftness,
      edits: context.aiEdits,
      frameIndex: context.frameIndex,
    });
    const result = {
      buffer: await sharp(data, { raw: info }).png().toBuffer(),
      info,
      bounds: alphaBounds(data, info),
      keyColor: null,
    };
    return rememberFrameKey(cacheKey, result);
  }

  const { data, info } = await sharp(inputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (mode === "alpha") {
    const result = { buffer: await sharp(data, { raw: info }).png().toBuffer(), info, bounds: alphaBounds(data, info), keyColor: null };
    return rememberFrameKey(cacheKey, result);
  }

  const keys = {
    white: [255, 255, 255],
    black: [0, 0, 0],
    green: [0, 255, 0],
    blue: [0, 0, 255],
  };
  const keyColor = keys[mode] || borderKeyColor(data, info);
  const threshold = clamp(Number(tolerance) || 28, 1, 100) * (mode === "black" ? 1.8 : 2.6);
  const { width, height, channels } = info;

  if (mode === "green" || mode === "blue") {
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
    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);
      enqueue(x - 1, y);
      enqueue(x + 1, y);
      enqueue(x, y - 1);
      enqueue(x, y + 1);
    }

    const outlineRadius = clamp(Math.round(Number(blackOutline) || 0), 0, 12);
    const clearMask = mode === "black" && outlineRadius > 0 ? erodeConnectedMask(visited, width, height, outlineRadius) : visited;
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

  const bounds = alphaBounds(data, info);
  const result = {
    buffer: await sharp(data, { raw: info }).png().toBuffer(),
    info,
    bounds,
    keyColor,
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

function makeReport(frames, skipped, keyMode) {
  const widths = frames.map((frame) => frame.bounds.width);
  const heights = frames.map((frame) => frame.bounds.height);
  const averageWidth = mean(widths);
  const averageHeight = mean(heights);
  const warnings = [];
  frames.forEach((frame, index) => {
    if (Math.abs(frame.bounds.width - averageWidth) / Math.max(1, averageWidth) > 0.2) warnings.push(`Кадр ${index + 1}: ширина силуэта отличается более чем на 20%.`);
    if (Math.abs(frame.bounds.height - averageHeight) / Math.max(1, averageHeight) > 0.2) warnings.push(`Кадр ${index + 1}: высота силуэта отличается более чем на 20%.`);
    const { bounds, info } = frame;
    if (bounds.left <= 1 || bounds.top <= 1 || bounds.left + bounds.width >= info.width - 1 || bounds.top + bounds.height >= info.height - 1) {
      warnings.push(`Кадр ${index + 1}: персонаж касается края исходного изображения.`);
    }
  });
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
    warnings: [...new Set(warnings)].slice(0, 100),
  };
}

async function renderFrames(frames, options) {
  const maxWidth = Math.max(...frames.map((frame) => frame.bounds.width));
  const maxHeight = Math.max(...frames.map((frame) => frame.bounds.height));
  const requestedPadding = clamp(Math.round(Number(options.padding) || 20), 0, 512);
  const cellWidth = options.autoSize
    ? clamp(maxWidth + requestedPadding * 2, 64, 4096)
    : clamp(Math.round(Number(options.cellWidth) || 600), 64, 4096);
  const cellHeight = options.autoSize
    ? clamp(maxHeight + requestedPadding * 2, 64, 4096)
    : clamp(Math.round(Number(options.cellHeight) || 400), 64, 4096);
  const padding = clamp(requestedPadding, 0, Math.floor(Math.min(cellWidth, cellHeight) / 3));
  const anchor = ["ground", "center", "motion"].includes(options.anchor) ? options.anchor : "ground";
  const background = options.outputBackground === "white"
    ? { r: 255, g: 255, b: 255, alpha: 1 }
    : { r: 0, g: 0, b: 0, alpha: 0 };
  const scale = Math.min(
    (cellWidth - padding * 2) / Math.max(1, maxWidth),
    (cellHeight - padding * 2) / Math.max(1, maxHeight),
  );
  const kernel = options.pixelPerfect ? sharp.kernel.nearest : sharp.kernel.lanczos3;
  const rendered = [];

  for (const frame of frames) {
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
      spriteWidth = Math.max(1, Math.round(frame.bounds.width * scale));
      spriteHeight = Math.max(1, Math.round(frame.bounds.height * scale));
      sprite = await sharp(frame.buffer)
        .extract(frame.bounds)
        .resize({ width: spriteWidth, height: spriteHeight, fit: "fill", kernel })
        .png().toBuffer();
      left = Math.round((cellWidth - spriteWidth) / 2);
      top = anchor === "ground"
        ? cellHeight - padding - spriteHeight
        : Math.round((cellHeight - spriteHeight) / 2);
    }

    const output = await sharp({ create: { width: cellWidth, height: cellHeight, channels: 4, background } })
      .composite([{ input: sprite, left, top }])
      .png().toBuffer();
    rendered.push({ buffer: output, left, top, width: spriteWidth, height: spriteHeight });
  }
  return { rendered, cellWidth, cellHeight, padding, anchor };
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

export async function processSprites({ source, outputDir, name, options = {}, previewOnly = false, appRoot, onProgress, signal }) {
  if (!source?.paths?.length) throw new Error("Сначала выберите видео или кадры.");
  throwIfAborted(signal);
  const spriteName = safeName(name || path.parse(source.title || source.paths[0]).name);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-sprite-lab-"));
  const extractedDir = path.join(tempRoot, "source");
  const requestedExports = {
    sheet: options.exports?.sheet !== false,
    frames: options.exports?.frames !== false,
    metadata: options.exports?.metadata !== false,
    preview: options.exports?.preview !== false,
  };
  if (!previewOnly && !Object.values(requestedExports).some(Boolean)) throw new Error("Выберите хотя бы один формат экспорта.");
  // Manifest references the sheet, so exporting metadata also guarantees a usable sheet.
  const exportSheet = requestedExports.sheet || requestedExports.metadata;
  const finalRoot = previewOnly
    ? path.join(tempRoot, "preview")
    : path.join(outputDir || path.dirname(source.paths[0]), spriteName);
  const workingRoot = previewOnly ? finalRoot : path.join(tempRoot, "working");
  if (!previewOnly && options.cleanOutput) {
    const knownTargets = [
      path.join(finalRoot, "frames"),
      path.join(finalRoot, `${spriteName}.sheet.png`),
      path.join(finalRoot, `${spriteName}.json`),
      path.join(finalRoot, `${spriteName}.report.json`),
      path.join(finalRoot, `${spriteName}.preview.webp`),
    ];
    for (const target of knownTargets) await fs.rm(target, { recursive: true, force: true });
  }
  const framesDir = previewOnly || requestedExports.frames || requestedExports.preview
    ? path.join(requestedExports.frames || previewOnly ? finalRoot : workingRoot, "frames")
    : path.join(workingRoot, "frames");
  await fs.mkdir(finalRoot, { recursive: true });
  await fs.mkdir(workingRoot, { recursive: true });
  await fs.mkdir(framesDir, { recursive: true });

  onProgress?.({ stage: "prepare", value: 0.03, message: "Подготавливаю источник…" });
  let inputFrames;
  if (source.kind === "video") {
    const cacheKey = `${source.paths[0]}|${options.fps}|${options.maxFrames}|${options.trimStart || 0}|${options.trimEnd || 0}`;
    const cached = videoFrameCache.get(cacheKey);
    inputFrames = cached?.length && await exists(cached[0])
      ? cached
      : await extractVideoFrames(source.paths[0], extractedDir, options.fps, options.maxFrames, appRoot, onProgress, options.trimStart, options.trimEnd, signal);
    videoFrameCache.set(cacheKey, inputFrames);
    if (videoFrameCache.size > 6) videoFrameCache.delete(videoFrameCache.keys().next().value);
  } else {
    inputFrames = [...source.paths].sort(naturalCompare).slice(0, clamp(Number(options.maxFrames) || 192, 1, 1000));
  }
  if (!inputFrames.length) throw new Error("Не удалось получить ни одного кадра.");

  const prepared = [];
  const skipped = { empty: 0, duplicates: 0, excluded: 0, emptyIndexes: [], duplicateIndexes: [] };
  const excludedFrames = new Set((options.excludedFrames || []).map(Number));
  let previousHash = null;
  for (let index = 0; index < inputFrames.length; index += 1) {
    throwIfAborted(signal);
    if (excludedFrames.has(index)) {
      skipped.excluded += 1;
      continue;
    }
    const keyed = await keyFrame(inputFrames[index], options.keyMode || "auto", options.tolerance ?? 28, options.blackOutline ?? 3, options.blackFeather ?? 0, {
      appRoot,
      frameIndex: index,
      aiCutoff: options.aiCutoff,
      aiSoftness: options.aiSoftness,
      aiEdits: options.aiEdits,
    });
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

  const report = makeReport(prepared, skipped, options.keyMode || "auto");
  const normalized = await renderFrames(prepared, options);
  const framePaths = [];
  for (let index = 0; index < normalized.rendered.length; index += 1) {
    throwIfAborted(signal);
    const framePath = path.join(framesDir, `${String(index).padStart(4, "0")}.png`);
    await fs.writeFile(framePath, normalized.rendered[index].buffer);
    framePaths.push(framePath);
    onProgress?.({
      stage: "normalize",
      value: 0.52 + (index + 1) / normalized.rendered.length * 0.2,
      message: `Выравниваю кадры · ${index + 1}/${normalized.rendered.length}`,
    });
  }

  const columns = options.autoColumns
    ? Math.max(1, Math.ceil(Math.sqrt(framePaths.length)))
    : clamp(Math.round(Number(options.columns) || Math.ceil(Math.sqrt(framePaths.length))), 1, Math.max(1, framePaths.length));
  const rows = Math.ceil(framePaths.length / columns);
  const sheetWidth = columns * normalized.cellWidth;
  const sheetHeight = rows * normalized.cellHeight;
  const sheetBackground = options.outputBackground === "white"
    ? { r: 255, g: 255, b: 255, alpha: 1 }
    : { r: 0, g: 0, b: 0, alpha: 0 };
  const composites = normalized.rendered.map((frame, index) => ({
    input: frame.buffer,
    left: (index % columns) * normalized.cellWidth,
    top: Math.floor(index / columns) * normalized.cellHeight,
  }));
  const sheetPath = path.join(previewOnly || exportSheet ? finalRoot : workingRoot, `${spriteName}.sheet.png`);
  await sharp({ create: { width: sheetWidth, height: sheetHeight, channels: 4, background: sheetBackground } })
    .composite(composites)
    .png({ compressionLevel: 9 })
    .toFile(sheetPath);

  const frameDurationMs = Math.round(1000 / clamp(Number(options.fps) || 8, 1, 60));
  const pivot = normalized.anchor === "ground" ? { x: 0.5, y: 1 - normalized.padding / normalized.cellHeight } : { x: 0.5, y: 0.5 };
  const manifest = {
    name: spriteName,
    image: path.basename(sheetPath),
    frameWidth: normalized.cellWidth,
    frameHeight: normalized.cellHeight,
    columns,
    rows,
    frameCount: framePaths.length,
    fps: clamp(Number(options.fps) || 8, 1, 60),
    frameDurationMs,
    anchor: normalized.anchor,
    pivot,
    transparent: options.outputBackground !== "white",
    frames: framePaths.map((_framePath, index) => ({
      index,
      x: (index % columns) * normalized.cellWidth,
      y: Math.floor(index / columns) * normalized.cellHeight,
      width: normalized.cellWidth,
      height: normalized.cellHeight,
      durationMs: frameDurationMs,
      pivot,
    })),
  };
  const manifestPath = previewOnly || requestedExports.metadata ? path.join(finalRoot, `${spriteName}.json`) : null;
  const reportPath = previewOnly || requestedExports.metadata ? path.join(finalRoot, `${spriteName}.report.json`) : null;
  if (manifestPath) await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (reportPath) await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  let previewPath = null;
  if (previewOnly || requestedExports.preview) {
    onProgress?.({ stage: "preview", value: 0.86, message: "Собираю анимированное превью…" });
    previewPath = await makeAnimatedPreview(path.join(framesDir, "%04d.png"), path.join(finalRoot, `${spriteName}.preview.webp`), options.fps, appRoot, signal);
  }
  onProgress?.({ stage: "done", value: 1, message: `Готово · ${framePaths.length} кадров` });

  const revealPath = !previewOnly
    ? (exportSheet ? sheetPath : requestedExports.frames ? framePaths[0] : manifestPath || previewPath)
    : null;

  return {
    name: spriteName,
    outputDir: finalRoot,
    sheetPath,
    manifestPath,
    reportPath,
    previewPath,
    revealPath,
    exports: requestedExports,
    framePaths,
    sourceFramePaths: prepared.map((frame) => frame.sourcePath),
    sourceFrameIndexes: prepared.map((frame) => frame.sourceIndex),
    allSourceFramePaths: inputFrames,
    frameCount: framePaths.length,
    columns,
    rows,
    cellWidth: normalized.cellWidth,
    cellHeight: normalized.cellHeight,
    warnings: report.warnings,
    skipped,
  };
}

export async function processVideoBatch({ paths, outputDir, options = {}, appRoot, onProgress, signal }) {
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
  }

  if (!results.length) {
    const firstError = failures[0]?.error ? ` ${failures[0].error}` : "";
    throw new Error(`Не удалось обработать ни одного видео.${firstError}`);
  }
  onProgress?.({ stage: "done", value: 1, message: `Готово · ${results.length}/${videoPaths.length} видео` });
  return {
    batch: true,
    total: videoPaths.length,
    completed: results.length,
    failed: failures.length,
    failures,
    results,
    outputDir,
    revealPath: outputDir,
  };
}

export async function processFramePreview({ inputPath, options = {}, appRoot }) {
  if (!inputPath) throw new Error("Нет кадра для быстрого предпросмотра.");
  const previewRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-sprite-live-"));
  const keyed = await keyFrame(inputPath, options.keyMode || "auto", options.tolerance ?? 28, options.blackOutline ?? 3, options.blackFeather ?? 0, {
    appRoot,
    frameIndex: options.previewFrameIndex ?? 0,
    aiCutoff: options.aiCutoff,
    aiSoftness: options.aiSoftness,
    aiEdits: options.aiEdits,
  });
  const afterPath = path.join(previewRoot, "after.png");
  await fs.writeFile(afterPath, keyed.buffer);
  return {
    beforePath: inputPath,
    afterPath,
    bounds: keyed.bounds,
    keyColor: keyed.keyColor,
  };
}
