import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { FrameClock, independentOptions, workingSignature } from "../src/conveyor-working.mjs";
import { rebuildWorkingResult } from "../src/conveyor-rebuild.mjs";
import { createConveyorStages } from "../src/conveyor-main.mjs";
import { builtinPresets, runConveyor } from "../src/conveyor.mjs";
import * as processor from "../src/processor.mjs";
import { describePaths, describeSpriteSheet } from "../src/source-describe.mjs";
import { buildAtlas } from "../src/pipeline/build.mjs";
import { reviewAtlas } from "../src/critic/critic.mjs";
import { reviewPngs } from "../src/png-review.mjs";

test("frame clock respects unequal durations, pause, stepping and long stalls", () => {
  const clock = new FrameClock([{ durationMs: 80 }, { durationMs: 240 }, { durationMs: 120 }]);
  clock.play(1000); assert.equal(clock.tick(1079), 0); assert.equal(clock.tick(1080), 1);
  assert.equal(clock.tick(1319), 1); assert.equal(clock.tick(1320), 2); assert.equal(clock.tick(1440), 0);
  clock.pause(); clock.tick(20000); assert.equal(clock.index, 0);
  clock.seek(1); clock.play(20000); assert.equal(clock.tick(20239), 1); assert.equal(clock.tick(20240), 2);
  assert.equal(clock.tick(20000 + 440 * 100000 + 240), 2);
});
test("working signature ignores selection but includes pixels, masks and timing", () => {
  assert.equal(workingSignature({ previewFrameIndex: 0, keyMode: "alpha" }), workingSignature({ previewFrameIndex: 8, keyMode: "alpha" }));
  for (const options of [{ frameOverrides: { 0: "edited.png" } }, { aiEdits: [{ frameIndex: 0 }] }, { timeline: [{ src: 0, durationMs: 250 }] }]) assert.notEqual(workingSignature({}), workingSignature(options));
});
test("independent objects remap only their own override and mask", () => {
  const options = independentOptions({ frameOverrides: { 0: "a", 1: "b" }, frameMetadata: { 1: { durationMs: 90 } }, aiEdits: [{ frameIndex: 0 }, { frameIndex: 1 }, { applyAll: true }], timeline: [{ src: 1 }] }, 1);
  assert.deepEqual(options.frameOverrides, { 0: "b" });
  assert.deepEqual(options.frameMetadata, { 0: { durationMs: 90 } });
  assert.equal(options.aiEdits.length, 2); assert.ok(options.aiEdits.every(e => e.frameIndex === 0)); assert.equal(options.timeline, null);
});

const root = path.resolve(import.meta.dirname, ".."), tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sprite-working-"));
test.after(() => fs.rm(tmp, { recursive: true, force: true }));
const preset = { ...builtinPresets[0], background: "none", edgeCleanup: false, useModel: false };
const stages = () => createConveyorStages({ appRoot: root, sharp, describePaths: (kind, files) => describePaths(root, kind, files), describeSpriteSheet: (file, options) => describeSpriteSheet(root, file, options), executeProcessing: (op, args) => processor[op](args), buildAtlas, reviewAtlas, modelsDirectory: () => path.join(tmp, "models") });
async function png(name, color, width = 32, height = 32) {
  const file = path.join(tmp, name);
  await sharp({ create: { width, height, channels: 4, background: color } }).png().toFile(file); return file;
}

for (const intent of ["animation", "images", "atlas"]) test(`${intent}: rebuilding exports edited pixels, dimensions and timing without modifying old files`, async () => {
  const a = await png(`${intent}-a.png`, { r: 70, g: 80, b: 90, alpha: 1 });
  const b = await png(`${intent}-b.png`, { r: 90, g: 80, b: 70, alpha: 1 }, 32, intent === "animation" ? 32 : 48);
  const edited = await png(`${intent}-edited.png`, { r: 220, g: 10, b: 40, alpha: 1 });
  const deps = stages();
  const first = await runConveyor({ paths: [a, b], intent, preset, outputDir: path.join(tmp, intent), deps }); assert.equal(first.ok, true, first.error);
  const before = await fs.readFile(first.artifacts.previewPath);
  const source = await deps.describe(await deps.detect([a, b]));
  const result = await rebuildWorkingResult({ source, intent, preset, outputDir: first.outputDir, options: { keyMode: "alpha", frameOverrides: { 0: edited }, frameMetadata: { 0: { durationMs: 80 }, 1: { durationMs: 240 } }, fringeCleanup: false, edgeDecontaminate: false, pixelate: null }, deps });
  assert.equal(result.ok, true, result.error); assert.notEqual(result.outputDir, first.outputDir);
  const output = await sharp(result.artifacts.previewPath).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([...output.data.subarray(0, 4)], [220, 10, 40, 255]); assert.equal(output.info.width, 32);
  assert.deepEqual(await fs.readFile(first.artifacts.previewPath), before);
  assert.equal(result.artifacts.frames.length, 2);
  assert.deepEqual(result.artifacts.frames.map(f => f.durationMs), [80, 240]);
  const second = await sharp(result.artifacts.frames[1].path).metadata(); assert.equal(second.height, intent === "animation" ? 32 : 48);
  // The queue receives the current manifest, not the original user inputs.
  const queued = await runConveyor({ paths: [result.artifacts.manifestPath], intent, preset, outputDir: path.join(tmp, `${intent}-queued`), deps });
  assert.equal(queued.ok, true, queued.error);
  const queuedPixels = await sharp(queued.artifacts.previewPath).ensureAlpha().raw().toBuffer();
  assert.deepEqual([...queuedPixels.subarray(0, 4)], [220, 10, 40, 255]);
  assert.equal(queued.artifacts.frameCount, 2);
});

test("PNG findings carry correct frame and bounded image coordinates without altering alpha", async () => {
  const data = Buffer.alloc(40 * 24 * 4);
  data.set([250, 250, 250, 120], (7 * 40 + 23) * 4);
  const file = path.join(tmp, "pale.png"); await sharp(data, { raw: { width: 40, height: 24, channels: 4 } }).png().toFile(file);
  const before = await fs.readFile(file), report = await reviewPngs({ framePaths: [file] }, preset);
  const issue = report.issues.find(i => i.code === "pale_alpha");
  assert.equal(issue.target.frameIndex, 0); assert.deepEqual(issue.regions, [{ left: 23, top: 7, width: 1, height: 1 }]);
  assert.deepEqual(await fs.readFile(file), before);
});
