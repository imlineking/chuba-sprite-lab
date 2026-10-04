import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { pixelate } from "../src/pixelate.mjs";
import { withSeriesPixelGrid } from "../src/pixel-grid.mjs";
import { processFramePreview, processSprites, inspectSource } from "../src/processor.mjs";
import { processImageBatch } from "../src/image-batch.mjs";
import { readProfile, profileFormat, profileVersion } from "../src/build-profile.mjs";

const palette = { palette: "custom", customColors: "#ff0000,#00ff00,#0000ff,#ffffff", mode: "clean", dither: "none" };
const at = (data, width, x, y) => [...data.subarray((y * width + x) * 4, (y * width + x + 1) * 4)];
function pixels(width, height) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([x < 4 ? 255 : 0, x >= 4 && x < 8 ? 255 : 0, x >= 8 ? 255 : 0, 255], (y * width + x) * 4);
  return { data, info: { width, height, channels: 4 } };
}
test("fixed grid has exact 4px blocks, including a clipped last square, instead of stretched cells", () => {
  const source = pixels(10, 7), original = Buffer.from(source.data);
  const fixed = pixelate(source.data, source.info, { ...palette, size: 4, gridMode: "fixed" });
  assert.equal(fixed.gridWidth, 3); assert.equal(fixed.gridHeight, 2);
  for (let y = 0; y < 7; y++) for (let x = 0; x < 10; x++) assert.deepEqual(at(fixed.data, 10, x, y), x < 4 ? [255, 0, 0, 255] : x < 8 ? [0, 255, 0, 255] : [0, 0, 255, 255]);
  assert.deepEqual(source.data, original);
  assert.notDeepEqual(pixelate(source.data, source.info, { ...palette, size: 4 }).data, fixed.data);
});
test("exact W×H contains the full canvas, preserves proportions, pads alpha, and never mixes hidden RGB", () => {
  const source = pixels(8, 4);
  const result = pixelate(source.data, source.info, { ...palette, gridMode: "target", targetWidth: 4, targetHeight: 4 });
  assert.deepEqual(result.info, { width: 4, height: 4, channels: 4 });
  for (let x = 0; x < 4; x++) { assert.equal(at(result.data, 4, x, 0)[3], 0); assert.equal(at(result.data, 4, x, 3)[3], 0); }
  assert.deepEqual(at(result.data, 4, 0, 1), [255, 0, 0, 255]);
  assert.deepEqual(at(result.data, 4, 3, 2), [0, 255, 0, 255]);
  const mixed = pixelate(Buffer.from([255, 255, 255, 255, 0, 0, 0, 0]), { width: 2, height: 1, channels: 4 }, { ...palette, gridMode: "target", targetWidth: 1, targetHeight: 1, softAlpha: true });
  assert.deepEqual([...mixed.data], [255, 255, 255, 128]);
  const rgb = pixelate(Buffer.from([255, 255, 255]), { width: 1, height: 1, channels: 3 }, { ...palette, gridMode: "target", targetWidth: 3, targetHeight: 1 });
  assert.equal(rgb.info.channels, 4); assert.deepEqual(at(rgb.data, 3, 1, 0), [255, 255, 255, 255]); assert.equal(at(rgb.data, 3, 0, 0)[3], 0);
});
test("unequal canvases share the same sample positions and pattern phase", () => {
  const small = pixels(8, 4), large = pixels(12, 4);
  const settings = { ...palette, gridMode: "target", targetWidth: 6, targetHeight: 2, referenceWidth: 12, referenceHeight: 4 };
  const a = pixelate(small.data, small.info, settings), b = pixelate(large.data, large.info, settings);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 4; x++) assert.deepEqual(at(a.data, 6, x, y), at(b.data, 6, x, y));
  assert.equal(at(a.data, 6, 4, 0)[3], 0); assert.equal(at(b.data, 6, 4, 0)[3], 255);
});
test("invalid grids fail clearly; profiles keep target, reference canvas and export scale", () => {
  const source = pixels(8, 4);
  for (const options of [{ gridMode: "wrong" }, { gridMode: "target", targetWidth: 0, targetHeight: 8 }, { gridMode: "target", targetWidth: 1.5, targetHeight: 8 }, { gridMode: "fixed", referenceWidth: 4, referenceHeight: 4 }, { gridMode: "fixed", referenceWidth: 8192, referenceHeight: 8192 }]) assert.throws(() => pixelate(source.data, source.info, options), /Сетка|сетк|холст|пиксел/i);
  const options = { pixelate: { gridMode: "target", targetWidth: 64, targetHeight: 32, referenceWidth: 800, referenceHeight: 600, ...palette }, pixelScale: 4 };
  const profile = opts => ({ format: profileFormat, version: profileVersion, name: "grid", source: { kind: "frames", paths: ["x.png"] }, options: opts });
  assert.deepEqual(readProfile(profile(options)).animations[0].options, options);
  for (const grid of [{ gridMode: "target", targetWidth: 2049, targetHeight: 4 }, { gridMode: "target", targetWidth: 64 }, { gridMode: "fixed", size: 4, referenceWidth: 80 }, { gridMode: "bad", size: 4 }]) assert.throws(() => readProfile(profile({ pixelate: grid })), /pixelate/);
});
test("PNG preview, separate batch and atlas keep exact frames at 1×, 2×, 4×; geometry cannot resize them again", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-p2-grid-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const appRoot = path.resolve("."), paths = [];
  for (const [i, width] of [8, 12].entries()) { const file = path.join(root, i + ".png"), source = pixels(width, 4); await sharp(source.data, { raw: source.info }).png().toFile(file); paths.push(file); }
  const hashes = await Promise.all(paths.map(file => fs.readFile(file))), source = await inspectSource({ kind: "frames", paths, appRoot });
  const decode = file => sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const base = { keyMode: "alpha", removeDuplicates: false, pixelate: { ...palette, gridMode: "target", targetWidth: 6, targetHeight: 2 }, padding: 20, cellWidth: 600, cellHeight: 400, autoSize: true, anchor: "ground", exports: { sheet: true, metadata: true, frames: true, preview: false } };
  for (const scale of [1, 2, 4]) {
    const options = await withSeriesPixelGrid({ ...base, pixelScale: scale }, paths);
    const previews = await Promise.all(paths.map(inputPath => processFramePreview({ inputPath, appRoot, options })));
    const batch = await processImageBatch({ paths, appRoot, outputDir: path.join(root, "batch-" + scale), outputKind: "images", options: { ...base, pixelScale: scale } });
    assert.equal(batch.failed, 0, JSON.stringify(batch.failures));
    const atlas = await processSprites({ source, appRoot, outputDir: root, name: "atlas-" + scale, options: { ...base, pixelScale: scale } });
    assert.equal(atlas.cellWidth, 6 * scale); assert.equal(atlas.cellHeight, 2 * scale);
    for (let i = 0; i < 2; i++) {
      const preview = await decode(previews[i].afterPath), exported = await decode(atlas.framePaths[i]), image = await decode(batch.results[i].imagePath);
      assert.equal(preview.info.width, 6 * scale); assert.equal(preview.info.height, 2 * scale);
      assert.deepEqual(exported.data, preview.data); assert.deepEqual(image.data, preview.data);
      if (scale > 1) for (let y = 0; y < preview.info.height; y++) for (let x = 0; x < preview.info.width; x++) assert.deepEqual(at(preview.data, preview.info.width, x, y), at(preview.data, preview.info.width, Math.floor(x / scale) * scale, Math.floor(y / scale) * scale));
    }
  }
  const geometry = await processSprites({ source, appRoot, outputDir: root, name: "geometry", options: { ...base, imageGeometry: { mode: "contain", width: 20, height: 10, trimToObject: false } } });
  assert.equal(geometry.cellWidth, 6); assert.equal(geometry.cellHeight, 2);
  const changed = await processSprites({ source, appRoot, outputDir: root, name: "changed", options: { ...base, pixelate: { ...base.pixelate, targetWidth: 8, targetHeight: 4 } } });
  assert.equal(changed.cellWidth, 8); assert.equal(changed.cellHeight, 4);
  const white = await processSprites({ source, appRoot, outputDir: root, name: "white", options: { ...base, outputBackground: "white", pixelScale: 2, frameMetadata: { 0: { anchorPoints: [{ x: 4, y: 2 }] } } } });
  const whitePixels = await decode(white.framePaths[0]); assert.ok(whitePixels.data.every((value, index) => index % 4 !== 3 || value === 255));
  assert.deepEqual(JSON.parse(await fs.readFile(white.manifestPath, "utf8")).frames[0].anchorPoints, [{ x: 4, y: 2 }]);
  for (let i = 0; i < 2; i++) assert.deepEqual(await fs.readFile(paths[i]), hashes[i]);
});
test("shared palette uses one exact grid for differently sized frames and the same atlas pixels as batch", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-grid-series-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const appRoot = path.resolve("."), paths = [];
  for (const [i, width] of [8, 12].entries()) { const file = path.join(root, i + ".png"), source = pixels(width, 4); await sharp(source.data, { raw: source.info }).png().toFile(file); paths.push(file); }
  const source = await inspectSource({ kind: "frames", paths, appRoot });
  for (const gridMode of ["fixed", "target"]) {
    const options = { keyMode: "alpha", pixelate: { size: 4, gridMode, targetWidth: 6, targetHeight: 2, colors: 4, palette: "auto", paletteScope: "series" }, pixelScale: 2, removeDuplicates: false, exports: { sheet: true, frames: true, metadata: true, preview: false } };
    const batch = await processImageBatch({ paths, appRoot, outputDir: path.join(root, gridMode + "-batch"), outputKind: "images", options }); assert.equal(batch.failed, 0);
    const built = await processSprites({ source, appRoot, outputDir: root, name: gridMode + "-atlas", options });
    for (let i = 0; i < 2; i++) assert.deepEqual(await sharp(batch.results[i].imagePath).raw().toBuffer(), await sharp(built.framePaths[i]).raw().toBuffer());
  }
});
