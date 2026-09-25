import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import sharp from "sharp";
import { inspectSource, keyFrame, processFramePreview, processSprites, processVideoBatch } from "../src/processor.mjs";

async function makeFrame(filePath, left, top) {
  const orange = await sharp({
    create: { width: 22, height: 26, channels: 4, background: { r: 225, g: 86, b: 18, alpha: 1 } },
  }).png().toBuffer();
  await sharp({
    create: { width: 64, height: 64, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  }).composite([{ input: orange, left, top }]).png().toFile(filePath);
}

test("builds aligned frames, sheet, manifest and report from separate images", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-sprite-lab-test-"));
  const input = path.join(temp, "input");
  const output = path.join(temp, "output");
  await fs.mkdir(input, { recursive: true });
  await fs.mkdir(output, { recursive: true });
  const paths = [0, 1, 2].map((index) => path.join(input, `frame-${index}.png`));
  await makeFrame(paths[0], 8, 25);
  await makeFrame(paths[1], 20, 21);
  await makeFrame(paths[2], 31, 18);

  const source = await inspectSource({ kind: "frames", paths, appRoot: path.resolve(".") });
  assert.equal(source.estimatedFrames, 3);
  assert.equal(source.previewPath, paths[0]);
  assert.equal(source.samplePaths.length, 3);
  assert.ok(source.recommendations.keyMode);

  const result = await processSprites({
    source,
    outputDir: output,
    name: "test-walk",
    appRoot: path.resolve("."),
    options: {
      fps: 8,
      columns: 2,
      cellWidth: 128,
      cellHeight: 96,
      padding: 8,
      maxFrames: 10,
      tolerance: 18,
      keyMode: "white",
      anchor: "ground",
      pixelPerfect: true,
      removeDuplicates: false,
      outputBackground: "transparent",
    },
  });

  assert.equal(result.frameCount, 3);
  assert.equal(result.columns, 2);
  assert.equal(result.rows, 2);
  const sheet = await sharp(result.sheetPath).metadata();
  assert.equal(sheet.width, 256);
  assert.equal(sheet.height, 192);
  assert.equal(sheet.hasAlpha, true);
  const corner = await sharp(result.framePaths[0]).extract({ left: 0, top: 0, width: 1, height: 1 }).ensureAlpha().raw().toBuffer();
  assert.equal(corner[3], 0, "white border must become transparent");
  const visible = await sharp(result.framePaths[0]).stats();
  assert.ok(visible.channels[3].max > 0, "foreground sprite must remain visible");
  const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
  assert.equal(manifest.frameCount, 3);
  assert.deepEqual(manifest.pivot, { x: 0.5, y: 1 - 8 / 96 });
  const report = JSON.parse(await fs.readFile(result.reportPath, "utf8"));
  assert.equal(report.outputFrames, 3);
});

test("extracts and processes frames from a video", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-sprite-lab-video-test-"));
  const input = path.join(temp, "input");
  const output = path.join(temp, "output");
  await fs.mkdir(input, { recursive: true });
  await fs.mkdir(output, { recursive: true });
  await makeFrame(path.join(input, "frame-0.png"), 7, 25);
  await makeFrame(path.join(input, "frame-1.png"), 20, 21);
  await makeFrame(path.join(input, "frame-2.png"), 33, 17);
  const appRoot = path.resolve(".");
  const ffmpeg = path.join(appRoot, "vendor", "ffmpeg.exe");
  const videoPath = path.join(temp, "motion.mp4");
  const encoded = spawnSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-framerate", "6",
    "-i", path.join(input, "frame-%d.png"),
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    videoPath,
  ], { windowsHide: true });
  assert.equal(encoded.status, 0, encoded.stderr?.toString());

  const source = await inspectSource({ kind: "video", paths: [videoPath], appRoot });
  assert.equal(source.width, 64);
  assert.equal(source.height, 64);
  assert.ok(source.fps >= 5.9 && source.fps <= 6.1);
  assert.ok(source.previewPath);
  assert.ok(source.samplePaths.length >= 2);
  assert.ok(source.recommendations.fps > 0);
  assert.equal((await sharp(source.previewPath).metadata()).width, 64);
  const result = await processSprites({
    source,
    outputDir: output,
    name: "video-walk",
    appRoot,
    options: {
      fps: 6,
      columns: 3,
      cellWidth: 96,
      cellHeight: 96,
      padding: 8,
      maxFrames: 10,
      tolerance: 25,
      keyMode: "white",
      anchor: "motion",
      pixelPerfect: true,
      removeDuplicates: false,
      outputBackground: "transparent",
    },
  });
  assert.ok(result.frameCount >= 3);
  assert.ok(result.previewPath);
});

