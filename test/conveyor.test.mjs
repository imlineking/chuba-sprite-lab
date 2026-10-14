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
  assert.deepEqual(planStages("image", phaser).filter((s) => s.run).map((s) => s.id), ["clean", "export"]);
  assert.deepEqual(planStages("video", phaser).filter((s) => s.run).map((s) => s.id), ["cut", "clean", "pack", "check", "export"]);
  assert.deepEqual(planStages("frames-folder", { ...phaser, review: false }).filter((s) => s.run).map((s) => s.id), ["clean", "pack", "export"]);
  assert.deepEqual(planStages("video", { ...phaser, pack: false }).filter((s) => s.run).map((s) => s.id), ["cut", "clean", "export"]);
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
  assert.equal(processorOptions({ ...phaser, background: "none" }).keyMode, "none");
  assert.equal(processorOptions({ ...phaser, background: "ai" }).keyMode, "ai");
  assert.equal(processorOptions(phaser, { keyMode: "alpha" }).keyMode, "alpha");
  assert.equal(processorOptions(builtinPresets.find((p) => p.id === "pixel-art")).pixelate.gridMode, "adaptive");
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
  const result = await runConveyor({ paths: [frames], preset: { ...phaser, useModel: false }, outputDir: out, deps: stages });
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
