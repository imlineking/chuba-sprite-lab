import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { builtinPresets, validatePreset, PresetStore, planStages, runConveyor, ConveyorQueue, createFolderWatcher, quickOutputDir, processorOptions } from "../src/conveyor.mjs";
import { createConveyorStages } from "../src/conveyor-main.mjs";
import * as processor from "../src/processor.mjs";
import { describePaths, describeSpriteSheet } from "../src/source-describe.mjs";
import { buildAtlas } from "../src/pipeline/build.mjs";
import { reviewAtlas } from "../src/critic/critic.mjs";
import { writeAnimatedImage, readAnimatedImage } from "../src/animated-images.mjs";

const appRoot = path.resolve(import.meta.dirname, "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "spritelab-conveyor-"));
test.after(() => fs.rm(tmp, { recursive: true, force: true }));
const phaser = builtinPresets.find((p) => p.id === "phaser");

function fakeDeps(type, calls, { failAt = null } = {}) {
  const step = (name, value) => async (...args) => { calls.push(name); if (failAt === name) throw new Error(`${name} упал`); return typeof value === "function" ? value(...args) : value; };
  return {
    detect: async (paths) => ({ type, paths, files: paths, warnings: [] }),
    describe: step("describe", { paths: ["a"], frameCount: 4, recommendations: { fps: 10 } }),
    clean: step("clean", ({ outputDir, name }) => ({ outputDir: path.join(outputDir, name), framesDir: path.join(outputDir, name, "frames"), frameCount: 4 })),
    pack: step("pack", (config) => ({ config, pages: [{}] })),
    check: step("check", { verdict: "accepted", verdictLabel: "Принято", issues: [] }),
    exportResult: step("export", { summary: "2 файлов" }),
  };
}

test("presets validate and built-ins are protected", async () => {
  assert.throws(() => validatePreset({ id: "x y", label: "a" }), /id/);
  assert.throws(() => validatePreset({ id: "a", label: "A", output: "C:/" }), /Недопустимые поля/);
  assert.throws(() => validatePreset({ id: "a", label: "A", atlas: { formats: [] } }), /формат/);
  const store = new PresetStore(path.join(tmp, "presets.json"));
  assert.ok((await store.list()).length >= 4);
  await assert.rejects(store.save({ ...phaser }), /Встроенный/);
  await store.save({ id: "my", label: "Мой", atlas: { formats: ["phaser-hash"] } });
  assert.equal((await store.get("my")).label, "Мой");
  assert.equal((await new PresetStore(path.join(tmp, "presets.json")).list()).filter((p) => p.id === "my").length, 1);
  await store.remove("my"); assert.equal((await store.get("my")).id, "phaser");
});

test("planStages follows the capability map", () => {
  assert.deepEqual(planStages("image", phaser).filter((s) => s.run).map((s) => s.id), ["clean", "check", "export"]);
  assert.deepEqual(planStages("video", phaser).filter((s) => s.run).map((s) => s.id), ["cut", "clean", "pack", "check", "export"]);
  assert.deepEqual(planStages("frames-folder", { ...phaser, review: false }).filter((s) => s.run).map((s) => s.id), ["clean", "pack", "export"]);
  assert.deepEqual(planStages("video", { ...phaser, pack: false }).filter((s) => s.run).map((s) => s.id), ["cut", "clean", "check", "export"]);
  assert.ok(planStages("pdf", phaser).every((s) => !s.run));
});

test("runConveyor runs stages in order and reports progress", async () => {
  const calls = [], events = [];
  const result = await runConveyor({ paths: ["/x/walk.mp4"], preset: phaser, outputDir: "/out", deps: fakeDeps("video", calls), onStage: (e) => events.push(`${e.id}:${e.status}`) });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["describe", "clean", "pack", "check", "export"]);
  assert.deepEqual(events, ["cut:running", "cut:done", "clean:running", "clean:done", "pack:running", "pack:done", "check:running", "check:done", "export:running", "export:done"]);
  assert.equal(result.review.verdict, "accepted");
});

