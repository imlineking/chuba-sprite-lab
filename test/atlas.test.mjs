import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { inspectSource, planAtlas, playbackOrder, processAnimationSet, processSprites, resolveLoop } from "../src/processor.mjs";

const appRoot = path.resolve(".");

async function makeFrames(dir, count, { size = 64, color = { r: 225, g: 86, b: 18 } } = {}) {
  await fs.mkdir(dir, { recursive: true });
  const paths = [];
  for (let index = 0; index < count; index += 1) {
    const block = await sharp({ create: { width: 20 + index * 2, height: 24, channels: 4, background: { ...color, alpha: 1 } } }).png().toBuffer();
    const filePath = path.join(dir, `frame-${index}.png`);
    await sharp({ create: { width: size, height: size, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
      .composite([{ input: block, left: 6 + index * 3, top: 20 }]).png().toFile(filePath);
    paths.push(filePath);
  }
  return paths;
}

const baseOptions = {
  fps: 10, columns: 4, autoColumns: false, autoSize: true, cellWidth: 96, cellHeight: 96, padding: 4, maxFrames: 50,
  tolerance: 18, keyMode: "white", anchor: "ground", pixelPerfect: true, removeDuplicates: false, outputBackground: "transparent",
};

test("timeline reorders, duplicates and writes per-frame durations; ping-pong preview order", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "csl-timeline-"));
  const paths = await makeFrames(path.join(temp, "in"), 3);
  const source = await inspectSource({ kind: "frames", paths, appRoot });
  const result = await processSprites({
    source, outputDir: path.join(temp, "out"), name: "walk", appRoot,
    options: { ...baseOptions, loopMode: "pingpong", timeline: [{ src: 2, durationMs: 250 }, { src: 0 }, { src: 0, durationMs: 40 }, { src: 1 }] },
  });
  const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
  assert.deepEqual(manifest.frames.map((frame) => frame.sourceFrameIndex), [2, 0, 0, 1]);
  assert.deepEqual(manifest.frames.map((frame) => frame.durationMs), [250, 100, 40, 100]);
  assert.equal(manifest.loop.mode, "pingpong");
  assert.equal(manifest.animations[0].direction, "pingpong");
  // A duplicated frame reuses the same atlas cell.
  assert.deepEqual([manifest.frames[1].x, manifest.frames[1].y], [manifest.frames[2].x, manifest.frames[2].y]);
  assert.equal((await fs.readdir(path.join(result.outputDir, "frames"))).length, 4);
  assert.deepEqual(playbackOrder(4, resolveLoop({ loopMode: "pingpong" }, 4)), [0, 1, 2, 3, 2, 1]);
  assert.deepEqual(playbackOrder(5, resolveLoop({ loopMode: "range", loopRange: { from: 1, to: 3 } }, 5)), [1, 2, 3]);
});

test("export reuses the cached preview render when only export settings change", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "csl-reuse-"));
  const paths = await makeFrames(path.join(temp, "in"), 3);
  const source = await inspectSource({ kind: "frames", paths, appRoot });
  const preview = await processSprites({ source, name: "reuse", appRoot, previewOnly: true, options: baseOptions });
  assert.equal(preview.reusedRender, false);
  const exported = await processSprites({ source, outputDir: path.join(temp, "out"), name: "reuse", appRoot, options: { ...baseOptions, columns: 1, packing: "tight", atlasPowerOfTwo: true, exportFormat: "phaser3" } });
  assert.equal(exported.reusedRender, true);
  const changed = await processSprites({ source, name: "reuse", appRoot, previewOnly: true, options: { ...baseOptions, padding: 9 } });
  assert.equal(changed.reusedRender, false);
});

