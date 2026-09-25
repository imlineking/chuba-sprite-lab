import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import test from "node:test";
import sharp from "sharp";
import { analyzeFrameConsistency, clearRenderCache, inspectSource, keyFrame, processFramePreview, processSprites, processVideoBatch } from "../src/processor.mjs";
import { compositeAttachments, trackAttachmentPlacements } from "../src/attachment-tracker.mjs";
import { sliceSpriteSheet } from "../src/sheet-slicer.mjs";

function resolveTestFfmpeg(appRoot) {
  // The bundled Windows binary is preferred; otherwise fall back to ffmpeg from PATH.
  const bundled = path.join(appRoot, "vendor", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  return existsSync(bundled) ? bundled : process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

async function makeFrame(filePath, left, top) {
  const orange = await sharp({
    create: { width: 22, height: 26, channels: 4, background: { r: 225, g: 86, b: 18, alpha: 1 } },
  }).png().toBuffer();
  await sharp({
    create: { width: 64, height: 64, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  }).composite([{ input: orange, left, top }]).png().toFile(filePath);
}

test("background scope preserves an enclosed white detail unless all-colour removal is chosen", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-key-scope-"));
  const input = path.join(temp, "flower.png");
  const pixels = Buffer.alloc(16 * 16 * 4, 255);
  for (let y = 3; y <= 12; y += 1) for (let x = 3; x <= 12; x += 1) {
    pixels.set([20, 130, 50, 255], (y * 16 + x) * 4);
  }
  pixels.set([255, 255, 255, 255], (8 * 16 + 8) * 4);
  await sharp(pixels, { raw: { width: 16, height: 16, channels: 4 } }).png().toFile(input);
  const exterior = await keyFrame(input, "white", 20, 0, 0, { keyScope: "exterior" });
  const all = await keyFrame(input, "white", 20, 0, 0, { keyScope: "all" });
  const alphaAt = async (result, x, y) => (await sharp(result.buffer).ensureAlpha().raw().toBuffer())[(y * 16 + x) * 4 + 3];
  assert.equal(await alphaAt(exterior, 0, 0), 0);
  assert.equal(await alphaAt(exterior, 8, 8), 255);
  assert.equal(await alphaAt(all, 8, 8), 0);
});

test("frame preview applies inward colour repair without altering a white detail", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-edge-preview-"));
  const inputPath = path.join(temp, "edge.png");
  const pixels = Buffer.alloc(17 * 17 * 4);
  for (let y = 2; y <= 14; y += 1) for (let x = 2; x <= 14; x += 1) {
    pixels.set([20, 130, 30, 255], (y * 17 + x) * 4);
  }
  for (let y = 2; y <= 14; y += 1) pixels.set([255, 255, 255, 255], (y * 17 + 2) * 4);
  pixels.set([255, 255, 255, 255], (8 * 17 + 8) * 4);
  await sharp(pixels, { raw: { width: 17, height: 17, channels: 4 } }).png().toFile(inputPath);
  const preview = await processFramePreview({ inputPath, appRoot: path.resolve("."), options: { keyMode: "alpha", edgeRefine: { mode: "recolor", width: 1, depth: 5, whiteOnly: true } } });
  const result = await sharp(preview.afterPath).ensureAlpha().raw().toBuffer();
  assert.deepEqual([...result.subarray((8 * 17 + 2) * 4, (8 * 17 + 2) * 4 + 4)], [20, 130, 30, 255]);
  assert.deepEqual([...result.subarray((8 * 17 + 8) * 4, (8 * 17 + 8) * 4 + 4)], [255, 255, 255, 255]);
});

test("recommends local AI for a varied scene border, not a uniform custom color", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-sprite-ai-recommend-"));
  const varied = path.join(temp, "varied.png");
  const uniform = path.join(temp, "uniform.png");
  const rightHalf = await sharp({ create: { width: 40, height: 80, channels: 3, background: { r: 34, g: 77, b: 124 } } }).png().toBuffer();
  await sharp({ create: { width: 80, height: 80, channels: 3, background: { r: 230, g: 195, b: 117 } } })
    .composite([{ input: rightHalf, left: 40, top: 0 }]).png().toFile(varied);
  await sharp({ create: { width: 80, height: 80, channels: 3, background: { r: 112, g: 122, b: 138 } } })
    .png().toFile(uniform);
  const variedSource = await inspectSource({ kind: "frames", paths: [varied], appRoot: path.resolve(".") });
  const uniformSource = await inspectSource({ kind: "frames", paths: [uniform], appRoot: path.resolve(".") });
  assert.equal(variedSource.recommendations.keyMode, "ai");
  assert.equal(uniformSource.recommendations.keyMode, "auto");
  assert.equal(variedSource.recommendations.cellWidth, 0, "inspection should defer silhouette sizing until the model runs");
});

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
  assert.ok(manifest.frames.every((frame) => frame.hitbox && frame.hitbox.width > 0 && frame.hitbox.height > 0));
  assert.ok(manifest.frames.every((frame) => frame.hitbox.x >= 0 && frame.hitbox.x + frame.hitbox.width <= frame.sourceSize.w));
  assert.ok(manifest.frames.every((frame) => frame.hitboxSpace === "cell"), "the hitbox space must be declared explicitly");
  assert.equal(result.frameBounds.length, 3);
  assert.ok(result.frameBounds.every((frame) => frame.width > 0 && frame.height > 0), "the build must expose the bounds it measured");
  const report = JSON.parse(await fs.readFile(result.reportPath, "utf8"));
  assert.equal(report.outputFrames, 3);
  assert.ok(report.timingsMs && Number.isFinite(report.timingsMs.key));
  assert.equal(report.atlasIssues, undefined, "a healthy grid build must not report atlas issues");
});

