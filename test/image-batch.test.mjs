import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { processImageBatch, inspectCleanupQuality } from "../src/image-batch.mjs";
import { keyFrame } from "../src/processor.mjs";
import { sliceSpriteSheet } from "../src/sheet-slicer.mjs";
import { backgroundKeyMode } from "../src/background-analysis.mjs";

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

test("image-only batch includes RGBA review of the actual cleaned PNG", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cslab-matte-batch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = await fixture(root, "flower.png");
  const original = await fs.readFile(file);
  const result = await processImageBatch({ paths: [file], outputDir: path.join(root, "out"), outputKind: "images", options, appRoot: path.resolve(".") });
  assert.equal(result.failed, 0);
  const review = result.results[0].matteReview;
  assert.equal(review.width, 64);
  assert.equal(review.height, 48);
  assert.ok(review.clear > 0);
  assert.equal(review.opaque + review.partial + review.clear, 64 * 48);
  assert.deepEqual(await fs.readFile(file), original);
});

test("automatic image cleanup removes each flat background colour and keeps enclosed matching details", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cslab-flat-key-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const colours = { white: [255, 255, 255], black: [0, 0, 0], green: [0, 255, 0], magenta: [255, 0, 255] };
  const paths = [];
  for (const [name, colour] of Object.entries(colours)) {
    const pixels = Buffer.alloc(80 * 80 * 4);
    for (let offset = 0; offset < pixels.length; offset += 4) pixels.set([...colour, 255], offset);
    for (let y = 20; y < 60; y++) for (let x = 20; x < 60; x++) pixels.set([128, 75, 30, 255], (y * 80 + x) * 4);
    pixels.set([...colour, 255], (40 * 80 + 40) * 4);
    const file = path.join(root, `${name}.png`);
    await sharp(pixels, { raw: { width: 80, height: 80, channels: 4 } }).png().toFile(file);
    paths.push(file);
    assert.equal(backgroundKeyMode({ solid: true, transparentRatio: 0, colour }), name);
  }
  const result = await processImageBatch({ paths, outputDir: path.join(root, "out"), outputKind: "images",
    automatic: true, options: { keyMode: "auto", tolerance: 20, keyScope: "exterior", blackOutline: 3, batchBlackContour: "preserve", edgeRefine: { mode: "none" } }, appRoot: path.resolve(".") });
  assert.equal(result.failed, 0);
  for (const item of result.results) {
    const data = await sharp(item.imagePath).ensureAlpha().raw().toBuffer();
    const alpha = (x, y) => data[(y * 80 + x) * 4 + 3];
    assert.equal(alpha(0, 0), 0, `${item.name}: flat background removed`);
    assert.equal(alpha(40, 40), 255, `${item.name}: enclosed matching detail kept`);
    assert.equal(alpha(30, 30), 255, `${item.name}: object kept`);
    assert.ok(item.changeReport.changed > 0, `${item.name}: output differs from input`);
    assert.ok(item.route.some(step => step.includes(({ black: "Чёрный", white: "белый", green: "зелёный", magenta: "маджента" })[item.name])), `${item.name}: route reports the selected key`);
  }
});

test("black flat-background batch offers contour protection and complete removal", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cslab-black-outline-batch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pixels = Buffer.alloc(64 * 64 * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) pixels.set([0, 0, 0, 255], offset);
  for (let y = 20; y < 44; y++) for (let x = 20; x < 44; x++) pixels.set([230, 90, 30, 255], (y * 64 + x) * 4);
  const file = path.join(root, "black.png");
  await sharp(pixels, { raw: { width: 64, height: 64, channels: 4 } }).png().toFile(file);
  const run = mode => processImageBatch({ paths: [file], outputDir: path.join(root, mode), outputKind: "images", automatic: true,
    options: { keyMode: "auto", batchBackgroundMode: "black", batchBlackContour: mode, blackOutline: 3, tolerance: 20, edgeRefine: { mode: "none" } }, appRoot: path.resolve(".") });
  const preserved = await run("preserve");
  const removed = await run("remove");
  assert.equal(preserved.failed, 0); assert.equal(removed.failed, 0);
  const before = await sharp(preserved.results[0].imagePath).ensureAlpha().raw().toBuffer();
  const after = await sharp(removed.results[0].imagePath).ensureAlpha().raw().toBuffer();
  const at = (data, x, y) => data[(y * 64 + x) * 4 + 3];
  assert.equal(at(before, 17, 30), 255, "protected outline remains");
  assert.equal(at(after, 17, 30), 0, "no-contour variant clears the same background pixel");
  assert.equal(at(before, 30, 30), 255); assert.equal(at(after, 30, 30), 255);
  assert.match(removed.results[0].route.join(" "), /без сохранения контура/);
});

test("image-only batch writes colour adjustments into PNG and reports changed pixels", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cslab-colour-batch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = await fixture(root, "leaf.png", true);
  const source = await fs.readFile(file);
  const result = await processImageBatch({ paths: [file], outputDir: path.join(root, "out"), outputKind: "images",
    options: { keyMode: "alpha", colorAdjust: { brightness: 12, contrast: 10, warmth: 25 } }, appRoot: path.resolve(".") });
  assert.equal(result.failed, 0);
  assert.ok(result.results[0].changeReport.changed > 0);
  const inputPixel = await sharp(file).ensureAlpha().extract({ left: 10, top: 10, width: 1, height: 1 }).raw().toBuffer();
  const outputPixel = await sharp(result.results[0].imagePath).ensureAlpha().extract({ left: 10, top: 10, width: 1, height: 1 }).raw().toBuffer();
  assert.equal(outputPixel[3], inputPixel[3]);
  assert.notDeepEqual(outputPixel.subarray(0, 3), inputPixel.subarray(0, 3));
  assert.deepEqual(await fs.readFile(file), source);
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
test("quality review catches white regions after neural matting without erasing them",async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cslab-quality-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'remaining.png');
  await sharp({create:{width:80,height:60,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite([{input:Buffer.from('<svg width="80" height="60"><rect x="20" y="15" width="20" height="20" fill="white"/></svg>')}]).png().toFile(file);
  const before=await fs.readFile(file);
  const issues=await inspectCleanupQuality({afterPath:file},{borderColour:[255,255,255]});
  assert.equal(issues[0].code,'white-regions-to-review');assert.equal(issues[0].count,1);
  assert.deepEqual(await fs.readFile(file),before);
});