test("runConveyor skips packing for one image and stops on unsupported input", async () => {
  const calls = [];
  const r = await runConveyor({ paths: ["/x/a.png"], preset: phaser, quick: true, deps: fakeDeps("image", calls) });
  assert.equal(r.ok, true); assert.deepEqual(calls, ["describe", "clean", "export"]);
  assert.equal(r.outputDir, path.join(quickOutputDir("/x/a.png"), "a"));
  const pdf = await runConveyor({ paths: ["/x/a.pdf"], preset: phaser, quick: true, deps: fakeDeps("pdf", []) });
  assert.equal(pdf.ok, false); assert.match(pdf.error, /PDF/);
});

test("runConveyor reports the failed stage", async () => {
  const r = await runConveyor({ paths: ["/x/a.mp4"], preset: phaser, outputDir: "/o", deps: fakeDeps("video", [], { failAt: "pack" }) });
  assert.equal(r.ok, false); assert.equal(r.failedStage, "pack");
  assert.equal(r.stages.find((s) => s.id === "pack").status, "failed");
  assert.equal(r.stages.find((s) => s.id === "check").status, "pending");
});

test("processorOptions maps presets onto existing processor keys", () => {
  assert.equal(processorOptions({ ...phaser, background: "none" }).keyMode, "alpha");
  assert.equal(processorOptions({ ...phaser, background: "ai" }).keyMode, "ai");
  assert.equal(processorOptions(phaser, { keyMode: "alpha" }).keyMode, "alpha");
  const pixelOptions = processorOptions(builtinPresets.find((p) => p.id === "pixel-art"));
  assert.equal(pixelOptions.pixelate, null);
  assert.equal(pixelOptions.pixelPerfect, true);
});

test("queue persists, survives restart, pauses, cancels and summarises", async () => {
  const file = path.join(tmp, "queue.json"); const ran = [];
  const run = async (item) => { ran.push(item.paths[0]); return item.paths[0].includes("bad") ? { ok: false, error: "плохой файл" } : { ok: true, outputDir: "/o" }; };
  const queue = new ConveyorQueue({ file, run });
  await queue.load(); await queue.pause();
  await queue.add({ paths: ["/a.png"], presetId: "phaser" }); await queue.add({ paths: ["/bad.png"], presetId: "phaser" }); const third = await queue.add({ paths: ["/c.png"], presetId: "phaser" });
  await queue.drain(); assert.equal(ran.length, 0, "paused queue must not run");
  await queue.cancel(third);
  const reloaded = new ConveyorQueue({ file, run }); const snap = await reloaded.load();
  assert.equal(snap.items.length, 3); assert.equal(snap.paused, true);
  await reloaded.resume();
  assert.deepEqual(ran, ["/a.png", "/bad.png"]);
  const s = reloaded.summary(); assert.equal(s.done, 1); assert.equal(s.failed, 1); assert.equal(s.cancelled, 1);
  await reloaded.clearFinished(); assert.equal(reloaded.items.length, 0);
});

test("queue re-runs an item that was running when the app closed", async () => {
  const file = path.join(tmp, "queue2.json");
  await fs.writeFile(file, JSON.stringify({ paused: false, items: [{ id: "1", paths: ["/a"], status: "running" }] }));
  const q = new ConveyorQueue({ file, run: async () => ({ ok: true }) });
  const snap = await q.load(); assert.equal(snap.items[0].status, "pending");
  await q.drain(); assert.equal(q.items[0].status, "done");
});

test("watch folder waits for stable files and ignores the output folder", async () => {
  const dir = path.join(tmp, "watch"); await fs.mkdir(path.join(dir, "SpriteLab-out"), { recursive: true });
  await fs.writeFile(path.join(dir, "old.png"), "x");
  const got = [];
  const watcher = createFolderWatcher({ dir, ignore: [path.join(dir, "SpriteLab-out")], stableChecks: 2, onFiles: async (files) => got.push(...files.map((f) => path.basename(f))) });
  await watcher.primeExisting();
  await fs.writeFile(path.join(dir, "new.png"), "abc");
  await fs.writeFile(path.join(dir, "SpriteLab-out", "atlas.png"), "zzz");
  await fs.writeFile(path.join(dir, "half.png.part"), "zzz");
  await watcher.tick(); assert.deepEqual(got, []);
  await watcher.tick(); assert.deepEqual(got, []);
  await fs.appendFile(path.join(dir, "new.png"), "more"); // still being written
  await watcher.tick(); await watcher.tick(); assert.deepEqual(got, []);
  await watcher.tick(); assert.deepEqual(got, ["new.png"]);
  await watcher.tick(); await watcher.tick(); await watcher.tick(); assert.deepEqual(got, ["new.png"], "handled once");
});