test("atlas limit: warn, recalculated columns, scale and split into pages", async () => {
  const group = () => [{ columns: 10, cellWidth: 500, cellHeight: 400, items: Array.from({ length: 40 }, () => ({ width: 500, height: 400 })) }];
  const warn = planAtlas(group(), { maxSize: 4096, overflow: "warn" });
  assert.equal(warn.exceeds, true);
  assert.equal(warn.applied, "warn");
  assert.equal(warn.pages[0].width, 5000);
  assert.equal(warn.pages[0].height, 1600);
  const columns = planAtlas(group(), { maxSize: 4096, overflow: "columns" });
  assert.equal(columns.applied, "columns");
  assert.ok(columns.pages[0].width <= 4096 && columns.pages[0].height <= 4096);
  const scaled = planAtlas(group(), { maxSize: 2048, overflow: "scale" });
  assert.equal(scaled.applied, "scale");
  assert.equal(scaled.pages.length, 1);
  assert.ok(scaled.scale < 1 && scaled.pages[0].width <= 2048 && scaled.pages[0].height <= 2048);
  const split = planAtlas(group(), { maxSize: 2048, overflow: "split" });
  assert.equal(split.applied, "split");
  assert.ok(split.pages.length > 1);
  assert.ok(split.pages.every((page) => page.width <= 2048 && page.height <= 2048));
  assert.equal(split.pages.reduce((sum, page) => sum + page.rects.length, 0), 40);
});

test("power-of-two pages pad dimensions without moving frames or crossing the limit", () => {
  const group = () => [{ columns: 3, cellWidth: 70, cellHeight: 50, items: Array.from({ length: 9 }, () => ({ width: 70, height: 50 })) }];
  const ordinary = planAtlas(group(), { maxSize: 300, overflow: "split" });
  const padded = planAtlas(group(), { maxSize: 300, overflow: "split", powerOfTwo: true });
  assert.equal(padded.powerOfTwo, true);
  assert.ok(padded.pages.length >= ordinary.pages.length);
  assert.ok(padded.pages.every((page) => page.width <= 300 && page.height <= 300));
  assert.ok(padded.pages.every((page) => Number.isInteger(Math.log2(page.width)) && Number.isInteger(Math.log2(page.height))));
  assert.equal(padded.pages.flatMap((page) => page.rects).length, 9);
  const onePage = planAtlas(group().map((entry) => ({ ...entry, items: entry.items.slice(0, 3) })), { powerOfTwo: true });
  assert.deepEqual([onePage.pages[0].width, onePage.pages[0].height], [256, 64]);
  assert.deepEqual(onePage.pages[0].rects.map(({ x, y }) => [x, y]), [[0, 0], [70, 0], [140, 0]]);
});

test("power-of-two export writes padded PNG and matching JSON dimensions", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "csl-pot-"));
  const paths = await makeFrames(path.join(temp, "in"), 3);
  const source = await inspectSource({ kind: "frames", paths, appRoot });
  const result = await processSprites({
    source, outputDir: path.join(temp, "out"), name: "pot", appRoot,
    options: { ...baseOptions, columns: 3, atlasPowerOfTwo: true, atlasMaxSize: 512 },
  });
  const ordinary = await processSprites({
    source, outputDir: path.join(temp, "ordinary"), name: "pot", appRoot,
    options: { ...baseOptions, columns: 3, atlasPowerOfTwo: false, atlasMaxSize: 512 },
  });
  const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
  const report = JSON.parse(await fs.readFile(result.reportPath, "utf8"));
  const ordinaryReport = JSON.parse(await fs.readFile(ordinary.reportPath, "utf8"));
  const image = await sharp(result.sheetPaths[0]).metadata();
  assert.equal(manifest.powerOfTwo, true);
  assert.equal(manifest.pages[0].width, image.width);
  assert.equal(manifest.pages[0].height, image.height);
  assert.ok(Number.isInteger(Math.log2(image.width)) && Number.isInteger(Math.log2(image.height)));
  assert.ok(manifest.frames.every((frame) => frame.x + frame.width <= image.width && frame.y + frame.height <= image.height));
  assert.notEqual(report.recipe.hash, ordinaryReport.recipe.hash, "a padded atlas needs its own recipe fingerprint");
});