test("batch mode processes multiple videos with automatic unique names", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-sprite-lab-batch-test-"));
  const input = path.join(temp, "input");
  const output = path.join(temp, "output");
  await fs.mkdir(input, { recursive: true });
  await fs.mkdir(output, { recursive: true });
  await makeFrame(path.join(input, "frame-0.png"), 8, 25);
  await makeFrame(path.join(input, "frame-1.png"), 22, 20);
  const appRoot = path.resolve(".");
  const ffmpeg = path.join(appRoot, "vendor", "ffmpeg.exe");
  const firstVideo = path.join(temp, "walk.mp4");
  const secondVideo = path.join(temp, "jump.mp4");
  const encoded = spawnSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-framerate", "6", "-i", path.join(input, "frame-%d.png"),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", firstVideo,
  ], { windowsHide: true });
  assert.equal(encoded.status, 0, encoded.stderr?.toString());
  await fs.copyFile(firstVideo, secondVideo);
  await fs.mkdir(path.join(output, "walk"), { recursive: true });

  const result = await processVideoBatch({
    paths: [firstVideo, secondVideo], outputDir: output, appRoot,
    options: {
      fps: 6, columns: 2, cellWidth: 96, cellHeight: 96, padding: 8, maxFrames: 10,
      tolerance: 25, keyMode: "white", anchor: "ground", autoSize: true, autoColumns: true,
      pixelPerfect: true, removeDuplicates: false, outputBackground: "transparent",
      exports: { sheet: true, frames: false, metadata: false, preview: false },
    },
  });
  assert.equal(result.total, 2);
  assert.equal(result.completed, 2);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.results.map((item) => item.name).sort(), ["jump", "walk-2"]);
  for (const item of result.results) assert.ok(await fs.stat(item.sheetPath));
});

test("exports only the selected artifact types", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-sprite-lab-selection-test-"));
  const input = path.join(temp, "input");
  const output = path.join(temp, "output");
  await fs.mkdir(input, { recursive: true });
  await fs.mkdir(output, { recursive: true });
  const framePath = path.join(input, "frame.png");
  await makeFrame(framePath, 18, 20);
  const source = await inspectSource({ kind: "frames", paths: [framePath], appRoot: path.resolve(".") });
  const result = await processSprites({
    source,
    outputDir: output,
    name: "frames-only",
    appRoot: path.resolve("."),
    options: {
      fps: 8, columns: 1, cellWidth: 96, cellHeight: 96, padding: 8, maxFrames: 10,
      tolerance: 18, keyMode: "white", anchor: "ground", removeDuplicates: false,
      outputBackground: "transparent",
      exports: { sheet: false, frames: true, metadata: false, preview: false },
    },
  });
  const exported = await fs.readdir(result.outputDir);
  assert.deepEqual(exported, ["frames"]);
  assert.equal(result.manifestPath, null);
  assert.equal(result.reportPath, null);
  assert.equal(result.previewPath, null);
  assert.equal(result.revealPath, result.framePaths[0]);
});

