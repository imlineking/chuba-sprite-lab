// Real-file processing benchmark. Outputs are isolated; source hashes are checked.
// node scripts/benchmark-processing.mjs <game-root> <out> <original-bzzz.png>
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { inspectSource, processSprites, processFramePreview, keyFrame, clearRenderCache } from "../src/processor.mjs";
import { describeSpriteSheet } from "../src/source-describe.mjs";
import { measureSource, planAutoPilot } from "../src/auto-pilot.mjs";
import { comparePlanners } from "../src/copilot-planner.mjs";
import { aiModelCatalog } from "../src/ai-models.mjs";
import { pixelModes, pixelDithers } from "../src/pixelate.mjs";
import { loadAuxSession, inpaintLama, interpolateRife, upscaleEsrgan, estimateDepth } from "../src/aux-ai.mjs";

const root = path.resolve(import.meta.dirname, "..");
const game = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const bzzz = path.resolve(process.argv[4]);
await fs.mkdir(output, { recursive: true });
const generated = path.join(output, "inputs"); await fs.mkdir(generated, { recursive: true });
const file = relative => path.join(game, relative);
const portrait = file("public/images/NEW sprites/Varyag/references/gudkov-indoor-front.jpeg");
const flowers = file("new assets/flower_white.png");
const branch = file("new assets/branch_leaves_hanging_01.png");
const yarn = file("public/images/monya-dream/props/yarn-ball-roll-and-guide-6-frame-review.png");
const pig = file("public/images/video/pig artist.mp4");
const paper = file("public/images/comic-events/paper-crumple-unfold-cycle.webm");
const mixed = [branch, flowers, file("new assets/branch_leaves_hanging_09.png")];
const originals = [...new Set([portrait, flowers, branch, yarn, pig, paper, bzzz, ...mixed])];
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const fingerprints = new Map(await Promise.all(originals.map(async name => [name, hash(await fs.readFile(name))])));
const installed = [];
for (const model of aiModelCatalog) if (await fs.stat(path.join(root, "models", model.file)).catch(() => null)) installed.push(model.id);
const report = { generatedAt: new Date().toISOString(), rootCommit: process.env.CHUBA_BENCH_COMMIT || null, profile: "CPU / fast / same processing settings across planners", checks: [], workflows: [], matting: [], styles: [], auxiliary: [], failures: [] };
const save = () => fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
async function attempt(name, callback) {
  const started = performance.now();
  try { const value = await callback(); report.checks.push({ name, ok: true, elapsedMs: Math.round(performance.now() - started) }); console.log(JSON.stringify({ name, ok: true })); await save(); return value; }
  catch (error) { report.failures.push({ name, message: error.message, stack: error.stack }); console.log(JSON.stringify({ name, ok: false, error: error.message })); await save(); return null; }
}
const common = { keyMode: "alpha", fps: 8, maxFrames: 12, autoSize: true, autoColumns: true, padding: 12, pixelPerfect: true, anchor: "center", removeDuplicates: false, aiProvider: "cpu", aiQuality: "fast", aiCutoff: "auto", aiSoftness: 0, aiModelDirs: [path.join(root, "models")], exports: { sheet: true, metadata: true, frames: true, preview: true } };
async function rgba(name) { return sharp(name).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); }
async function metrics(name, reference) {
  const { data, info } = await rgba(name);
  const colours = new Set(); let opaque = 0, soft = 0;
  for (let o = 0; o < data.length; o += 4) { if (data[o + 3] > 127) { opaque++; colours.add(`${data[o]},${data[o + 1]},${data[o + 2]}`); } if (data[o + 3] > 0 && data[o + 3] < 255) soft++; }
  const result = { width: info.width, height: info.height, opaque, soft, colours: colours.size, rgbaSha256: hash(data) };
  if (reference) {
    const truth = await rgba(reference); assert.equal(data.length, truth.data.length);
    let union = 0, intersection = 0, foreground = 0, removed = 0, background = 0, leaked = 0, white = 0, whiteRetained = 0;
    for (let o = 0; o < data.length; o += 4) {
      const expected = truth.data[o + 3] > 127, actual = data[o + 3] > 127;
      if (expected || actual) union++; if (expected && actual) intersection++;
      if (expected) { foreground++; if (!actual) removed++; if (Math.min(truth.data[o], truth.data[o + 1], truth.data[o + 2]) > 230) { white++; if (actual) whiteRetained++; } }
      else { background++; if (actual) leaked++; }
    }
    Object.assign(result, { iou: intersection / Math.max(1, union), foregroundRecall: 1 - removed / Math.max(1, foreground), backgroundRemoved: 1 - leaked / Math.max(1, background), whiteDetailRecall: white ? whiteRetained / white : null, removed, leaked, whitePixels: white });
  }
  return result;
}
function applyAuto(plan, options) {
  const settings = { ...options };
  for (const step of plan.steps) {
    if (step.stage === "key") settings.keyMode = step.tool === "alpha" ? "alpha" : "auto";
    if (step.stage === "matting" && step.status === "ready") Object.assign(settings, { keyMode: "ai", aiModel: step.modelId, aiForceModel: true });
    if (step.stage === "checker") settings.aiEdits = [...(settings.aiEdits || []), { type: "checker", frameIndex: 0, applyAll: true }];
    if (step.stage === "fringe") settings.edgeDecontaminate = true;
    if (step.stage === "pixelate") settings.pixelate = step.settings;
  }
  return settings;
}
async function checkAtlas(result) {
  const json = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
  assert.equal(json.frameCount, result.frameCount); assert.equal(json.frames.length, result.frameCount);
  assert.ok(!result.atlasIssues?.some(issue => issue.severity === "error"));
  const meta = await sharp(result.sheetPath).metadata(); assert.ok(meta.width && meta.height);
  if (result.exports.preview) assert.ok(result.previewPath, "Preview encoder returned no animation");
  return { frameCount: result.frameCount, sheet: result.sheetPath, json: result.manifestPath, preview: result.previewPath, frames: result.framePaths, width: meta.width, height: meta.height, rgbaSha256: (await metrics(result.sheetPath)).rgbaSha256, issues: result.issues };
}