test("a failed rebuild keeps the previous export, including with cleanOutput", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-sprite-atomic-export-"));
  const input = path.join(temp, "input");
  const output = path.join(temp, "output");
  await fs.mkdir(input, { recursive: true });
  await fs.mkdir(output, { recursive: true });
  const paths = [0, 1].map((index) => path.join(input, `frame-${index}.png`));
  await makeFrame(paths[0], 8, 25);
  await makeFrame(paths[1], 20, 21);

  const source = await inspectSource({ kind: "frames", paths, appRoot: path.resolve(".") });
  const options = {
    fps: 8, columns: 2, cellWidth: 128, cellHeight: 96, padding: 8, maxFrames: 10,
    tolerance: 18, keyMode: "white", anchor: "ground", pixelPerfect: true,
    removeDuplicates: false, outputBackground: "transparent",
  };
  const request = { source, outputDir: output, name: "atomic-export", appRoot: path.resolve(".") };

  const first = await processSprites({ ...request, options });
  const listing = async () => (await fs.readdir(first.outputDir, { recursive: true })).map(String).sort();
  const before = await listing();
  const manifestBefore = await fs.readFile(first.manifestPath, "utf8");
  assert.ok(before.some((file) => file.endsWith(".json")), "the first export must contain a manifest");
  assert.ok(before.some((file) => file.startsWith("frames")), "the first export must contain frames");

  // Fail at the latest possible point: every artifact is already written, but only
  // into the staging folder. cleanOutput must not delete the previous set first.
  await assert.rejects(
    () => processSprites({
      ...request,
      options: { ...options, cleanOutput: true },
      onProgress: (progress) => { if (progress.stage === "preview") throw new Error("injected late failure"); },
    }),
    /injected late failure/,
  );

  assert.deepEqual(await listing(), before, "a failed rebuild must not change the previous export");
  assert.equal(await fs.readFile(first.manifestPath, "utf8"), manifestBefore, "the previous manifest must stay intact");
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
  const ffmpeg = resolveTestFfmpeg(appRoot);
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
  const ffmpeg = resolveTestFfmpeg(appRoot);
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

  const stoppedOutput = path.join(temp, "stopped-output");
  const stopped = await processVideoBatch({
    paths: [firstVideo, secondVideo], outputDir: stoppedOutput, appRoot,
    shouldStop: () => true,
    options: {
      fps: 6, columns: 2, cellWidth: 96, cellHeight: 96, padding: 8, maxFrames: 10,
      tolerance: 25, keyMode: "white", anchor: "ground", autoSize: true, autoColumns: true,
      pixelPerfect: true, removeDuplicates: false, outputBackground: "transparent",
      exports: { sheet: true, frames: false, metadata: false, preview: false },
    },
  });
  assert.equal(stopped.completed, 1);
  assert.equal(stopped.stopped, true);
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
    aiForceModel: true,
    aiEdits: [],
  });
  const original = await sharp(inputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const hard = await sharp(clean.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < hard.info.width * hard.info.height; index += 1) {
    const offset = index * hard.info.channels;
    assert.ok(hard.data[offset + 3] === 0 || hard.data[offset + 3] === 255, "zero softness must produce a hard alpha mask");
    assert.deepEqual([...hard.data.subarray(offset, offset + 3)], [...original.data.subarray(offset, offset + 3)], "AI cleanup must not alter source RGB pixels");
  }
  const softened = await keyFrame(inputPath, "ai", 28, 3, 0, {
    appRoot, frameIndex: 0, aiCutoff: 42, aiSoftness: 2, aiForceModel: true, aiEdits: [],
  });
  const softPixels = await sharp(softened.buffer).ensureAlpha().raw().toBuffer();
  assert.ok(softPixels.some((_value, index) => index % 4 === 3 && softPixels[index] > 0 && softPixels[index] < 255), "soft AI matte should retain intermediate alpha");
  const fast = await keyFrame(inputPath, "ai", 28, 3, 0, {
    appRoot,
    frameIndex: 0,
    aiCutoff: 42,
    aiSoftness: 0,
    aiEdits: [],
  });
  assert.equal(fast.aiFastPath, "white", "uniform white backgrounds must bypass slow neural inference");
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

test("tracked mask regions follow a selected object without forcing neural inference", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-sprite-lab-track-test-"));
  const first = path.join(temp, "first.png");
  const second = path.join(temp, "second.png");
  const subject = await sharp({ create: { width: 24, height: 30, channels: 4, background: { r: 220, g: 72, b: 24, alpha: 1 } } }).png().toBuffer();
  const unwanted = await sharp({ create: { width: 10, height: 28, channels: 4, background: { r: 176, g: 176, b: 176, alpha: 1 } } }).png().toBuffer();
  for (const [filePath, wallLeft] of [[first, 5], [second, 9]]) {
    await sharp({ create: { width: 80, height: 64, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
      .composite([{ input: subject, left: 38, top: 22 }, { input: unwanted, left: wallLeft, top: 14 }])
      .png().toFile(filePath);
  }
  const edit = {
    type: "tracked-region", mode: "erase", color: [176, 176, 176], tolerance: 18,
    x: 10 / 79, y: 28 / 63, centroidX: 9.5 / 79, centroidY: 27.5 / 63,
    area: 280 / (80 * 64), selectionWidth: 10 / 80, selectionHeight: 28 / 64,
    searchRadius: 0.3, frameIndex: 0, applyAll: true, strokeId: 1,
  };
  const result = await keyFrame(second, "ai", 28, 3, 0, {
    appRoot: path.resolve("."), frameIndex: 1, aiCutoff: 50, aiSoftness: 0, aiEdits: [edit],
  });
  assert.equal(result.aiFastPath, "white", "tracked cleanup must keep the fast background path");
  const { data, info } = await sharp(result.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(data[(28 * info.width + 13) * info.channels + 3], 0, "the shifted unwanted object must be removed");
  assert.equal(data[(36 * info.width + 48) * info.channels + 3], 255, "the foreground subject must stay opaque");
  const direct = await keyFrame(second, "white", 28, 3, 0, { frameIndex: 1, aiEdits: [edit] });
  const directPixels = await sharp(direct.buffer).ensureAlpha().raw().toBuffer();
  assert.equal(directPixels[(28 * info.width + 13) * info.channels + 3], 0, "tracked cleanup must work with a regular background mode too");
});

test("magenta fringe cleanup repairs only contaminated transparent edges", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-sprite-lab-fringe-test-"));
  const input = path.join(temp, "fringe.png");
  const width = 24; const height = 24; const pixels = Buffer.alloc(width * height * 4);
  for (let y = 4; y <= 19; y += 1) {
    for (let x = 4; x <= 19; x += 1) {
      const offset = (y * width + x) * 4;
      const edge = x === 4 || x === 19 || y === 4 || y === 19;
      pixels[offset] = edge ? 236 : 192;
      pixels[offset + 1] = edge ? 24 : 78;
      pixels[offset + 2] = edge ? 218 : 42;
      pixels[offset + 3] = 255;
    }
  }
  await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toFile(input);
  const result = await keyFrame(input, "alpha", 28, 3, 0, { fringeCleanup: true, fringeStrength: 100 });
  const cleaned = await sharp(result.buffer).ensureAlpha().raw().toBuffer();
  const edgeOffset = (12 * width + 4) * 4;
  const centerOffset = (12 * width + 12) * 4;
  assert.ok(Math.min(cleaned[edgeOffset], cleaned[edgeOffset + 2]) - cleaned[edgeOffset + 1] < 80, "magenta edge must be neutralized");
  assert.deepEqual([...cleaned.subarray(centerOffset, centerOffset + 4)], [192, 78, 42, 255], "interior colors must remain untouched");
});

test("PNG attachments follow a marked point and composite over the cleaned frame", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-sprite-lab-attachment-test-"));
  const frames = [path.join(temp, "track-0.png"), path.join(temp, "track-1.png")];
  const markerCore = await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 230, g: 150, b: 35, alpha: 1 } } }).png().toBuffer();
  const marker = await sharp({ create: { width: 12, height: 12, channels: 4, background: { r: 36, g: 42, b: 48, alpha: 1 } } })
    .composite([{ input: markerCore, left: 4, top: 4 }]).png().toBuffer();
  for (const [index, filePath] of frames.entries()) {
    await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
      .composite([{ input: marker, left: 18 + index * 5, top: 27 }]).png().toFile(filePath);
  }
  const overlay = path.join(temp, "bouquet.png");
  await sharp({ create: { width: 10, height: 8, channels: 4, background: { r: 30, g: 220, b: 70, alpha: 1 } } }).png().toFile(overlay);
  const attachment = {
    id: "test", path: overlay, title: "bouquet.png", frameIndex: 0,
    points: [{ x: 24 / 63, y: 33 / 63 }], sizeRatio: 0.16, rotation: 0, anchorX: 0.5, anchorY: 0.5,
  };
  const placements = await trackAttachmentPlacements(frames, [attachment]);
  assert.ok(placements[1][0].points[0].x > placements[0][0].points[0].x + 0.035, "tracked point must follow the moving marker");
  const base = await keyFrame(frames[1], "white", 28);
  const composed = await compositeAttachments(base, placements[1]);
  const { data, info } = await sharp(composed.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const point = placements[1][0].points[0];
  const offset = (Math.round(point.y * (info.height - 1)) * info.width + Math.round(point.x * (info.width - 1))) * info.channels;
  assert.ok(data[offset + 1] > data[offset] && data[offset + 1] > data[offset + 2], "the PNG element must be visible at the tracked point");
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

test("black contour protection scales with high-resolution source frames", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-sprite-lab-scaled-black-key-test-"));
  const inputPath = path.join(temp, "large-black-background.png");
  const subject = await sharp({
    create: { width: 220, height: 220, channels: 4, background: { r: 224, g: 122, b: 58, alpha: 1 } },
  }).png().toBuffer();
  await sharp({
    create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
  }).composite([{ input: subject, left: 402, top: 402 }]).png().toFile(inputPath);

  const keyed = await keyFrame(inputPath, "black", 20, 5);
  const { data, info } = await sharp(keyed.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alphaAt = (x, y) => data[(y * info.width + x) * info.channels + 3];
  assert.equal(alphaAt(393, 512), 255, "a high-resolution dark outline should receive scaled protection");
  assert.equal(alphaAt(388, 512), 0, "distant black background must still be transparent");
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

test("frame transform changes proportions and can stretch the object to cell edges", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-sprite-transform-test-"));
  const inputPath = path.join(temp, "frame.png");
  await makeFrame(inputPath, 20, 19);
  const source = await inspectSource({ kind: "frames", paths: [inputPath], appRoot: path.resolve(".") });
  const common = {
    keyMode: "white", tolerance: 18, anchor: "center", autoSize: false, autoColumns: false,
    columns: 1, cellWidth: 100, cellHeight: 80, padding: 10, removeDuplicates: false,
    pixelPerfect: true, outputBackground: "transparent",
  };
  const base = await processSprites({
    source, outputDir: null, name: "base", appRoot: path.resolve("."), previewOnly: true, options: common,
  });
  const stretched = await processSprites({
    source, outputDir: null, name: "scaled", appRoot: path.resolve("."), previewOnly: true,
    options: { ...common, frameTransforms: { 0: { scaleX: 1.8, scaleY: 0.55, offsetX: 0, offsetY: 0, skewX: 0 } } },
  });
  const filled = await processSprites({
    source, outputDir: null, name: "filled", appRoot: path.resolve("."), previewOnly: true,
    options: { ...common, frameTransforms: { "*": { fill: "stretch" } } },
  });
  const skewed = await processSprites({
    source, outputDir: null, name: "skewed", appRoot: path.resolve("."), previewOnly: true,
    options: { ...common, frameTransforms: { 0: { scaleX: 1, scaleY: 1, skewX: 22 } } },
  });
  const trimmedInfo = async (filePath) => (await sharp(filePath).trim().png().toBuffer({ resolveWithObject: true })).info;
  const baseInfo = await trimmedInfo(base.framePaths[0]);
  const stretchedInfo = await trimmedInfo(stretched.framePaths[0]);
  const filledInfo = await trimmedInfo(filled.framePaths[0]);
  const skewedInfo = await trimmedInfo(skewed.framePaths[0]);
  assert.ok(stretchedInfo.width > baseInfo.width * 1.5, "independent width control must widen the selected object");
  assert.ok(stretchedInfo.height < baseInfo.height * 0.75, "independent height control must flatten the selected object");
  assert.equal(filledInfo.width, 100, "fill mode must reach both horizontal cell edges");
  assert.equal(filledInfo.height, 80, "fill mode must reach both vertical cell edges");
  assert.ok(skewedInfo.width > 0 && skewedInfo.height > 0, "perspective skew must produce a visible sprite");
  const filledManifest = JSON.parse(await fs.readFile(filled.manifestPath, "utf8"));
  assert.equal(filledManifest.frames[0].transform.fill, "stretch", "manifest must describe the applied frame transform");
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

test("smart sheet slicing groups disconnected parts and keeps irregular rows", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-sheet-slice-test-"));
  const sheetPath = path.join(temp, "sheet.png");
  const orange = await sharp({ create: { width: 28, height: 34, channels: 4, background: { r: 220, g: 84, b: 22, alpha: 1 } } }).png().toBuffer();
  const brown = await sharp({ create: { width: 42, height: 38, channels: 4, background: { r: 92, g: 54, b: 28, alpha: 1 } } }).png().toBuffer();
  await sharp({ create: { width: 300, height: 220, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .composite([
      { input: orange, left: 18, top: 24 }, { input: orange, left: 62, top: 32 },
      { input: brown, left: 225, top: 25 }, { input: brown, left: 114, top: 150 },
    ]).png().toFile(sheetPath);
  const smart = await sliceSpriteSheet(sheetPath, path.join(temp, "smart"), { mode: "objects" });
  assert.equal(smart.framePaths.length, 3, "two nearby disconnected pieces must become one object");
  const grid = await sliceSpriteSheet(sheetPath, path.join(temp, "grid"), { mode: "grid", columns: 2, rows: 2 });
  assert.equal(grid.framePaths.length, 4, "manual grid mode must remain available for regular sheets");
});

test("sheet repair isolates neighboring objects and accepts exact manual coordinates", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-sheet-repair-test-"));
  const sheetPath = path.join(temp, "nearby.png");
  const first = await sharp({ create: { width: 72, height: 70, channels: 4, background: { r: 238, g: 92, b: 21, alpha: 1 } } }).png().toBuffer();
  const second = await sharp({ create: { width: 72, height: 70, channels: 4, background: { r: 25, g: 90, b: 210, alpha: 1 } } }).png().toBuffer();
  await sharp({ create: { width: 200, height: 100, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .composite([{ input: first, left: 12, top: 15 }, { input: second, left: 100, top: 15 }]).png().toFile(sheetPath);
  const smart = await sliceSpriteSheet(sheetPath, path.join(temp, "auto"), { mode: "objects" });
  assert.equal(smart.cells.length, 2);
  assert.ok(smart.cells[0].left + smart.cells[0].width <= smart.cells[1].left, "automatic crops must not include the next object");
  const manual = await sliceSpriteSheet(sheetPath, path.join(temp, "manual"), { mode: "manual", cells: [{ left: 12, top: 15, width: 72, height: 70 }, { left: 100, top: 15, width: 72, height: 70 }] });
  assert.deepEqual(manual.cells, [{ left: 12, top: 15, width: 72, height: 70 }, { left: 100, top: 15, width: 72, height: 70 }]);
  const repaired = await processSprites({
    source: { kind: "sheet", paths: manual.framePaths, title: "nearby", sheetCells: manual.cells, sheetFrameNames: ["left", "right"] },
    outputDir: path.join(temp, "output"), name: "repaired", appRoot: path.resolve("."),
    options: { keyMode: "white", autoSize: true, autoColumns: true, padding: 8, maxFrames: 2, anchor: "center", pixelPerfect: true, removeDuplicates: false, outputBackground: "transparent", exports: { sheet: true, frames: true, metadata: true, preview: false } },
  });
  const manifest = JSON.parse(await fs.readFile(repaired.manifestPath, "utf8"));
  assert.deepEqual(manifest.frames.map((frame) => frame.sourceName), ["left", "right"]);
  assert.deepEqual(manifest.frames.map((frame) => frame.sourceRect), manual.cells);
  await assert.rejects(() => sliceSpriteSheet(sheetPath, path.join(temp, "invalid"), { mode: "manual", cells: [{ left: 190, top: 0, width: 20, height: 20 }] }), /выходит за границы/);
});

test("transparent sheet detector keeps white opaque sprites", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-transparent-sheet-test-"));
  const sheetPath = path.join(temp, "white-sprites.png");
  const white = await sharp({ create: { width: 40, height: 35, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer();
  await sharp({ create: { width: 230, height: 90, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: white, left: 20, top: 24 }, { input: white, left: 160, top: 24 }]).png().toFile(sheetPath);
  const sliced = await sliceSpriteSheet(sheetPath, path.join(temp, "frames"), { mode: "objects" });
  assert.deepEqual(sliced.cells, [{ left: 20, top: 24, width: 40, height: 35 }, { left: 160, top: 24, width: 40, height: 35 }]);
});

test("edge decontamination unmixes a soft edge against the key colour", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-decontaminate-test-"));
  const inputPath = path.join(temp, "soft-edge.png");
  // A sprite flattened onto white: its boundary band is a real blend of subject and
  // background, which is exactly the halo that shows up around fur and thin edges.
  const size = 64;
  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const inside = x >= 20 && x < 42 && y >= 18 && y < 44;
      const distanceToEdge = Math.min(x - 20, 41 - x, y - 18, 43 - y);
      const coverage = inside ? Math.max(0, Math.min(1, (distanceToEdge + 1) / 3)) : 0;
      data[offset] = Math.round(225 * coverage + 255 * (1 - coverage));
      data[offset + 1] = Math.round(86 * coverage + 255 * (1 - coverage));
      data[offset + 2] = Math.round(18 * coverage + 255 * (1 - coverage));
      data[offset + 3] = 255;
    }
  }
  await sharp(data, { raw: { width: size, height: size, channels: 4 } }).png().toFile(inputPath);

  const appRoot = path.resolve(".");
  const plain = await keyFrame(inputPath, "white", 28, 3, 0, { appRoot, frameIndex: 0 });
  const cleaned = await keyFrame(inputPath, "white", 28, 3, 0, { appRoot, frameIndex: 0, edgeDecontaminate: true });
  const [before, after] = await Promise.all([
    sharp(plain.buffer).ensureAlpha().raw().toBuffer(),
    sharp(cleaned.buffer).ensureAlpha().raw().toBuffer(),
  ]);
  assert.equal(before.length, after.length);

  let edges = 0;
  let moved = 0;
  let beforeSum = 0;
  let afterSum = 0;
  for (let index = 0; index < before.length; index += 4) {
    assert.equal(before[index + 3], after[index + 3], "decontamination must not change opacity");
    const alpha = before[index + 3];
    if (alpha === 0 || alpha === 255) continue;
    edges += 1;
    beforeSum += before[index] + before[index + 1] + before[index + 2];
    afterSum += after[index] + after[index + 1] + after[index + 2];
    if (before[index] !== after[index] || before[index + 1] !== after[index + 1] || before[index + 2] !== after[index + 2]) moved += 1;
  }
  assert.ok(edges > 0, "the fixture must produce semi-transparent edge pixels");
  assert.ok(moved > 0, "decontamination must change edge colours");
  // White is the brightest possible background, so unmixing can only make the edge darker.
  assert.ok(afterSum < beforeSum, `edge pixels must move away from white: ${beforeSum} -> ${afterSum}`);
});

test("the processing width changes nothing about the result", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-parallel-test-"));
  const input = path.join(temp, "input");
  await fs.mkdir(input, { recursive: true });
  const positions = [[8, 25], [20, 21], [31, 18], [14, 24]];
  const paths = positions.map((_position, index) => path.join(input, `frame-${index}.png`));
  for (const [index, [left, top]] of positions.entries()) await makeFrame(paths[index], left, top);

  const source = await inspectSource({ kind: "frames", paths, appRoot: path.resolve(".") });
  const base = {
    keyMode: "white", anchor: "ground", autoSize: true, autoColumns: true, padding: 8,
    removeDuplicates: false, outputBackground: "transparent", maxFrames: 10,
    exports: { sheet: true, frames: true, metadata: true, preview: false },
  };
  const build = async (frameParallelism) => {
    // Each width must do its own work: the shared caches would otherwise answer the second run.
    clearRenderCache();
    const result = await processSprites({
      source, outputDir: path.join(temp, `out-${frameParallelism}`), name: "parallel",
      appRoot: path.resolve("."), options: { ...base, frameParallelism },
    });
    return {
      manifest: JSON.parse(await fs.readFile(result.manifestPath, "utf8")),
      sheet: await fs.readFile(result.sheetPath),
      frames: await Promise.all(result.framePaths.map((file) => fs.readFile(file))),
      report: JSON.parse(await fs.readFile(result.reportPath, "utf8")),
    };
  };

  const serial = await build(1);
  const parallel = await build(3);
  assert.deepEqual(parallel.manifest, serial.manifest, "the manifest must not depend on scheduling");
  assert.equal(parallel.frames.length, serial.frames.length);
  for (const [index, buffer] of parallel.frames.entries()) {
    assert.ok(buffer.equals(serial.frames[index]), `frame ${index} differs between widths`);
  }
  assert.ok(parallel.sheet.equals(serial.sheet), "the atlas must be byte-identical");
  assert.ok(serial.report.buildMs && Number.isFinite(serial.report.buildMs.sheet), "the atlas stage must be timed");
});

test("pixel art reaches the exported frame and snaps the cell to its grid", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-pixelate-test-"));
  const input = path.join(temp, "input");
  await fs.mkdir(input, { recursive: true });
  const paths = [0, 1].map((index) => path.join(input, `frame-${index}.png`));
  await makeFrame(paths[0], 8, 25);
  await makeFrame(paths[1], 20, 21);
  const source = await inspectSource({ kind: "frames", paths, appRoot: path.resolve(".") });
  const base = {
    keyMode: "white", anchor: "ground", autoSize: true, autoColumns: true, padding: 20,
    removeDuplicates: false, outputBackground: "transparent", maxFrames: 10,
    exports: { sheet: true, frames: true, metadata: true, preview: false },
  };
  const build = async (pixelateOptions) => {
    clearRenderCache();
    const result = await processSprites({
      source, outputDir: path.join(temp, pixelateOptions ? "art" : "plain"), name: "pixel",
      appRoot: path.resolve("."), options: { ...base, ...(pixelateOptions ? { pixelate: pixelateOptions } : {}) },
    });
    return { result, frame: await fs.readFile(result.framePaths[0]) };
  };

  const plain = await build(null);
  const art = await build({ size: 6, colors: 8, mode: "outline", palette: "auto" });

  // The cell has to divide by the pixel size, otherwise the blocks on the far edge come out wider.
  assert.equal(art.result.cellWidth % 6, 0, `cell width ${art.result.cellWidth} must divide by 6`);
  assert.equal(art.result.cellHeight % 6, 0, `cell height ${art.result.cellHeight} must divide by 6`);
  assert.ok(art.result.cellWidth >= plain.result.cellWidth, "snapping only ever grows the cell");
  assert.ok(!art.frame.equals(plain.frame), "the redraw must reach the exported frame");

  // Every block of the grid must be one flat colour.
  const { data, info } = await sharp(art.frame).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const block = art.result.cellWidth / 6;
  assert.ok(Number.isInteger(block), "the grid must be a whole number of blocks");
  const at = (x, y) => {
    const offset = (y * info.width + x) * 4;
    return [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]];
  };
  assert.deepEqual(at(block, block), at(block + block - 1, block + block - 1), "a block must be flat");
});

test("size assistant suggests proportional scale only for comparable poses", () => {
  // Bounds come straight from a finished build, so this is a pure calculation.
  const analysis = analyzeFrameConsistency([
    { index: 0, width: 20, height: 20 },
    { index: 1, width: 30, height: 30 },
    { index: 2, width: 20, height: 40 },
  ]);
  assert.equal(analysis.targetHeight, 30);
  assert.equal(analysis.frames[0].proposedScale, 1.5);
  assert.equal(analysis.frames[2].confidence, "different-pose");
  assert.equal(analysis.frames[2].proposedScale, 1);
  assert.deepEqual(analysis.frames.map((frame) => frame.index), [0, 1, 2]);
});

test("body anchor keeps the solid object steady while preserving a growing thin tail", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-body-anchor-"));
  const paths = [];
  for (const [index, tail] of [8, 50].entries()) {
    const body = await sharp({ create: { width: 24, height: 24, channels: 4, background: { r: 220, g: 35, b: 20, alpha: 1 } } }).png().toBuffer();
    const thread = await sharp({ create: { width: tail, height: 2, channels: 4, background: { r: 220, g: 35, b: 20, alpha: 1 } } }).png().toBuffer();
    const file = path.join(temp, `${index}.png`);
    await sharp({ create: { width: 100, height: 56, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: body, left: 10, top: 12 }, { input: thread, left: 34, top: 23 }]).png().toFile(file);
    paths.push(file);
  }
  const result = await processSprites({
    source: { kind: "frames", paths, title: "tail" }, outputDir: path.join(temp, "out"), name: "tail", appRoot: path.resolve("."),
    options: { keyMode: "alpha", anchor: "body", autoSize: true, autoColumns: true, padding: 12, maxFrames: 2, removeDuplicates: false, pixelPerfect: true, outputBackground: "transparent", exports: { sheet: true, frames: true, metadata: true, preview: false } },
  });
  const bodyCenters = [];
  for (const file of result.framePaths) {
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let total = 0; let sum = 0; let edge = 0;
    for (let y = 0; y < info.height; y += 1) for (let x = 0; x < info.width; x += 1) {
      const alpha = data[(y * info.width + x) * 4 + 3];
      if (alpha > 12 && (x < 2 || x >= info.width - 2 || y < 2 || y >= info.height - 2)) edge += 1;
      if (alpha > 12 && y >= info.height / 2 - 12 && y < info.height / 2 + 12 && x < info.width / 2 + 12) { total += alpha; sum += x * alpha; }
    }
    assert.equal(edge, 0, "the full tail must fit inside the exported cell");
    bodyCenters.push(Math.round(sum / total));
  }
  assert.ok(Math.abs(bodyCenters[0] - bodyCenters[1]) <= 2, `body jumped: ${bodyCenters}`);
});

test("size assistant measures frames as the transform will place them", () => {
  const analysis = analyzeFrameConsistency(
    [{ index: 0, width: 20, height: 20 }, { index: 7, width: 20, height: 10 }],
    { transforms: { "*": { scaleX: 2, scaleY: 2 }, 7: { scaleX: 1, scaleY: 1 } } },
  );
  assert.deepEqual(analysis.frames.map((frame) => [frame.index, frame.width, frame.height]), [[0, 40, 40], [7, 20, 10]]);
});

test("size assistant can use an explicit reference silhouette", () => {
  const analysis = analyzeFrameConsistency([
    { index: 0, width: 40, height: 40 },
    { index: 1, width: 20, height: 20 },
  ], { referenceIndex: 0 });
  assert.equal(analysis.referenceIndex, 0);
  assert.equal(analysis.frames[1].proposedScale, 1.5);
  assert.throws(() => analyzeFrameConsistency([{ index: 0, width: 20, height: 20 }], { referenceIndex: 8 }), /Опорный кадр/);
});

test("size assistant refuses an empty or oversized measurement set", () => {
  assert.throws(() => analyzeFrameConsistency([]), /до 256 кадров/);
  assert.throws(() => analyzeFrameConsistency(new Array(257).fill({ index: 0, width: 1, height: 1 })), /до 256 кадров/);
});

test("warning frame numbers follow the source frames, not the filtered list", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-frame-issues-"));
  const input = path.join(temp, "input");
  await fs.mkdir(input, { recursive: true });
  const sizes = [[22, 26], [22, 26], [22, 26], [60, 26]];
  const paths = [];
  for (const [index, [width, height]] of sizes.entries()) {
    const block = await sharp({ create: { width, height, channels: 4, background: { r: 225, g: 86, b: 18, alpha: 1 } } }).png().toBuffer();
    const file = path.join(input, `frame-${index}.png`);
    await sharp({ create: { width: 96, height: 96, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
      .composite([{ input: block, left: 16, top: 20 }]).png().toFile(file);
    paths.push(file);
  }
  const source = await inspectSource({ kind: "frames", paths, appRoot: path.resolve(".") });
  const options = {
    keyMode: "white", anchor: "ground", autoSize: true, autoColumns: true, padding: 8,
    removeDuplicates: false, outputBackground: "transparent", maxFrames: 10, excludedFrames: [0],
  };
  const result = await processSprites({ source, appRoot: path.resolve("."), previewOnly: true, options });

  const widthIssue = result.frameIssues.find((issue) => issue.message.includes("ширина силуэта"));
  assert.ok(widthIssue, `expected a width warning, warnings were ${JSON.stringify(result.warnings)}`);
  // Source frame 0 is excluded, so the first reported frame is source frame 1.
  assert.equal(widthIssue.frameIndex, 1, "an excluded frame must not shift the reported number");
  assert.ok(widthIssue.message.startsWith("Кадр 2:"), widthIssue.message);
  assert.ok(result.frameIssues.some((issue) => issue.frameIndex === 3), "the wide source frame must be reported");
  assert.ok(!result.frameIssues.some((issue) => issue.frameIndex === 0), "an excluded frame must not be reported");
  for (const issue of result.frameIssues) {
    assert.ok(result.warnings.includes(issue.message), "every structured issue must also appear in the plain list");
  }

  const report = JSON.parse(await fs.readFile(result.reportPath, "utf8"));
  assert.match(report.recipe.hash, /^[a-f\d]{16}$/, "the report must identify its recipe");
  assert.equal(typeof report.recipe.appVersion, "string");
  const again = await processSprites({ source, appRoot: path.resolve("."), previewOnly: true, options });
  const repeated = JSON.parse(await fs.readFile(again.reportPath, "utf8"));
  assert.equal(repeated.recipe.hash, report.recipe.hash, "the same recipe must hash the same");
});

test("an externally edited frame replaces the extracted source on rebuild", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-frame-override-test-"));
  const original = path.join(temp, "original.png");
  const edited = path.join(temp, "edited.png");
  await sharp({ create: { width: 48, height: 48, channels: 4, background: { r: 210, g: 60, b: 25, alpha: 1 } } }).png().toFile(original);
  await sharp({ create: { width: 48, height: 48, channels: 4, background: { r: 20, g: 90, b: 220, alpha: 1 } } }).png().toFile(edited);
  const source = await inspectSource({ kind: "frames", paths: [original], appRoot: path.resolve(".") });
  const result = await processSprites({
    source, outputDir: null, name: "override", appRoot: path.resolve("."), previewOnly: true,
    options: { keyMode: "alpha", anchor: "center", autoSize: true, autoColumns: true, padding: 4, removeDuplicates: false, frameOverrides: { 0: edited } },
  });
  assert.equal(result.allSourceFramePaths[0], edited);
  const { data, info } = await sharp(result.framePaths[0]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const offset = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
  assert.deepEqual([...data.subarray(offset, offset + 3)], [20, 90, 220]);
});
