import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import sharp from "sharp";
import { inspectSource, keyFrame, processFramePreview, processSprites, processVideoBatch } from "../src/processor.mjs";
import { compositeAttachments, trackAttachmentPlacements } from "../src/attachment-tracker.mjs";
import { sliceSpriteSheet } from "../src/sheet-slicer.mjs";

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
