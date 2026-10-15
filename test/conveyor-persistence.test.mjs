import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { ConveyorSessions } from "../src/conveyor-sessions.mjs";
import { builtinPresets, ConveyorQueue } from "../src/conveyor.mjs";
import { createConveyorStages, registerConveyorIpc } from "../src/conveyor-main.mjs";
import * as processor from "../src/processor.mjs";
import { describePaths, describeSpriteSheet } from "../src/source-describe.mjs";
import { buildAtlas } from "../src/pipeline/build.mjs";
import { reviewAtlas } from "../src/critic/critic.mjs";
import { writeAnimatedImage } from "../src/animated-images.mjs";

const appRoot = path.resolve(import.meta.dirname, ".."), tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sprite-persistent-"));
test.after(() => fs.rm(tmp, { recursive: true, force: true }));
const preset = { ...builtinPresets[0], background: "none", edgeCleanup: false, useModel: false };
function stages() {
  return createConveyorStages({ appRoot, sharp, describePaths: (kind, files) => describePaths(appRoot, kind, files), describeSpriteSheet: (f, o) => describeSpriteSheet(appRoot, f, o), executeProcessing: (op, args) => processor[op](args), buildAtlas, reviewAtlas, modelsDirectory: () => path.join(tmp, "models") });
}
async function input(name) {
  const file = path.join(tmp, name + ".gif");
  const pixels = Buffer.alloc(32 * 32 * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([70, 120, 140, 255], i);
  await writeAnimatedImage(file, { width: 32, height: 32, loop: 3, frames: [{ pixels, durationMs: 80 }, { pixels, durationMs: 240 }] }, "gif");
  return file;
}
function rejectCalls(deps, names) { for (const name of names) deps[name] = () => { throw new Error("Unexpected repeat: " + name); }; }

test("restart after extraction survives deletion of the temporary frames", async () => {
  const file = await input("extraction"), directory = path.join(tmp, "extract-cache"), deps = stages();
  let extracted;
  const describe = deps.describe; deps.describe = async d => { const s = await describe(d); extracted = path.dirname(s.paths[0]); return s; };
  deps.clean = async () => { throw new Error("interrupted before cleaning"); };
  const first = await new ConveyorSessions(deps, { directory }).run({ paths: [file], preset, outputDir: path.join(tmp, "extract-out") });
  assert.ok(first.resumeId);
  const stored = JSON.parse(await fs.readFile(path.join(directory, "direct.json"), "utf8"));
  assert.ok(stored.checkpoint.source.paths.every(p => p.startsWith(directory)));
  // This is the extracted directory returned by our fixture's describe operation.
  assert.ok(extracted.startsWith(os.tmpdir()) && path.basename(extracted).startsWith("chuba-animated-image-"));
  await fs.rm(extracted, { recursive: true, force: true });
  const nextDeps = stages(); rejectCalls(nextDeps, ["describe"]);
  const next = new ConveyorSessions(nextDeps, { directory });
  assert.equal((await next.pending()).resumeId, first.resumeId);
  const result = await next.resumeSaved({ resumeId: first.resumeId });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.artifacts.frames.map(f => f.durationMs), [80, 240]);
  assert.equal(await next.pending(), null);
  assert.equal((await fs.readdir(directory)).length, 0);
});

test("restart after packing restores atlas pixels from PNG without repacking or cleaning", async () => {
  const file = await input("packed"), directory = path.join(tmp, "packed-cache"), deps = stages();
  deps.check = async () => { throw new Error("interrupted during review"); };
  const first = await new ConveyorSessions(deps, { directory }).run({ paths: [file], preset, outputDir: path.join(tmp, "packed-out") });
  assert.equal(first.failedStage, "check");
  const stored = await fs.readFile(path.join(directory, "direct.json"), "utf8");
  assert.ok(!stored.includes('"rgba"'), "raw atlas buffers must not be JSON-encoded");
  const nextDeps = stages(); rejectCalls(nextDeps, ["describe", "clean", "pack"]);
  const result = await new ConveyorSessions(nextDeps, { directory }).resumeSaved({ resumeId: first.resumeId });
  assert.equal(result.ok, true, result.error); assert.ok(result.review);
});

test("restart and new destination reuse completed review; old and existing exports survive", async () => {
  const file = await input("move"), directory = path.join(tmp, "move-cache"), deps = stages();
  deps.exportResult = async () => { throw new Error("destination unavailable"); };
  const first = await new ConveyorSessions(deps, { directory }).run({ paths: [file], preset, outputDir: path.join(tmp, "move-old") });
  const oldManifest = await fs.readFile(first.artifacts.manifestPath);
  const chosen = path.join(tmp, "move-new"); await fs.mkdir(path.join(chosen, "move"), { recursive: true });
  const marker = path.join(chosen, "move", "keep.txt"); await fs.writeFile(marker, "existing user export");
  const nextDeps = stages(); rejectCalls(nextDeps, ["describe", "clean", "pack", "check"]);
  const result = await new ConveyorSessions(nextDeps, { directory }).resumeSaved({ resumeId: first.resumeId, outputDir: chosen });
  assert.equal(result.ok, true, result.error); assert.ok(result.outputDir.startsWith(path.join(chosen, "move-resume-")));
  assert.deepEqual(await fs.readFile(first.artifacts.manifestPath), oldManifest);
  assert.equal(await fs.readFile(marker, "utf8"), "existing user export");
  assert.deepEqual(result.artifacts.frames.map(f => f.durationMs), [80, 240]);
  assert.ok(Object.keys(result.reviewConfig.frameMetadata).every(p => p.startsWith(result.outputDir)));
  const pixels = await sharp(result.artifacts.previewPath).ensureAlpha().raw().toBuffer();
  assert.deepEqual([...pixels.subarray(0, 4)], [70, 120, 140, 255]);
});