test("tight packing trims frames, splits pages and writes engine formats", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "csl-tight-"));
  const paths = await makeFrames(path.join(temp, "in"), 4, { size: 200 });
  const source = await inspectSource({ kind: "frames", paths, appRoot });
  for (const format of ["phaser3", "godot", "texturepacker"]) {
    const result = await processSprites({
      source, outputDir: path.join(temp, format), name: "pack", appRoot,
      options: { ...baseOptions, autoSize: false, cellWidth: 200, cellHeight: 200, padding: 0, packing: "tight", atlasMaxSize: 200, atlasOverflow: "split", exportFormat: format },
    });
    const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.packing, "tight");
    const tightReport = JSON.parse(await fs.readFile(result.reportPath, "utf8"));
    assert.equal(tightReport.atlasIssues, undefined, `a tight ${format} build must not report atlas issues`);
    assert.ok(manifest.frames.every((frame) => frame.trimmed && frame.width < frame.sourceSize.w && frame.sourceSize.w === 200));
    assert.ok(result.sheetPaths.length > 1, "tiny limit must split into several sheets");
    for (const sheetPath of result.sheetPaths) {
      const meta = await sharp(sheetPath).metadata();
      assert.ok(meta.width <= 200 && meta.height <= 200);
    }
    assert.ok(result.engineFiles.length >= 1);
    const text = await fs.readFile(result.engineFiles[0], "utf8");
    if (format === "godot") assert.match(text, /\[gd_resource type="SpriteFrames"/);
    else if (format === "phaser3") assert.ok(JSON.parse(text).textures.length === result.sheetPaths.length);
    else assert.ok(Object.keys(JSON.parse(text).frames).length > 0);

    // Collision data must reach the engine for every format, not only the Chuba JSON.
    const hitboxPath = result.engineFiles.find((file) => file.endsWith(".hitboxes.json"));
    assert.ok(hitboxPath, `${format}: the hitbox sidecar must be exported`);
    const hitboxes = JSON.parse(await fs.readFile(hitboxPath, "utf8"));
    assert.equal(hitboxes.meta.hitboxSpace, "cell");
    assert.equal(Object.keys(hitboxes.frames).length, manifest.frames.length);
    for (const frame of manifest.frames) {
      const entry = hitboxes.frames[frame.name];
      assert.ok(entry?.hitbox && entry.hitbox.width > 0 && entry.hitbox.height > 0, `${format}: missing hitbox for ${frame.name}`);
      assert.ok(entry.hitbox.x + entry.hitbox.width <= frame.sourceSize.w);
    }
  }
});

test("the Unity export carries a slicing script with converted coordinates", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "csl-unity-"));
  const paths = await makeFrames(path.join(temp, "in"), 3);
  const source = await inspectSource({ kind: "frames", paths, appRoot });
  const result = await processSprites({
    source, outputDir: path.join(temp, "out"), name: "unity", appRoot,
    options: { ...baseOptions, anchor: "ground", padding: 8, autoSize: true, autoColumns: true, exportFormat: "unity", atlasMaxSize: 4096, exports: { sheet: true, frames: false, metadata: true, preview: false } },
  });
  const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
  const slicerPath = result.engineFiles.find((file) => file.endsWith(".unity-slicer.cs"));
  assert.ok(slicerPath, "the slicing script must be exported");
  const text = await fs.readFile(slicerPath, "utf8");
  assert.match(text, /using UnityEditor;/);
  assert.match(text, /\[MenuItem\("Tools\/Chuba Sprite Lab\//);
  assert.match(text, /importer\.spritesheet = metadatas\.ToArray\(\);/);
  // Every frame must appear with its own rectangle, and the rectangle origin must be flipped:
  // Unity counts from the bottom-left, the manifest from the top-left.
  const pageHeight = manifest.pages[0].height;
  for (const frame of manifest.frames) {
    assert.ok(text.includes(`name = "${frame.name}"`), `missing slice ${frame.name}`);
    const expectedY = pageHeight - frame.y - frame.height;
    assert.ok(text.includes(`y = ${expectedY}f`), `frame ${frame.name} must use the flipped y ${expectedY}`);
  }
  // A ground pivot sits on the ground line, which is the padding above the bottom of the cell.
  const expectedPivotY = 8 / manifest.frameHeight;
  assert.ok(text.includes(`pivotY = ${expectedPivotY.toFixed(4)}f`), `a ground pivot must sit ${expectedPivotY} of the sprite height above its bottom`);
  assert.ok(text.includes("pivotX = 0.5000f"), "a centred pivot stays centred");
  assert.ok(result.engineFiles.some((file) => file.endsWith(".hitboxes.json")), "the hitbox sidecar still ships");
});

test("named animations are exported into one atlas with tags", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "csl-set-"));
  const idle = await inspectSource({ kind: "frames", paths: await makeFrames(path.join(temp, "idle"), 2), appRoot });
  const run = await inspectSource({ kind: "frames", paths: await makeFrames(path.join(temp, "run"), 3, { color: { r: 20, g: 90, b: 200 } }), appRoot });
  const result = await processAnimationSet({
    animations: [{ name: "idle", source: idle, options: baseOptions }, { name: "run", source: run, options: { ...baseOptions, fps: 12, loopMode: "pingpong" } }],
    outputDir: path.join(temp, "out"), name: "chuba", appRoot, options: { ...baseOptions, exportFormat: "texturepacker" },
  });
  const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
  assert.deepEqual(manifest.animations.map((tag) => [tag.name, tag.from, tag.to, tag.direction]), [["idle", 0, 1, "forward"], ["run", 2, 4, "pingpong"]]);
  assert.equal(manifest.frames.length, 5);
  assert.equal(result.sheetPaths.length, 1);
  const setReport = JSON.parse(await fs.readFile(result.reportPath, "utf8"));
  assert.equal(setReport.atlasIssues, undefined, "a multi-animation build must not report atlas issues");
  const tp = JSON.parse(await fs.readFile(result.engineFiles[0], "utf8"));
  assert.deepEqual(tp.meta.frameTags.map((tag) => tag.name), ["idle", "run"]);
  assert.ok((await fs.readdir(path.join(result.outputDir, "frames"))).includes("run"));
});