test("real stages: frames folder through cut, clean, pack, check and export", async () => {
  const frames = path.join(tmp, "real-frames"); await fs.mkdir(frames);
  for (let i = 0; i < 4; i++) await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).composite([{ input: { create: { width: 20, height: 30, channels: 4, background: { r: 30, g: 70, b: 210, alpha: 1 } } }, left: 10 + i * 6, top: 16 }]).png().toFile(path.join(frames, `run_${i}.png`));
  const stages = createConveyorStages({
    appRoot, sharp, describePaths: (kind, paths) => describePaths(appRoot, kind, paths), describeSpriteSheet: (p, o) => describeSpriteSheet(appRoot, p, o),
    executeProcessing: (op, { signal: _s, onProgress: _p, ...payload }) => processor[op](payload), buildAtlas, reviewAtlas, runtime: null, modelsDirectory: () => path.join(tmp, "models"),
  });
  const out = path.join(tmp, "real-out");
  const result = await runConveyor({ paths: [frames], intent: "animation", preset: { ...phaser, useModel: false }, outputDir: out, deps: stages });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.type, "frames-folder");
  assert.deepEqual(result.stages.map((s) => s.status), ["skipped", "done", "done", "done", "done"]);
  const atlasDir = path.join(result.outputDir, "atlas");
  assert.ok((await fs.readdir(atlasDir)).some((f) => f.endsWith(".png")));
  const review = JSON.parse(await fs.readFile(path.join(atlasDir, "review.json"), "utf8"));
  assert.ok(["accepted", "needs_fix", "rejected"].includes(review.verdict));
  const summary = JSON.parse(await fs.readFile(path.join(result.outputDir, "conveyor.json"), "utf8"));
  assert.equal(summary.type, "frames-folder");

  const single = path.join(tmp, "logo.png"); await fs.copyFile(path.join(frames, "run_0.png"), single);
  const quick = await runConveyor({ paths: [single], preset: builtinPresets.find((p) => p.id === "quick"), quick: true, deps: stages });
  assert.equal(quick.ok, true, quick.error);
  assert.ok(quick.outputDir.startsWith(quickOutputDir(single)));
  const cleaned = await sharp(path.join(quick.outputDir, "logo.png")).raw().ensureAlpha().toBuffer({ resolveWithObject: true });
  assert.equal(cleaned.data[3], 0, "white background removed in the corner");
});

test("animated WebP and a mislabelled GIF are split into frames by content", async () => {
  const solid = (rgba) => { const b = Buffer.alloc(16 * 16 * 4); for (let i = 0; i < 256; i++) b.set(rgba, i * 4); return b; };
  const raw = Buffer.concat([solid([0, 0, 255, 255]), solid([255, 0, 0, 255]), solid([0, 255, 0, 255])]);
  const webp = path.join(tmp, "anim.webp");
  await sharp(raw, { raw: { width: 16, height: 48, channels: 4, pageHeight: 16 } }).webp({ loop: 0, delay: [80, 80, 80], lossless: true }).toFile(webp);
  const gifAsPng = path.join(tmp, "anim-gif.png");
  await sharp(raw, { raw: { width: 16, height: 48, channels: 4, pageHeight: 16 } }).gif({ loop: 0, delay: [80, 80, 80] }).toFile(gifAsPng);
  const stages = createConveyorStages({ appRoot, sharp, describePaths: (kind, paths) => describePaths(appRoot, kind, paths), describeSpriteSheet: (p, o) => describeSpriteSheet(appRoot, p, o), executeProcessing: () => null, buildAtlas, reviewAtlas, modelsDirectory: () => tmp });
  for (const file of [webp, gifAsPng]) {
    const detection = await stages.detect([file]);
    assert.equal(detection.type, "animated-image", file);
    const source = await stages.describe(detection);
    assert.equal(source.animatedImport, true, file);
    assert.equal(source.paths.length, 3, file);
  }
});