for (const change of ["input", "cache", "atlas"]) test(`persistent resume rejects changed ${change} before executing stages`, async () => {
  const file = await input("tamper-" + change), directory = path.join(tmp, "tamper-cache-" + change), deps = stages();
  deps.check = async () => { throw new Error("stop"); };
  const first = await new ConveyorSessions(deps, { directory }).run({ paths: [file], preset, outputDir: path.join(tmp, "tamper-out-" + change) });
  const stored = JSON.parse(await fs.readFile(path.join(directory, "direct.json"), "utf8"));
  const target = change === "input" ? file : change === "cache" ? stored.checkpoint.source.paths[0] : path.join(stored.checkpoint.built.config.output, stored.checkpoint.built.pages[0].file);
  await fs.appendFile(target, "changed");
  const nextDeps = stages(); rejectCalls(nextDeps, ["describe", "clean", "pack", "check", "exportResult"]);
  const result = await new ConveyorSessions(nextDeps, { directory }).resumeSaved({ resumeId: first.resumeId });
  assert.equal(result.resumeInvalid, true);
});

test("queue IPC retries one failed task in a new folder using its disk checkpoint", async () => {
  const file = await input("queued"), userData = path.join(tmp, "queue-profile"), directory = path.join(userData, "conveyor-checkpoints");
  const deps = stages(), handlers = new Map(), chosen = path.join(tmp, "queued-new");
  const main = registerConveyorIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, userData, stages: deps, getWindow: () => null, chooseDirectory: async () => chosen });
  await handlers.get("conveyor:queue")(); await main.queue.pause();
  // Built-in quick has no model review. Its exact persisted definition is reused.
  const quick = await main.presets.get("quick");
  const id = await main.queue.add({ paths: [file], presetId: "quick", outputDir: path.join(tmp, "queued-old") });
  const interruptedDeps = stages(); interruptedDeps.exportResult = async () => { throw new Error("export interrupted"); };
  const first = await new ConveyorSessions(interruptedDeps, { directory }).run({ paths: [file], preset: quick, outputDir: path.join(tmp, "queued-old"), quick: false, intent: null, slot: "queue-" + id });
  const item = main.queue.items[0]; item.status = "failed"; item.resumeId = first.resumeId; main.queue.paused = false; await main.queue.persist();
  rejectCalls(deps, ["describe", "clean", "pack"]);
  await handlers.get("conveyor:queue-retry")(null, { id, pickOutput: true }); await main.queue.drain();
  assert.equal(item.status, "done", item.detail); assert.ok(item.resultDir.startsWith(chosen)); assert.equal(item.resumeId, null);
  assert.equal(item.outputDir, chosen, "configured destination must not become nested output/name/name");
  assert.equal(await new ConveyorSessions(stages(), { directory }).pending("queue-" + id), null);
  main.stopWatch();
});

test("retry in a paused queue runs only the chosen task and preserves the pause", async () => {
  const calls = [], queue = new ConveyorQueue({ file: path.join(tmp, "one-shot.json"), run: async item => { calls.push(item.id); return { ok: true, outputDir: "/result" }; } });
  await queue.pause();
  const waiting = await queue.add({ paths: ["waiting.png"], presetId: "quick" });
  const retry = await queue.add({ paths: ["retry.png"], presetId: "quick" });
  queue.items.find(i => i.id === retry).status = "failed";
  await queue.retry(retry); await queue.drain();
  assert.deepEqual(calls, [retry]); assert.equal(queue.paused, true);
  assert.equal(queue.items.find(i => i.id === waiting).status, "pending");
});

test("a modified checkpoint record is rejected, and explicit cancel clears durable assets", async () => {
  const file = await input("record"), directory = path.join(tmp, "record-cache"), deps = stages();
  deps.clean = async () => { throw new Error("stop before cleaning"); };
  const first = await new ConveyorSessions(deps, { directory }).run({ paths: [file], preset, outputDir: path.join(tmp, "record-out") });
  const recordFile = path.join(directory, "direct.json"), record = JSON.parse(await fs.readFile(recordFile, "utf8"));
  record.checkpoint.source.recommendations.fps = 55; await fs.writeFile(recordFile, JSON.stringify(record));
  const next = new ConveyorSessions(stages(), { directory });
  assert.equal((await next.resumeSaved({ resumeId: first.resumeId })).resumeInvalid, true);
  const cancelDirectory = path.join(tmp, "cancel-cache"), controller = new AbortController(), cancelDeps = stages();
  cancelDeps.clean = async () => { controller.abort(); throw new Error("cancelled"); };
  const cancelled = await new ConveyorSessions(cancelDeps, { directory: cancelDirectory }).run({ paths: [file], preset, outputDir: path.join(tmp, "cancel-out"), signal: controller.signal });
  assert.equal(cancelled.resumeId, undefined); assert.deepEqual(await fs.readdir(cancelDirectory), []);
});