test("local AI segmentation produces an editable transparent mask", async (context) => {
  const appRoot = path.resolve(".");
  try {
    await fs.access(path.join(appRoot, "models", "u2netp.onnx"));
  } catch {
    context.skip("local AI model is not prepared");
    return;
  }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-sprite-lab-ai-test-"));
  const inputPath = path.join(temp, "subject.png");
  await makeFrame(inputPath, 20, 19);
  const clean = await keyFrame(inputPath, "ai", 28, 3, 0, {
    appRoot,
    frameIndex: 0,
    aiCutoff: 42,
    aiSoftness: 0,
    aiEdits: [],
  });
  const original = await sharp(inputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const hard = await sharp(clean.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < hard.info.width * hard.info.height; index += 1) {
    const offset = index * hard.info.channels;
    assert.ok(hard.data[offset + 3] === 0 || hard.data[offset + 3] === 255, "zero softness must produce a hard alpha mask");
    assert.deepEqual([...hard.data.subarray(offset, offset + 3)], [...original.data.subarray(offset, offset + 3)], "AI cleanup must not alter source RGB pixels");
  }
  const keyed = await keyFrame(inputPath, "ai", 28, 3, 0, {
    appRoot,
    frameIndex: 0,
    aiCutoff: 42,
    aiSoftness: 0,
    aiEdits: [{ x: 0.5, y: 0.5, radius: 0.16, mode: "erase", frameIndex: 0, applyAll: false, strokeId: 1 }],
  });
  const { data, info } = await sharp(keyed.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 64);
  assert.equal(info.height, 64);
  assert.equal(data[(32 * info.width + 32) * info.channels + 3], 0, "erase brush must clear the selected area");
});

test("black key removes only edge-connected background and keeps a three-pixel contour", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-sprite-lab-black-key-test-"));
  const inputPath = path.join(temp, "black-background.png");
  const orange = await sharp({
    create: { width: 24, height: 24, channels: 4, background: { r: 235, g: 92, b: 24, alpha: 1 } },
  }).composite([{
    input: await sharp({ create: { width: 6, height: 6, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer(),
    left: 9,
    top: 9,
  }]).png().toBuffer();
  await sharp({
    create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
  }).composite([{ input: orange, left: 20, top: 20 }]).png().toFile(inputPath);

  const keyed = await keyFrame(inputPath, "black", 20);
  const { data, info } = await sharp(keyed.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alphaAt = (x, y) => data[(y * info.width + x) * info.channels + 3];
  assert.equal(alphaAt(16, 30), 0, "background beyond the contour must be transparent");
  assert.equal(alphaAt(17, 30), 255, "the three-pixel black contour must remain");
  assert.equal(alphaAt(30, 30), 255, "enclosed black details inside the figure must remain");
});

test("auto layout, exclusions and live frame preview work together", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-sprite-lab-ux-test-"));
  const input = path.join(temp, "input");
  const output = path.join(temp, "output");
  await fs.mkdir(input, { recursive: true });
  await fs.mkdir(output, { recursive: true });
  const paths = [0, 1, 2, 3].map((index) => path.join(input, `frame-${index}.png`));
  for (let index = 0; index < paths.length; index += 1) await makeFrame(paths[index], 7 + index * 9, 18 + index);
  const source = await inspectSource({ kind: "frames", paths, appRoot: path.resolve(".") });
  const live = await processFramePreview({ inputPath: paths[0], options: { keyMode: "white", tolerance: 18 } });
  assert.ok(await fs.stat(live.afterPath));

  const result = await processSprites({
    source, outputDir: output, name: "auto-layout", appRoot: path.resolve("."),
    options: {
      fps: 8, columns: 12, cellWidth: 800, cellHeight: 800, padding: 8, maxFrames: 10,
      tolerance: 18, keyMode: "white", anchor: "ground", autoSize: true, autoColumns: true,
      pixelPerfect: true, removeDuplicates: false, outputBackground: "transparent", excludedFrames: [1],
    },
  });
  assert.equal(result.frameCount, 3);
  assert.deepEqual(result.sourceFrameIndexes, [0, 2, 3]);
  assert.equal(result.columns, 2);
  assert.notEqual(result.cellWidth, 800);
  assert.notEqual(result.cellHeight, 800);
});

test("an aborted job stops before writing output", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-sprite-lab-cancel-test-"));
  const inputPath = path.join(temp, "frame.png");
  await makeFrame(inputPath, 12, 20);
  const source = await inspectSource({ kind: "frames", paths: [inputPath], appRoot: path.resolve(".") });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    processSprites({ source, outputDir: temp, name: "cancelled", appRoot: path.resolve("."), signal: controller.signal }),
    /отменена/i,
  );
});

test("clean export removes only known generated artifacts", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-sprite-lab-clean-test-"));
  const inputPath = path.join(temp, "frame.png");
  const output = path.join(temp, "output");
  const target = path.join(output, "cleanup");
  await makeFrame(inputPath, 12, 20);
  await fs.mkdir(path.join(target, "frames"), { recursive: true });
  await fs.writeFile(path.join(target, "cleanup.sheet.png"), "stale");
  await fs.writeFile(path.join(target, "cleanup.preview.webp"), "stale");
  await fs.writeFile(path.join(target, "notes.txt"), "keep me");
  const source = await inspectSource({ kind: "frames", paths: [inputPath], appRoot: path.resolve(".") });
  await processSprites({
    source, outputDir: output, name: "cleanup", appRoot: path.resolve("."),
    options: {
      fps: 8, columns: 1, cellWidth: 96, cellHeight: 96, padding: 8, maxFrames: 10,
      tolerance: 18, keyMode: "white", anchor: "ground", removeDuplicates: false,
      outputBackground: "transparent", cleanOutput: true,
      exports: { sheet: false, frames: true, metadata: false, preview: false },
    },
  });
  const entries = (await fs.readdir(target)).sort();
  assert.deepEqual(entries, ["frames", "notes.txt"]);
});