// A real foreground with known alpha supplies controlled white/checker references.
await attempt("controlled-inputs", async () => {
  const foreground = await sharp(flowers).resize(268, 358, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const truth = await sharp({ create: { width: 320, height: 420, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: foreground, left: 26, top: 31 }]).png().toBuffer();
  await fs.writeFile(path.join(generated, "flowers-truth.png"), truth);
  await sharp(truth).flatten({ background: "white" }).png().toFile(path.join(generated, "flowers-white.png"));
  const checker = Buffer.alloc(320 * 420 * 4);
  for (let y = 0; y < 420; y++) for (let x = 0; x < 320; x++) { const o = (y * 320 + x) * 4; checker.fill((Math.floor(x / 16) + Math.floor(y / 16)) % 2 ? 210 : 255, o, o + 3); checker[o + 3] = 255; }
  await sharp(checker, { raw: { width: 320, height: 420, channels: 4 } }).composite([{ input: truth }]).png().toFile(path.join(generated, "flowers-checker.png"));
});

const cases = [
  { id: "portrait", paths: [portrait], goal: "stylize", options: { keyMode: "ai", aiModel: "toonout", aiForceModel: true, pixelate: { size: 6, colors: 24, mode: "shaded", dither: "bayer4", palette: "auto" } } },
  { id: "white-bzzz", paths: [bzzz], goal: "background", auto: true },
  { id: "atlas-mixed", paths: mixed, goal: "combine", options: { packing: "tight", exports: { ...common.exports, preview: false } } },
  { id: "video-pig", paths: [pig], goal: "animation", kind: "video", options: { fps: 2, maxFrames: 8 } },
  { id: "animation-yarn", paths: [yarn], goal: "animation", kind: "sheet", options: { anchor: "body" } },
  { id: "checker-branch", paths: [branch], goal: "edit", auto: true },
];
for (const entry of cases) await attempt(`workflow-${entry.id}`, async () => {
  const source = entry.kind === "sheet" ? await describeSpriteSheet(root, entry.paths[0], { mode: "objects" }) : await inspectSource({ appRoot: root, kind: entry.kind || "frames", paths: entry.paths });
  const samples = source.samplePaths || source.paths;
  const measurements = await measureSource(samples);
  const auto = planAutoPilot({ measurements, installed, source, target: { intent: entry.goal === "edit" ? "images" : entry.goal, cleanupRequested: entry.goal === "edit", pixelPerfect: true } });
  const options = entry.auto ? applyAuto(auto, common) : { ...common, ...entry.options };
  const plans = await comparePlanners({ paths: samples, snapshot: { source: { kind: source.kind, frameCount: source.paths.length, estimatedFrames: source.estimatedFrames, maskPrepared: source.maskPrepared, opaqueImages: source.opaqueImages, mixedSizes: source.mixedSizes, suggestedKeyMode: source.suggestedKeyMode }, options, ui: { goal: entry.goal, intent: entry.goal === "edit" ? "images" : entry.goal }, aiPlan: auto } });
  const workflow = { id: entry.id, goal: entry.goal, automatic: Boolean(entry.auto), options, auto, plans: [] }; report.workflows.push(workflow);
  for (const plan of plans) {
    clearRenderCache(); const start = performance.now();
    const label = plan.requestedPlanner || plan.planner;
    const item = { planner: label, model: plan.model, scenarios: plan.scenarios, planMs: plan.elapsedMs, fallback: plan.fallback, error: plan.error, firstTaskMatches: plan.scenarios[0]?.task === entry.goal };
    // Execute the explicit job with the same shared tools/settings in all three modes.
    // Current vision planners select scenarios, not new per-pixel matting algorithms.
    if (entry.goal === "edit" || entry.id === "portrait" || entry.goal === "background") {
      const result = await processFramePreview({ inputPath: source.paths[0], appRoot: root, options });
      item.png = path.join(output, `${entry.id}-${label}.png`); await fs.copyFile(result.afterPath, item.png);
      item.metrics = await metrics(item.png);
    } else {
      const result = await processSprites({ source, appRoot: root, outputDir: output, name: `${entry.id}-${label}`, options });
      Object.assign(item, await checkAtlas(result));
    }
    item.processingMs = Math.round(performance.now() - start); workflow.plans.push(item); await save();
  }
  const digests = workflow.plans.map(item => item.metrics?.rgbaSha256 || item.rgbaSha256);
  workflow.identicalPixelsAcrossPlanners = new Set(digests).size === 1;
});

// Compare actual matting tools, including destructive all-colour and safe contour modes.
const mattingCases = [
  { id: "bzzz", input: bzzz }, { id: "branch", input: branch }, { id: "white-flowers", input: flowers },
  { id: "white-controlled", input: path.join(generated, "flowers-white.png"), reference: path.join(generated, "flowers-truth.png") },
  { id: "checker-controlled", input: path.join(generated, "flowers-checker.png"), reference: path.join(generated, "flowers-truth.png") },
  { id: "photo", input: portrait },
];
for (const entry of mattingCases) for (const tool of ["contour", "all-colour", "checker", "toonout"]) {
  if (tool === "checker" && !["branch", "checker-controlled"].includes(entry.id)) continue;
  if (entry.id === "photo" && ["contour", "all-colour"].includes(tool)) continue;
  await attempt(`matting-${entry.id}-${tool}`, async () => {
    clearRenderCache(); const start = performance.now();
    const mode = tool === "contour" || tool === "all-colour" ? "white" : tool === "checker" ? "alpha" : "ai";
    const result = await keyFrame(entry.input, mode, 18, 0, 0, { ...common, appRoot: root, aiForceModel: true, aiModel: tool, keyScope: tool === "all-colour" ? "all" : "border", frameIndex: 0, aiEdits: tool === "checker" ? [{ type: "checker", frameIndex: 0 }] : [] });
    const name = path.join(output, `${entry.id}-${tool}.png`); await fs.writeFile(name, result.buffer);
    report.matting.push({ id: entry.id, tool, output: name, elapsedMs: Math.round(performance.now() - start), model: result.aiMetrics, metrics: await metrics(name, entry.reference) });
  });
}

// Every pixel drawing mode and every dither, using a single prepared photo mask.
const portraitMask = path.join(output, "photo-toonout.png");
for (const mode of pixelModes) await attempt(`pixel-style-${mode}`, async () => {
  const start = performance.now(); const result = await processFramePreview({ inputPath: portraitMask, appRoot: root, options: { ...common, pixelate: { size: 6, colors: 24, mode, dither: "none", palette: "auto" } } });
  const name = path.join(output, `portrait-${mode}.png`); await fs.copyFile(result.afterPath, name);
  const stats = await metrics(name); assert.ok(stats.colours <= (mode === "outline" ? 25 : mode === "lineart" ? 2 : 24)); assert.equal(stats.soft, 0);
  report.styles.push({ mode, output: name, elapsedMs: Math.round(performance.now() - start), metrics: stats });
});
for (const dither of pixelDithers) await attempt(`pixel-dither-${dither}`, async () => {
  const result = await processFramePreview({ inputPath: portraitMask, appRoot: root, options: { ...common, pixelate: { size: 6, colors: 24, mode: "shaded", dither, palette: "auto" } } });
  const name = path.join(output, `portrait-dither-${dither}.png`); await fs.copyFile(result.afterPath, name);
  report.styles.push({ dither, output: name, metrics: await metrics(name) });
});

await attempt("video-paper-full-cycle", async () => {
  const source = await inspectSource({ kind: "video", paths: [paper], appRoot: root }); clearRenderCache();
  const result = await processSprites({ source, appRoot: root, outputDir: output, name: "paper-cycle", options: { ...common, fps: 12, maxFrames: 80, removeDuplicates: true } });
  const built = await checkAtlas(result); assert.ok(built.frameCount > 10); assert.ok(built.frameCount <= 80);
  report.workflows.push({ id: "paper-cycle", result: built, skipped: result.skipped });
});

// Auxiliary stages use compact real crops, explicitly requested (never automatic pixel-art repair).
const small = path.join(generated, "portrait-96.png"); await sharp(portrait).resize(96, 96).png().toFile(small);
for (const tool of ["real-esrgan", "depth-anything-v2", "rife", "lama"]) await attempt(`auxiliary-${tool}`, async () => {
  const model = aiModelCatalog.find(item => item.id === tool); const session = await loadAuxSession(path.join(root, "models", model.file));
  const start = performance.now(); let result;
  if (tool === "real-esrgan") { result = await upscaleEsrgan(session, small); assert.equal(result.width, 384); }
  if (tool === "depth-anything-v2") result = await estimateDepth(session, portrait);
  if (tool === "rife") {
    const paths = report.workflows.find(item => item.id === "animation-yarn").plans[0].frames;
    const a = path.join(generated, "yarn-a.png"), b = path.join(generated, "yarn-b.png");
    await sharp(paths[0]).resize(192, 160, { fit: "fill" }).png().toFile(a); await sharp(paths[1]).resize(192, 160, { fit: "fill" }).png().toFile(b);
    result = await interpolateRife(session, a, b);
  }
  if (tool === "lama") {
    const image = path.join(generated, "photo-320.png"), mask = path.join(generated, "lama-mask.png");
    await sharp(portrait).resize(320, 320).png().toFile(image);
    const bytes = Buffer.alloc(320 * 320); for (let y = 221; y < 247; y++) for (let x = 10; x < 50; x++) bytes[y * 320 + x] = 255;
    await sharp(bytes, { raw: { width: 320, height: 320, channels: 1 } }).png().toFile(mask);
    result = await inpaintLama(session, image, mask);
    const before = await rgba(image), after = await sharp(result.buffer).ensureAlpha().raw().toBuffer();
    for (let i = 0; i < bytes.length; i++) if (!bytes[i]) assert.ok(after.subarray(i * 4, i * 4 + 4).equals(before.data.subarray(i * 4, i * 4 + 4)), "LaMa changed pixels outside selection");
  }
  const name = path.join(output, `aux-${tool}.png`); await fs.writeFile(name, result.buffer);
  report.auxiliary.push({ tool, output: name, elapsedMs: Math.round(performance.now() - start), metrics: await metrics(name) }); await session.release();
});

await attempt("originals-unchanged", async () => { for (const [name, before] of fingerprints) assert.equal(hash(await fs.readFile(name)), before); });
report.ok = report.failures.length === 0; await save();
console.log(JSON.stringify({ checks: report.checks.length, failures: report.failures.length, output }));
process.exitCode = report.ok ? 0 : 1;
