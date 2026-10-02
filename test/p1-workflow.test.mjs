import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { processSprites, inspectSource, clearRenderCache, processingCacheStats } from "../src/processor.mjs";
import { importSheetManifest, normalizeSheetManifest } from "../src/sheet-metadata.mjs";
import { describeSpriteSheet } from "../src/source-describe.mjs";
import { makePixelSelection, moveSelectedPixels } from "../src/pixel-selection.mjs";
import { openSession, selectPixels, transformSelection, exportFrame, stepHistory, closeSession, paint, readState } from "../src/editor-session.mjs";
import { reviewSeries } from "../src/series-review.mjs";
import { StageCache } from "../src/stage-cache.mjs";
import { prunePreviewCache } from "../src/preview-cache.mjs";
import { checkerMask } from "../src/region-color.mjs";
import { processImageBatch } from "../src/image-batch.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-p1-flow-")); t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}

test("PNG/JSON imports preserve rotation, trim, duration, tags, pivots and custom fields across repack", async t => {
  const root = await fixture(t), appRoot = path.resolve("."), inputs = [];
  for (let i = 0; i < 3; i++) { const file = path.join(root, `${i}.png`); await sharp({ create: { width: 15 + i, height: 9 + i, channels: 4, background: { r: 200, g: 20 + i * 40, b: 70, alpha: 1 } } }).png().toFile(file); inputs.push(file); }
  const source = await inspectSource({ kind: "frames", paths: inputs, appRoot }); source.importedMetadata = { game: { author: "test", schema: 7 } };
  const frameMetadata = Object.fromEntries(inputs.map((_, i) => [i, { name: `sprite_${i}`, durationMs: 110 + i * 20, pivot: { x: .3, y: .7 }, tag: "walk", extra: { event: `step_${i}` } }]));
  const options = { keyMode: "alpha", preserveFrameCanvas: true, packing: "maxrects", atlasExtrude: 1, atlasRotate: true, atlasMaxSize: 30, atlasOverflow: "split", frameMetadata, exports: { sheet: true, metadata: true, frames: true, preview: false } };
  const built = await processSprites({ source, appRoot, outputDir: root, name: "first", options });
  const imported = await importSheetManifest(built.manifestPath, path.join(root, "decoded"));
  assert.equal(imported.frames.length, 3); assert.equal(imported.extra.game.schema, 7);
  for (let i = 0; i < 3; i++) { assert.equal(imported.frames[i].durationMs, 110 + i * 20); assert.deepEqual(imported.frames[i].pivot, { x: .3, y: .7 }); assert.equal(imported.frames[i].extra.event, `step_${i}`); assert.deepEqual(await sharp(imported.framePaths[i]).raw().toBuffer(), await sharp(built.framePaths[i]).raw().toBuffer()); }
  const described = await describeSpriteSheet(appRoot, built.sheetPath); assert.equal(described.sheetMode, "metadata");
  const again = await processSprites({ source: described, appRoot, outputDir: root, name: "again", options: { ...options, frameMetadata: undefined } });
  const reimported = await importSheetManifest(again.manifestPath, path.join(root, "decoded-again"));
  for (let i = 0; i < 3; i++) assert.deepEqual(await sharp(reimported.framePaths[i]).raw().toBuffer(), await sharp(imported.framePaths[i]).raw().toBuffer());
  assert.equal(reimported.frames[0].name, "sprite_0"); assert.equal(reimported.frames[0].durationMs, 110);
  const manifest = JSON.parse(await fs.readFile(built.manifestPath, "utf8")); manifest.frames[0].x = -1; assert.throws(() => normalizeSheetManifest(manifest), /геометрия/);
});

