import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { ConveyorSessions } from "../src/conveyor-sessions.mjs";
import { builtinPresets, runConveyor, ConveyorQueue } from "../src/conveyor.mjs";
import { createConveyorStages } from "../src/conveyor-main.mjs";
import { describePaths, describeSpriteSheet } from "../src/source-describe.mjs";
import * as processor from "../src/processor.mjs";
import { buildAtlas } from "../src/pipeline/build.mjs";
import { reviewAtlas } from "../src/critic/critic.mjs";
import { reviewPngs } from "../src/png-review.mjs";
import { planConveyorGuide } from "../src/copilot-conveyor.mjs";
import { capabilitiesFor } from "../src/capabilities.mjs";

const root = path.resolve(import.meta.dirname, "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sprite-recovery-"));
test.after(() => fs.rm(tmp, { recursive: true, force: true }));
const preset = { ...builtinPresets[0], background: "none", edgeCleanup: false, useModel: false };
const stages = () => createConveyorStages({ appRoot: root, sharp, describePaths: (kind, files) => describePaths(root, kind, files), describeSpriteSheet: (file, options) => describeSpriteSheet(root, file, options), executeProcessing: (op, args) => processor[op](args), buildAtlas, reviewAtlas, modelsDirectory: () => path.join(tmp, "models") });
async function fixture(name, width = 32, height = 32) {
  const file = path.join(tmp, name);
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 4; y < height - 4; y++) for (let x = 4; x < width - 4; x++) pixels.set([80, 120, 160, 255], (y * width + x) * 4);
  // Enclosed white artwork must survive the entire pipeline and review.
  pixels.set([255, 255, 255, 255], (8 * width + 8) * 4);
  await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toFile(file);
  return { file, pixels, width, height };
}

test("multiple images require a purpose before processing; guide offers exactly three choices", async () => {
  const a = await fixture("choice-a.png"), b = await fixture("choice-b.png");
  const deps = stages(); deps.clean = () => { throw new Error("must not process before purpose selection"); };
  const result = await runConveyor({ paths: [a.file, b.file], preset, outputDir: path.join(tmp, "choice-out"), deps });
  assert.equal(result.needsIntent, true);
  const guide = planConveyorGuide({ capabilities: capabilitiesFor("image-set") });
  assert.deepEqual(guide.chips.map(c => c.id), ["intent:images", "intent:atlas", "intent:animation"]);
});

for (const intent of ["images", "atlas"]) test(`${intent}: different canvas sizes and white artwork survive real processing`, async () => {
  const a = await fixture(`${intent}-a.png`, 32, 40), b = await fixture(`${intent}-b.png`, 48, 24);
  const result = await runConveyor({ paths: [a.file, b.file], intent, preset, outputDir: path.join(tmp, `${intent}-out`), deps: stages() });
  assert.equal(result.ok, true, result.error);
  const manifest = JSON.parse(await fs.readFile(result.artifacts.manifestPath, "utf8"));
  assert.equal(manifest.frames.length, 2);
  const outputs = intent === "images" ? result.exported.files : Object.keys(JSON.parse(await fs.readFile(result.artifacts.manifestPath, "utf8")).frames).map((_, index) => path.join(result.outputDir, "frames", manifest.animations[index].name, "0000.png"));
  for (const [index, file] of outputs.entries()) {
    const got = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true }), original = [a, b][index];
    assert.deepEqual([got.info.width, got.info.height], [original.width, original.height]);
    assert.deepEqual(got.data, original.pixels);
  }
  assert.equal(result.stages.find(s => s.id === "pack").status, intent === "images" ? "skipped" : "done");
  if (intent === "images") assert.equal(result.review.kind, "png");
  else {
    const atlas = JSON.parse(await fs.readFile(path.join(result.outputDir, "atlas", `${path.parse(a.file).name}.json`), "utf8"));
    assert.deepEqual(Object.values(atlas.frames).map(f => [f.sourceSize.w, f.sourceSize.h]), [[32, 40], [48, 24]]);
  }
});