test("sprite sheet from mixed JPG/WEBP/PNG images of different sizes", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "csl-images-"));
  const dir = path.join(temp, "in");
  await fs.mkdir(dir, { recursive: true });
  const block = (w, h) => sharp({ create: { width: w, height: h, channels: 4, background: { r: 230, g: 90, b: 20, alpha: 1 } } }).png().toBuffer();
  // Names chosen to check natural sorting: frame2 must come before frame10.
  await sharp({ create: { width: 120, height: 90, channels: 3, background: { r: 255, g: 255, b: 255 } } }).composite([{ input: await block(40, 50), left: 30, top: 30 }]).jpeg({ quality: 95 }).toFile(path.join(dir, "frame10.jpg"));
  await sharp({ create: { width: 200, height: 160, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: await block(80, 100), left: 60, top: 40 }]).webp({ lossless: true }).toFile(path.join(dir, "frame2.webp"));
  await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: await block(20, 30), left: 20, top: 20 }]).png().toFile(path.join(dir, "frame1.png"));
  const paths = ["frame10.jpg", "frame2.webp", "frame1.png"].map((name) => path.join(dir, name));
  const source = await inspectSource({ kind: "frames", paths, appRoot });
  assert.deepEqual(source.paths.map((item) => path.basename(item)), ["frame1.png", "frame2.webp", "frame10.jpg"]);
  assert.deepEqual(source.images.map((image) => image.format), ["png", "webp", "jpeg"]);
  assert.equal(source.mixedSizes, true);
  assert.equal(source.opaqueImages, 1);
  for (const [keyMode, fit] of [["alpha", false], ["white", true]]) {
    const result = await processSprites({
      source, outputDir: path.join(temp, `out-${keyMode}`), name: "mixed", appRoot,
      options: { ...baseOptions, keyMode, anchor: fit ? "center" : "ground", fitEachFrame: fit, atlasMaxSize: 4096, exportFormat: "texturepacker" },
    });
    const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.frames.length, 3);
    assert.deepEqual(manifest.frames.map((frame) => frame.sourceFrameIndex), [0, 1, 2]);
    const meta = await sharp(result.sheetPath).metadata();
    assert.ok(meta.width > 0 && meta.hasAlpha);
    assert.ok(result.engineFiles[0].endsWith(".texturepacker.json"));
  }
});
