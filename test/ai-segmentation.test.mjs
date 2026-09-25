import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { aiProviders, aiQualityModes, otsuThreshold, providerAttempts, segmentSubject, tilePlan, tileRects } from "../src/ai-segmentation.mjs";

test("the accelerator order follows the requested mode and the platform", () => {
  assert.deepEqual(providerAttempts("cpu", "win32"), ["cpu"]);
  assert.deepEqual(providerAttempts("cpu", "linux"), ["cpu"]);
  assert.deepEqual(providerAttempts("dml", "win32"), ["dml", "cpu"], "an explicit GPU request must still fall back");
  assert.deepEqual(providerAttempts("auto", "win32"), ["dml", "cpu"]);
  assert.deepEqual(providerAttempts("auto", "darwin"), ["cpu"], "DirectML is a Windows provider");
  assert.deepEqual(providerAttempts("nonsense", "win32"), ["dml", "cpu"], "an unknown mode behaves like auto");
  assert.deepEqual(providerAttempts(undefined, "linux"), ["cpu"]);
});

test("the provider list is the closed vocabulary the profile validates", () => {
  assert.deepEqual(aiProviders, ["auto", "cpu", "dml"]);
});

test("tiling only engages for frames much larger than the model input", () => {
  assert.deepEqual(tilePlan(320, 320, "balanced"), { across: 1, down: 1, useTiles: false, quality: "balanced" });
  assert.equal(tilePlan(640, 480, "balanced").useTiles, false, "a frame near the input size needs no tiles");
  const large = tilePlan(1920, 1080, "balanced");
  assert.equal(large.useTiles, true);
  assert.equal(large.across, 3);
  assert.equal(large.down, 2);
  assert.equal(tilePlan(4000, 4000, "balanced").across, 4, "the tile count is capped");
  assert.equal(tilePlan(1920, 1080, "fast").useTiles, false, "the fast mode never tiles");
  assert.equal(tilePlan(1920, 1080, "max").useTiles, true);
  assert.deepEqual(aiQualityModes, ["fast", "balanced", "max"]);
});

test("tiles cover every pixel and stay inside the frame", () => {
  const width = 1920;
  const height = 1080;
  const rects = tileRects(width, height, { across: 3, down: 2 });
  assert.equal(rects.length, 6);
  const covered = new Uint8Array(width * height);
  for (const rect of rects) {
    assert.ok(rect.left >= 0 && rect.top >= 0);
    assert.ok(rect.left + rect.width <= width && rect.top + rect.height <= height);
    assert.ok(rect.width > 0 && rect.height > 0);
    for (let y = 0; y < rect.height; y += 1) {
      for (let x = 0; x < rect.width; x += 1) covered[(rect.top + y) * width + rect.left + x] = 1;
    }
  }
  assert.equal(covered.reduce((sum, value) => sum + value, 0), width * height, "no pixel may be left uncovered");
});

test("Otsu splits a two-peak histogram between the peaks", () => {
  const counts = new Array(256).fill(0);
  for (let level = 20; level < 60; level += 1) counts[level] = 50;
  for (let level = 190; level < 230; level += 1) counts[level] = 40;
  const split = otsuThreshold(counts);
  assert.ok(split >= 59 && split < 190, `the split must fall between the peaks, got ${split}`);

  assert.equal(otsuThreshold(new Array(256).fill(0)), null, "an empty histogram has no split");
  assert.equal(otsuThreshold([]), null);
  const single = new Array(256).fill(0);
  single[128] = 10;
  assert.equal(otsuThreshold(single), null, "a single level has nothing to split");
});

test("a large frame with a small subject is segmented through tiles", async (context) => {
  const appRoot = path.resolve(".");
  try {
    await fs.access(path.join(appRoot, "models", "u2netp.onnx"));
  } catch {
    context.skip("local AI model is not prepared");
    return;
  }
  const width = 1600;
  const height = 1200;
  const data = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const x = index % width;
    const y = Math.floor(index / width);
    const inSubject = x >= 1100 && x < 1190 && y >= 300 && y < 390;
    data[index * 4] = inSubject ? 225 : 255;
    data[index * 4 + 1] = inSubject ? 86 : 255;
    data[index * 4 + 2] = inSubject ? 18 : 255;
    data[index * 4 + 3] = 255;
  }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-tiles-test-"));
  const inputPath = path.join(temp, "large.png");
  await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(inputPath);

  const single = await segmentSubject(inputPath, { appRoot, cutoff: "auto", quality: "fast" });
  assert.equal(single.tiles, 1);
  assert.equal(single.autoThreshold, true);

  const tiled = await segmentSubject(inputPath, { appRoot, cutoff: "auto", quality: "balanced" });
  assert.ok(tiled.tiles > 1, "a 1600 pixel frame must be split into tiles");
  assert.equal(tiled.quality, "balanced");
  assert.ok(tiled.coverage > 0.0005 && tiled.coverage < 0.05, `the subject is small, coverage was ${tiled.coverage}`);

  // The subject centre must survive the mask and a corner of the frame must be gone.
  const masked = await sharp(tiled.data, { raw: tiled.info }).png().toBuffer();
  const pixels = await sharp(masked).ensureAlpha().raw().toBuffer();
  const centre = (345 * width + 1145) * 4 + 3;
  const corner = (10 * width + 10) * 4 + 3;
  assert.ok(pixels[centre] > 128, "the subject centre must stay opaque");
  assert.ok(pixels[corner] < 128, "the background corner must become transparent");
});