test("PNG review detects empty output and leaves white details byte-for-byte intact", async () => {
  const a = await fixture("review.png");
  const original = await fs.readFile(a.file);
  const review = await reviewPngs({ framePaths: [a.file] }, preset);
  assert.equal(review.kind, "png"); assert.equal(review.verdict, "accepted");
  assert.equal(review.metrics[0].width, 32);
  assert.deepEqual(await fs.readFile(a.file), original);
  const empty = path.join(tmp, "empty.png");
  await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(empty);
  assert.equal((await reviewPngs({ framePaths: [empty] }, preset)).verdict, "rejected");
});

for (const failAt of ["pack", "exportResult"]) test(`resume after ${failAt} reuses successful real stages`, async () => {
  const a = await fixture(`resume-${failAt}.png`);
  const deps = stages(), calls = { describe: 0, clean: 0, pack: 0, check: 0, exportResult: 0 };
  let fail = true;
  for (const op of Object.keys(calls)) { const original = deps[op]; deps[op] = async (...args) => { calls[op]++; if (op === failAt && fail) { fail = false; throw new Error("simulated failure"); } return original(...args); }; }
  // Two inputs allow testing a real pack failure too.
  const b = await fixture(`resume-${failAt}-b.png`);
  const sessions = new ConveyorSessions(deps), args = { paths: [a.file, b.file], intent: "animation", preset, outputDir: path.join(tmp, `resume-${failAt}-out`) };
  const first = await sessions.run(args);
  assert.equal(first.failedStage, failAt === "pack" ? "pack" : "export"); assert.ok(first.resumeId);
  const second = await sessions.run({ ...args, resumeId: first.resumeId });
  assert.equal(second.ok, true, second.error);
  assert.equal(calls.describe, 1); assert.equal(calls.clean, 1);
  assert.equal(calls.pack, failAt === "pack" ? 2 : 1);
  assert.equal(calls.check, 1); assert.equal(sessions.last, null);
});

for (const change of ["input", "output", "settings", "folder-list", "expired"]) test(`resume rejects changed ${change} without processing`, async () => {
  const dir = path.join(tmp, `tamper-${change}`); await fs.mkdir(dir);
  const a = await fixture(`tamper-${change}.png`); await fs.copyFile(a.file, path.join(dir, "a.png"));
  const deps = stages(); let cleanCalls = 0; const clean = deps.clean;
  deps.clean = async args => { cleanCalls++; return clean(args); };
  deps.exportResult = async () => { throw new Error("export failed"); };
  const sessions = new ConveyorSessions(deps), args = { paths: [dir], intent: "images", preset, outputDir: path.join(tmp, `tamper-${change}-out`) };
  const first = await sessions.run(args); assert.ok(first.resumeId, first.error);
  if (change === "input") await fs.appendFile(path.join(dir, "a.png"), "changed");
  if (change === "output") await fs.appendFile(first.artifacts.previewPath, "changed");
  if (change === "settings") args.preset = { ...preset, edgeCleanup: true };
  if (change === "folder-list") await fs.copyFile(a.file, path.join(dir, "new.png"));
  if (change === "expired") sessions.last.at = 0;
  const second = await sessions.run({ ...args, resumeId: first.resumeId });
  assert.equal(second.resumeInvalid, true); assert.equal(cleanCalls, 1);
});

test("queue persists the chosen purpose", async () => {
  const file = path.join(tmp, "intent-queue.json");
  const queue = new ConveyorQueue({ file, run: async () => ({ ok: true }) });
  await queue.add({ paths: ["a.png", "b.png"], presetId: "phaser", intent: "atlas" });
  const next = new ConveyorQueue({ file, run: async item => { assert.equal(item.intent, "atlas"); return { ok: true }; } });
  await next.load(); await next.drain(); assert.equal(next.items[0].status, "done");
});

test("cancelled processing releases its checkpoint and offers no resume", async () => {
  const a = await fixture("cancelled.png"), controller = new AbortController();
  const deps = stages();
  deps.clean = async () => { controller.abort(); throw new Error("Cancelled"); };
  const sessions = new ConveyorSessions(deps);
  const result = await sessions.run({ paths: [a.file], preset, outputDir: path.join(tmp, "cancelled-out"), signal: controller.signal });
  assert.equal(result.ok, false); assert.equal(result.resumeId, undefined); assert.equal(sessions.last, null);
});