function realStages() {
  return createConveyorStages({
    appRoot, sharp, describePaths: (kind, paths) => describePaths(appRoot, kind, paths), describeSpriteSheet: (p, o) => describeSpriteSheet(appRoot, p, o),
    executeProcessing: (op, payload) => processor[op](payload), buildAtlas, reviewAtlas, runtime: null, modelsDirectory: () => path.join(tmp, "models"),
  });
}

for (const pixelArt of [false, true]) test(`background off preserves opaque PNG pixels through the real conveyor (pixel art: ${pixelArt})`, async () => {
  const file = path.join(tmp, "opaque.png");
  const pixels = Buffer.alloc(32 * 32 * 4);
  for (let i = 0; i < 32 * 32; i++) pixels.set(i % 31 ? [i % 256, Math.floor(i / 256) * 48, 60, 255] : [255, 255, 255, 255], i * 4);
  await sharp(pixels, { raw: { width: 32, height: 32, channels: 4 } }).png().toFile(file);
  const result = await runConveyor({ paths: [file], preset: { ...phaser, pixelArt, background: "none", edgeCleanup: false, review: false }, outputDir: path.join(tmp, "opaque-out"), deps: realStages() });
  assert.equal(result.ok, true, result.error);
  const output = await sharp(path.join(result.outputDir, "opaque.png")).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([output.info.width, output.info.height], [32, 32]);
  assert.deepEqual(output.data, pixels);
});