test("selection moves real pixels without smearing; clipped move rejects and session undo restores cut", () => {
  const data = Buffer.alloc(6 * 4 * 4); data.set([10, 20, 30, 255], 7 * 4); data.set([40, 50, 60, 255], 8 * 4);
  const mask = makePixelSelection(data, 6, 4, { from: [1, 1], to: [2, 1] });
  const moved = moveSelectedPixels(data, 6, 4, mask, { dx: 1 });
  assert.equal(moved.data[7 * 4 + 3], 0); assert.deepEqual(moved.data.subarray(8 * 4, 8 * 4 + 4), data.subarray(7 * 4, 7 * 4 + 4));
  assert.throws(() => moveSelectedPixels(data, 6, 4, mask, { dx: 6 }), /обрежет/);
  const wand = makePixelSelection(data, 6, 4, { mode: "wand", from: [1, 1], tolerance: 0 }); assert.equal(wand.reduce((a, b) => a + b, 0), 1);
  const session = openSession({ width: 6, height: 4, pixels: data });
  selectPixels(session.sessionId, { from: [1, 1], to: [2, 1] }); transformSelection(session.sessionId, { erase: true });
  assert.equal(exportFrame(session.sessionId).composite[7 * 4 + 3], 0); stepHistory(session.sessionId); assert.deepEqual(Buffer.from(exportFrame(session.sessionId).composite), data);
  paint(session.sessionId, { from: [0, 1], to: [5, 1], color: [200, 0, 0, 255] });
  assert.equal(exportFrame(session.sessionId).composite[6 * 4 + 3], 0); stepHistory(session.sessionId);
  transformSelection(session.sessionId, { dx: 1, newLayer: true }); assert.equal(readState(session.sessionId).layers.length, 2);
  stepHistory(session.sessionId); assert.equal(readState(session.sessionId).layers.length, 1); assert.deepEqual(Buffer.from(exportFrame(session.sessionId).composite), data);
  assert.deepEqual(readState(session.sessionId).selection, mask); stepHistory(session.sessionId, "redo"); assert.equal(readState(session.sessionId).layers.length, 2); closeSession(session.sessionId);
});

test("bounded stage LRU and preview pruning protect live drafts, unknown folders and references", async t => {
  const cache = new StageCache({ maxBytes: 8, maxEntries: 2 }); cache.set("a", Buffer.alloc(4)); cache.set("b", Buffer.alloc(4)); cache.get("a"); cache.set("c", Buffer.alloc(4)); assert.equal(cache.get("b"), null); assert.ok(cache.stats().bytes <= 8);
  const root = await fixture(t), now = Date.now();
  for (const dir of ["preview-old", "preview-live", "notes", "preview-new"]) { await fs.mkdir(path.join(root, dir)); if (dir !== "preview-new") await fs.utimes(path.join(root, dir), new Date(0), new Date(0)); }
  assert.deepEqual(await prunePreviewCache(root, { now, references: [path.join(root, "preview-live", "file.png")], maxAgeMs: 10000 }), ["preview-old"]);
  await fs.access(path.join(root, "notes")); await fs.access(path.join(root, "preview-live"));
});

test("editing one frame keeps other prepared stages; repacking does not re-key the set", async t => {
  const root = await fixture(t), appRoot = path.resolve("."), paths = [];
  for (let i = 0; i < 3; i++) { const file = path.join(root, `${i}.png`); await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 20, g: 90 + i, b: 40, alpha: 1 } } }).png().toFile(file); paths.push(file); }
  const source = await inspectSource({ kind: "frames", paths, appRoot }); clearRenderCache();
  const request = { source, appRoot, outputDir: root, name: "cache", options: { keyMode: "alpha", preserveFrameCanvas: true, exports: { preview: false } } };
  await processSprites(request); const before = processingCacheStats();
  await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 240, g: 0, b: 0, alpha: 1 } } }).png().toFile(paths[1]);
  await processSprites(request); const edited = processingCacheStats(); assert.equal(edited.prepared.hits - before.prepared.hits, 2);
  await processSprites({ ...request, options: { ...request.options, packing: "maxrects", atlasExtrude: 2 } }); const packed = processingCacheStats(); assert.equal(packed.key.misses, edited.key.misses);
});

