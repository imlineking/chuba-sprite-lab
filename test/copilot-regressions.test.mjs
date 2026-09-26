import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import { inspectSource, makeSourcePreview, keyFrame } from "../src/processor.mjs";
import { analyseBorderBackground, backgroundKeyMode } from "../src/background-analysis.mjs";
import { analyseFrame, measureSource, planAutoPilot } from "../src/auto-pilot.mjs";
import { planSuggestions } from "../src/copilot-rules.mjs";
import { summarizeIssues } from "../src/diagnostics.mjs";
import { executeAdvice } from "../src/copilot-actions.mjs";
import { sliceSpriteSheet } from "../src/sheet-slicer.mjs";
import { parseVideoMetadata } from "../src/video-metadata.mjs";

test("video packet duration wins over longer audio/container duration", () => {
  const result = parseVideoMetadata("Duration: 00:00:06.05\nVideo: h264, yuv420p, 3840x2160, 24 fps", "out_time_us=5960000\nprogress=end\n");
  assert.equal(result.duration, 5.96); assert.equal(result.containerDuration, 6.05);
  assert.equal(result.width, 3840); assert.equal(result.durationSource, "video-packets");
});

test("opening a muxed clip and seeking beyond video end returns existing images", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-mux-regression-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const file = path.join(temp, "audio-longer.mp4");
  const result = spawnSync(path.resolve("vendor/ffmpeg.exe"), ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=white:s=96x64:r=24:d=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.4", "-c:v", "libx264", "-c:a", "aac", file], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const source = await inspectSource({ appRoot: path.resolve("."), kind: "video", paths: [file] });
  assert.ok(source.containerDuration > source.duration + 0.2);
  for (const sample of source.samplePaths) assert.ok((await fs.stat(sample)).size > 0);
  const preview = await makeSourcePreview(file, "video", path.resolve("."), 1.35);
  assert.ok((await sharp(preview).metadata()).width > 0);
});

test("auto respects a prepared mask even when the cropped object's edge is brown", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-mask-regression-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const pixels = Buffer.alloc(24 * 24 * 4);
  for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) if (x !== 23 || y !== 23) pixels.set([140, 70, 20, 255], (y * 24 + x) * 4);
  const file = path.join(temp, "tight-crop.png");
  await sharp(pixels, { raw: { width: 24, height: 24, channels: 4 } }).png().toFile(file);
  const keyed = await keyFrame(file, "auto", 28, 0, 0, { maskPrepared: true });
  assert.deepEqual(await sharp(keyed.buffer).raw().toBuffer(), pixels);
});

test("noise around a flat colour uses the same inexpensive key in both analysers", () => {
  const pixels = Buffer.alloc(192 * 192 * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([128 + (i % 7) - 3, 240 + (i % 5) - 2, 96 + (i % 3) - 1, 255], i);
  const border = analyseBorderBackground(pixels, { width: 192, height: 192 });
  assert.equal(border.solid, true); assert.equal(backgroundKeyMode(border), "auto");
  const measurements = analyseFrame(pixels, { width: 192, height: 192 });
  const plan = planAutoPilot({ measurements, source: { kind: "frames", frameCount: 1 }, installed: ["u2netp"] });
  assert.equal(plan.steps.some(step => step.stage === "background" && step.modelId), false);
  for (let i = 0; i < pixels.length; i += 4) pixels.set(i % 8 ? [10, 20, 30, 255] : [200, 180, 160, 255], i);
  assert.equal(analyseBorderBackground(pixels, { width: 192, height: 192 }).solid, false);
});

test("edge measurements come from native pixels and normalized shape complexity is stable", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-measure-regression-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const values = [];
  for (const size of [128, 512]) {
    const file = path.join(temp, `${size}.png`);
    const rect = await sharp({ create: { width: size / 2, height: size / 2, channels: 4, background: "#915522" } }).png().toBuffer();
    await sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: rect, left: size / 4, top: size / 4 }]).png().toFile(file);
    const measured = await measureSource([file]);
    assert.equal(measured.edgeMeasurement, "native");
    values.push(measured.outlineComplexity);
  }
  assert.ok(Math.abs(values[0] - values[1]) < 0.1);
});

test("far small objects are reported rather than silently dropped or merged", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-fragment-regression-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const file = path.join(temp, "sheet.png");
  const big = await sharp({ create: { width: 150, height: 150, channels: 4, background: "red" } }).png().toBuffer();
  const tiny = await sharp({ create: { width: 7, height: 9, channels: 4, background: "blue" } }).png().toBuffer();
  await sharp({ create: { width: 700, height: 400, channels: 4, background: "white" } }).composite([{ input: big, left: 20, top: 20 }, { input: tiny, left: 600, top: 300 }]).png().toFile(file);
  const result = await sliceSpriteSheet(file, path.join(temp, "frames"), { mode: "objects" });
  assert.equal(result.cells.length, 2); assert.ok(result.issues.some(issue => issue.code === "slice-small-object"));
});

test("pixel art gets pages and never reverse walking, interpolation or AI enlargement", () => {
  const suggestions = planSuggestions({ source: { kind: "sheet" }, options: { pixelPerfect: true }, built: { atlas: { exceeds: true, applied: "warn", limit: 2048 }, issues: [{ code: "loop-seam", message: "English translation" }] }, aiPlan: { steps: [{ stage: "upscale", modelId: "real-esrgan", status: "ready" }, { stage: "interpolate", modelId: "rife", status: "ready" }] } });
  assert.equal(suggestions.find(item => item.id === "atlas-over-limit").steps[0].value, "split");
  assert.deepEqual(suggestions.find(item => item.id === "loop-seam").steps, [{ op: "openLoopEditor" }]);
  assert.ok(!suggestions.some(item => item.id.startsWith("ai-")));
});

test("hundreds of translated warnings form a group without losing frame navigation", () => {
  const result = summarizeIssues(Array.from({ length: 250 }, (_, frameIndex) => ({ code: "silhouette-width-spread", frameIndex, message: `Width ${frameIndex}` })));
  assert.equal(result.warnings.length, 1); assert.equal(result.frameIssues.length, 250);
  assert.equal(result.warningGroups[0].frameIndexes.length, 250);
  assert.ok(planSuggestions({ source: { kind: "sheet" }, built: result }).some(item => item.id === "size-spread"));
});

test("an advice validates all steps first, commits once and rolls back failure", async () => {
  let value = 0; const history = [];
  const api = { capture: () => value, apply: step => { value += step.value || 0; }, restore: before => { value = before; }, commit: before => history.push(before) };
  const steps = [{ op: "option", control: "fps", value: 8 }, { op: "option", control: "fps", value: 12 }];
  await executeAdvice({ ...api, steps }); assert.equal(value, 20); assert.deepEqual(history, [0]);
  value = history.pop(); assert.equal(value, 0, "one undo restores the entire advice");
  await assert.rejects(executeAdvice({ ...api, steps: [...steps, { op: "runShell" }] })); assert.equal(value, 0);
  await assert.rejects(executeAdvice({ ...api, steps, apply: () => { value = 33; throw new Error("Build failed"); } })); assert.equal(value, 0); assert.equal(history.length, 0);
});