for (const format of ["gif", "apng"]) test(`${format}: real conveyor preserves opaque frames, order, timing and loop count`, async () => {
  const file = path.join(tmp, `timed.${format}`);
  const solid = (color) => { const pixels = Buffer.alloc(32 * 32 * 4); for (let i = 0; i < 32 * 32; i++) pixels.set(color, i * 4); return pixels; };
  // Repeated pixels must share atlas storage without losing their timeline entry.
  await writeAnimatedImage(file, { width: 32, height: 32, loop: 3, frames: [
    { pixels: solid([100, 40, 60, 255]), durationMs: 80 },
    { pixels: solid([40, 100, 60, 255]), durationMs: 240 },
    { pixels: solid([100, 40, 60, 255]), durationMs: 120 },
  ] }, format);
  const original = await readAnimatedImage(file);
  const previewStages = realStages();
  previewStages.describe = () => { throw new Error("Static preview must not extract the entire animation"); };
  const preview = await previewStages.preview([file]);
  assert.match(preview.url, /^data:image\/png;base64,/);
  assert.equal((await sharp(Buffer.from(preview.url.split(",")[1], "base64")).metadata()).width, 32);
  const result = await runConveyor({ paths: [file], preset: { ...phaser, background: "none", edgeCleanup: false, review: false, atlas: { ...phaser.atlas, formats: ["phaser-hash", "texturepacker-hash", "godot-spriteframes", "unity-json"] } }, outputDir: path.join(tmp, `${format}-out`), deps: realStages() });
  assert.equal(result.ok, true, result.error);
  const atlasDir = path.join(result.outputDir, "atlas");
  const atlas = JSON.parse(await fs.readFile(path.join(atlasDir, "timed.json"), "utf8"));
  const entries = Object.entries(atlas.frames);
  assert.equal(entries.length, 3);
  assert.deepEqual(Object.values(atlas.meta.animations), [entries.map(([name]) => name)]);
  assert.equal(atlas.meta.animationLoop, original.loop);
  assert.deepEqual(entries.map(([, frame]) => frame.durationMs), [80, 240, 120]);
  const page = await sharp(path.join(atlasDir, atlas.meta.image)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  entries.forEach(([, frame], index) => {
    assert.deepEqual(frame.sourceSize, { w: 32, h: 32 });
    const { x, y } = frame.frame;
    assert.deepEqual(page.data.subarray((y * page.info.width + x) * 4, (y * page.info.width + x) * 4 + 4), original.frames[index].pixels.subarray(0, 4));
  });
  assert.deepEqual(entries[0][1].frame, entries[2][1].frame, "duplicate pixels share storage, not playback identity");
  const { anims } = JSON.parse(await fs.readFile(path.join(atlasDir, "timed.phaser-anims.json"), "utf8"));
  assert.equal(anims.length, 1);
  assert.equal(anims[0].repeat, original.loop - 1);
  assert.deepEqual(anims[0].frames.map((frame) => 1000 / anims[0].frameRate + (frame.duration || 0)), [80, 240, 120]);
  const godot = await fs.readFile(path.join(atlasDir, "timed.tres"), "utf8");
  const speed = Number(/"speed": ([\d.]+)/.exec(godot)[1]);
  assert.deepEqual([...godot.matchAll(/"duration": ([\d.]+)/g)].map((match) => Math.round(Number(match[1]) / speed * 1000)), [80, 240, 120]);
  const unity = JSON.parse(await fs.readFile(path.join(atlasDir, "timed.unity.json"), "utf8"));
  assert.deepEqual(unity.frames.map((frame) => frame.durationMs), [80, 240, 120]);
  assert.equal(unity.animationLoop, original.loop);
  const summary = JSON.parse(await fs.readFile(path.join(result.outputDir, "conveyor.json"), "utf8"));
  assert.match(summary.warnings[0], /Godot SpriteFrames/);
  assert.match(result.exported.summary, /конечное число повторов/);
  const reimported = await realStages().describe({ type: "atlas-json", files: [path.join(atlasDir, "timed.json")] });
  assert.deepEqual(Object.values(reimported.frameMetadata).map((frame) => frame.durationMs), [80, 240, 120]);
  assert.equal(reimported.importedMetadata.animationLoop, original.loop);
});

test("atlas conveyor retains named clips, per-clip speeds, pivots and original canvas after trimming", async () => {
  const inputDir = path.join(tmp, "tagged"); await fs.mkdir(inputDir);
  const image = path.join(inputDir, "actors.png"), file = path.join(inputDir, "actors.json");
  await sharp({ create: { width: 64, height: 32, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([5, 37].map((left) => ({ input: { create: { width: 12, height: 18, channels: 4, background: { r: 100, g: 40, b: 60, alpha: 1 } } }, left, top: 7 })))
    .png().toFile(image);
  const pivots = [{ x: .25, y: .75 }, { x: .8, y: .9 }];
  await fs.writeFile(file, JSON.stringify({ image: "actors.png", animationLoop: 1,
    frames: ["walk_0", "rescue_0"].map((name, i) => ({ name, x: i * 32, y: 0, width: 32, height: 32, durationMs: [80, 240][i], pivot: pivots[i] })),
    animations: [{ name: "walk", from: 0, to: 0, fps: 10 }, { name: "rescue", from: 1, to: 1, fps: 14.5 }],
  }));
  const result = await runConveyor({ paths: [file], preset: { ...phaser, background: "none", edgeCleanup: false, review: false, atlas: { ...phaser.atlas, formats: ["texturepacker-hash", "godot-spriteframes"] } }, outputDir: path.join(tmp, "tagged-out"), deps: realStages() });
  assert.equal(result.ok, true, result.error);
  const atlasDir = path.join(result.outputDir, "atlas");
  const atlas = JSON.parse(await fs.readFile(path.join(atlasDir, "actors.json"), "utf8"));
  assert.deepEqual(atlas.meta.animations, { rescue: ["rescue_0"], walk: ["walk_0"] });
  assert.deepEqual(Object.values(atlas.frames).map((frame) => frame.pivot), pivots);
  for (const frame of Object.values(atlas.frames)) {
    assert.deepEqual(frame.sourceSize, { w: 32, h: 32 });
    assert.deepEqual(frame.spriteSourceSize, { x: 5, y: 7, w: 12, h: 18 });
  }
  const godot = await fs.readFile(path.join(atlasDir, "actors.tres"), "utf8");
  assert.deepEqual([...godot.matchAll(/"speed": ([\d.]+)/g)].map((match) => Number(match[1])), [14.5, 10]);
  assert.equal([...godot.matchAll(/"loop": false/g)].length, 2);
  const reimported = await realStages().describe({ type: "atlas-json", files: [path.join(atlasDir, "actors.json")] });
  assert.deepEqual(Object.values(reimported.frameMetadata).map((frame) => frame.pivot), pivots);
  assert.deepEqual(reimported.importedAnimations.map((tag) => tag.name), ["walk", "rescue"]);
  assert.equal(reimported.importedMetadata.animationLoop, 1);
});