test("dark checker evidence removes two tones and keeps saturated sprite / isolated light detail", () => {
  const data = Buffer.alloc(64 * 64 * 4);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) { const c = ((x >> 2) + (y >> 2)) % 2 ? 25 : 80; data.set([c, c, c, 255], (y * 64 + x) * 4); }
  for (let y = 20; y < 44; y++) for (let x = 20; x < 44; x++) data.set([10, 120, 30, 255], (y * 64 + x) * 4);
  for (let y = 28; y < 36; y++) for (let x = 28; x < 36; x++) data.set([250, 250, 250, 255], (y * 64 + x) * 4);
  const result = checkerMask(data, { width: 64, height: 64 }); assert.ok(result.count > 2600); assert.equal(result.mask[30 * 64 + 30], 0); assert.equal(result.mask[22 * 64 + 22], 0); assert.equal(result.mask[0], 1);
});

test("batch uses one palette and 2× scales exact pixel blocks without touching alpha silhouette", async t => {
  const root = await fixture(t), paths = [];
  for (let i = 0; i < 2; i++) { const file = path.join(root, `${i}.png`); const data = Buffer.alloc(16 * 16 * 4); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) data.set([x * 15, y * 15, i * 90, 255], (y * 16 + x) * 4); await sharp(data, { raw: { width: 16, height: 16, channels: 4 } }).png().toFile(file); paths.push(file); }
  const result = await processImageBatch({ paths, outputDir: path.join(root, "out"), outputKind: "images", appRoot: path.resolve("."), options: { keyMode: "alpha", pixelScale: 2, pixelate: { size: 2, colors: 8, palette: "auto", paletteScope: "series" } } });
  assert.deepEqual(result.results[0].sharedPalette, result.results[1].sharedPalette);
  for (const frame of result.results) { const { data, info } = await sharp(frame.imagePath).raw().toBuffer({ resolveWithObject: true }); assert.equal(info.width, 32); for (let y = 0; y < 32; y += 4) for (let x = 0; x < 32; x += 4) assert.deepEqual(data.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4), data.subarray(((y + 3) * 32 + x + 3) * 4, ((y + 3) * 32 + x + 3) * 4 + 4)); }
});


test("manual points normalize scale and position without clipping thin tails", async t => {
  const root = await fixture(t), paths = [];
  for (let i = 0; i < 2; i++) {
    const file = path.join(root, "point-" + i + ".png"), width = 24, height = 24, data = Buffer.alloc(width * height * 4);
    const left = 4 + i * 3, top = 5, size = 4 + i * 4;
    for (let y = top; y < top + size; y++) for (let x = left; x < left + size; x++) data.set([80, 140, 20, 255], (y * width + x) * 4);
    for (let y = top + size; y < 23; y++) data.set([80, 140, 20, 255], (y * width + left) * 4);
    await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(file); paths.push(file);
  }
  const source = await inspectSource({ kind: "frames", paths, appRoot: path.resolve(".") });
  const options = { keyMode: "alpha", anchor: "manual", anchorReference: 0, autoSize: true, padding: 2, pixelPerfect: true, frameMetadata: { 0: { anchorPoints: [{ x: 4, y: 5 }, { x: 8, y: 5 }] }, 1: { anchorPoints: [{ x: 7, y: 5 }, { x: 15, y: 5 }] } }, exports: { sheet: true, frames: true, metadata: true, preview: false } };
  const result = await processSprites({ source, appRoot: path.resolve("."), outputDir: root, name: "aligned", options });
  const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8")); assert.equal(manifest.bodyAlignment.method, "manual-points");
  assert.equal(manifest.bodyAlignment.frames[1].scale, .5);
  for (const framePath of result.framePaths) {
    const { data, info } = await sharp(framePath).raw().toBuffer({ resolveWithObject: true });
    const cx = Math.round(info.width / 2), cy = Math.round(info.height / 2); assert.equal(data[(cy * info.width + cx) * 4 + 3], 255);
    assert.ok(info.height > 20); assert.equal(data[3], 0);
  }
  const fitted = await processSprites({ source, appRoot: path.resolve("."), outputDir: root, name: "fitted-points", options: { ...options, imageGeometry: { mode: "contain", width: 48, height: 48, trimToObject: false } } });
  const fittedMeta = JSON.parse(await fs.readFile(fitted.manifestPath, "utf8")); assert.equal(fittedMeta.bodyAlignment.frames[0].x, 8); assert.equal(fittedMeta.bodyAlignment.frames[0].y, 10); assert.equal(fittedMeta.bodyAlignment.frames[1].scale, .5);
  await assert.rejects(processSprites({ source, appRoot: path.resolve("."), outputDir: root, name: "bad-point", options: { ...options, frameMetadata: { 0: { anchorPoints: [{ x: -1, y: 5 }] } } } }), /опорную точку/);
});

