import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { processImageBatch } from "../src/image-batch.mjs";
import { keyFrame } from "../src/processor.mjs";
import { sliceSpriteSheet } from "../src/sheet-slicer.mjs";

const options = { keyMode: "custom", keyColor: [210, 30, 170], keyScope: "all", tolerance: 1, autoSize: true, autoColumns: true, padding: 4, anchor: "body", pixelPerfect: true, maxFrames: 1000 };

test("batch grouping keeps loose leaves with tall objects without losing pixels", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-fragments-"));
  try {
    const data = Buffer.alloc(320 * 240 * 4); let originalCount = 0;
    for (const [left, top, width, height] of [[30, 10, 50, 200], [230, 10, 50, 200], [215, 20, 5, 5], [215, 180, 5, 5]]) {
      for (let y = top; y < top + height; y++) for (let x = left; x < left + width; x++) { data.set([12, 80, 36, 255], (y * 320 + x) * 4); originalCount++; }
    }
    const file = path.join(root, "trees.png"); await sharp(data, { raw: { width: 320, height: 240, channels: 4 } }).png().toFile(file);
    const sliced = await sliceSpriteSheet(file, path.join(root, "frames"), { mode: "objects", alphaOnly: true, attachFragments: true });
    assert.equal(sliced.framePaths.length, 2);
    let count = 0;
    for (const frame of sliced.framePaths) { const pixels = await sharp(frame).ensureAlpha().raw().toBuffer(); for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) count++; }
    assert.equal(count, originalCount);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

async function fixture(root, name, transparent = false) {
  const pixels = Buffer.alloc(64 * 48 * 4);
  for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) pixels.set([210, 30, 170, transparent ? 0 : 255], (y * 64 + x) * 4);
  for (let y = 8; y < 36; y++) for (let x = 6; x < 30; x++) pixels.set([12, 80, 36, 255], (y * 64 + x) * 4);
  // Closed background error and a white flower: remove only the chosen magenta.
  pixels.set([210, 30, 170, 255], (18 * 64 + 18) * 4);
  pixels.set([255, 255, 255, 255], (24 * 64 + 18) * 4);
  const file = path.join(root, name); await sharp(pixels, { raw: { width: 64, height: 48, channels: 4 } }).png().toFile(file); return file;
}

test("batch removes a custom colour from opaque and transparent files, produces matching atlases and JSON, and preserves source files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-image-batch-test-"));
  try {
    const paths = [await fixture(root, "tree.png"), await fixture(root, "bush.png", true)];
    const originals = await Promise.all(paths.map(file => fs.readFile(file)));
    const result = await processImageBatch({ paths, outputDir: path.join(root, "exports"), appRoot: path.resolve("."), options });
    assert.equal(result.completed, 2); assert.equal(result.failed, 0);
    for (const item of result.results) {
      const manifest = JSON.parse(await fs.readFile(item.manifestPath));
      const { data, info } = await sharp(item.sheetPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      assert.equal(manifest.frames.length, item.frameCount); assert.equal(manifest.image, path.basename(item.sheetPath));
      let white = 0; let magenta = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 12) {
        if (data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255) white++;
        if (data[i] === 210 && data[i + 1] === 30 && data[i + 2] === 170) magenta++;
      }
      assert.equal(white, 1); assert.equal(magenta, 0);
      for (const frame of manifest.frames) assert.ok(frame.x + frame.width <= info.width && frame.y + frame.height <= info.height);
    }
    const repeat = await processImageBatch({ paths, outputDir: path.join(root, "exports"), appRoot: path.resolve("."), options });
    assert.notEqual(repeat.results[0].outputDir, result.results[0].outputDir);
    assert.notEqual(repeat.reportPath, result.reportPath);
    for (const [index, file] of paths.entries()) assert.deepEqual(await fs.readFile(file), originals[index]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("background-only cleaning starts at isolated transparency while preserving closed opaque details", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-transparent-hole-"));
  try {
    const pixels = Buffer.alloc(20 * 20 * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set([12, 80, 36, 255], i);
    pixels.set([0, 0, 0, 0], (10 * 20 + 10) * 4);
    pixels.set([210, 30, 170, 255], (10 * 20 + 11) * 4);
    pixels.set([210, 30, 170, 255], (4 * 20 + 4) * 4);
    const file = path.join(root, "hole.png"); await sharp(pixels, { raw: { width: 20, height: 20, channels: 4 } }).png().toFile(file);
    const keyed = await keyFrame(file, "custom", 1, 0, 0, { keyColor: options.keyColor, keyScope: "exterior" });
    const data = await sharp(keyed.buffer).ensureAlpha().raw().toBuffer();
    assert.equal(data[(10 * 20 + 11) * 4 + 3], 0); assert.equal(data[(4 * 20 + 4) * 4 + 3], 255);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("batch continues after a bad file and can stop after one completed atlas", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-image-queue-"));
  try {
    const good = await fixture(root, "good.png");
    const bad = path.join(root, "bad.png"); await fs.writeFile(bad, "invalid image");
    const result = await processImageBatch({ paths: [bad, good], outputDir: path.join(root, "out"), options, appRoot: path.resolve(".") });
    assert.equal(result.failed, 1); assert.equal(result.completed, 1); assert.match(result.failures[0].input, /bad.png$/);
    let stop = false;
    const controller = new AbortController();
    const stopped = await processImageBatch({ paths: [good, bad], outputDir: path.join(root, "stopped"), options, appRoot: path.resolve("."), signal: controller.signal,
      onProgress: progress => { if (progress.value >= 0.5) stop = true; }, shouldStop: () => stop });
    assert.equal(stopped.completed, 1); assert.equal(stopped.stopped, true); assert.equal(stopped.failed, 0);
    controller.abort();
    const cancelled = await processImageBatch({ paths: [good], outputDir: path.join(root, "cancelled"), options, signal: controller.signal });
    assert.equal(cancelled.cancelled, true); assert.equal(cancelled.completed, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