test("noisy dark checker is structural and isolated grey contours are protected", () => {
  const width = 80, height = 80, data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const c = ((x >> 3) + (y >> 3)) % 2 ? 30 : 90, noise = (x * 7 + y * 3) % 7 - 3; data.set([c + noise, c + noise, c + noise, 255], (y * width + x) * 4); }
  assert.ok(checkerMask(data, { width, height }).count > 5000);
  data.fill(0); for (let y = 20; y < 60; y++) for (let x = 20; x < 60; x++) data.set([80, 80, 80, 255], (y * width + x) * 4);
  assert.equal(checkerMask(data, { width, height }).count, 0);
});


test("series review flags an isolated mask loss and keeps every RGB/alpha byte intact", async () => {
  const full = await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer();
  const empty = await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const frames = [full, empty, full].map((buffer, sourceIndex) => ({ buffer, sourceIndex }));
  const copies = frames.map(f => Buffer.from(f.buffer)), result = await reviewSeries(frames);
  assert.equal(result.issues[0].frameIndex, 1); for (let i = 0; i < 3; i++) assert.deepEqual(frames[i].buffer, copies[i]);
  assert.equal((await reviewSeries([full, full, full].map((buffer, sourceIndex) => ({ buffer, sourceIndex })))).issues.length, 0);
});


test("Phaser and TexturePacker JSON reimport full pixels, timing and named tags", async t => {
  const root = await fixture(t), file = path.join(root, "input.png"), appRoot = path.resolve(".");
  await sharp({ create: { width: 11, height: 7, channels: 4, background: { r: 120, g: 30, b: 80, alpha: 1 } } }).png().toFile(file);
  const source = await inspectSource({ kind: "frames", paths: [file], appRoot });
  for (const format of ["phaser3", "texturepacker"]) {
    const result = await processSprites({ source, appRoot, outputDir: root, name: format, options: { keyMode: "alpha", preserveFrameCanvas: true, packing: "maxrects", exportFormat: format, atlasRotate: true, frameMetadata: { 0: { name: "frameA", tag: "idle", durationMs: 230, pivot: { x: .2, y: .8 } } }, exports: { sheet: true, frames: true, metadata: true, preview: false } } });
    const json = result.engineFiles.find(p => p.endsWith(format === "phaser3" ? ".phaser.json" : ".texturepacker.json"));
    const imported = await importSheetManifest(json, path.join(root, "import-" + format));
    assert.equal(imported.frames[0].durationMs, 230); assert.equal(imported.frames[0].tag, "idle");
    assert.deepEqual(imported.frames[0].pivot, { x: .2, y: .8 }); assert.deepEqual(await sharp(imported.framePaths[0]).raw().toBuffer(), await sharp(file).raw().toBuffer());
  }
});
