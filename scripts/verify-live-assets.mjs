// Live regressions are mandatory here, not optional/skipped. Originals stay outside git.
// node scripts/verify-live-assets.mjs [game-root] [output-directory]
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { inspectSource, keyFrame, processSprites } from "../src/processor.mjs";
import { describeSpriteSheet } from "../src/source-describe.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const game = path.resolve(process.argv[2] || path.join(root, "../.."));
const output = path.resolve(process.argv[3] || path.join(root, ".diagnostics/live-regressions"));
await fs.mkdir(output, { recursive: true });
const manifest = JSON.parse(await fs.readFile(path.join(root, "test/fixtures/live-assets.json"), "utf8"));
const report = { generatedAt: new Date().toISOString(), cases: [] };
for (const entry of manifest) {
  const file = path.join(game, entry.file);
  const hash = crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
  assert.equal(hash, entry.sha256, `Original changed: ${entry.file}. Review before updating the golden manifest.`);
  if (entry.kind === "video") {
    const source = await inspectSource({ kind: "video", paths: [file], appRoot: root });
    assert.equal(source.durationSource, "video-packets");
    for (const sample of source.samplePaths) assert.ok((await fs.stat(sample)).size > 0);
    const result = await processSprites({ source, appRoot: root, outputDir: path.join(output, entry.id), name: entry.id, options: { keyMode: "alpha", fps: 2, maxFrames: 4, autoSize: true, autoColumns: true, pixelPerfect: true, exports: { sheet: true, metadata: true, frames: true, preview: false } } });
    assert.ok(result.frameCount > 0); assert.ok((await fs.stat(result.manifestPath)).size > 0);
    report.cases.push({ id: entry.id, sha256: hash, opened: true, duration: source.duration, containerDuration: source.containerDuration, dimensions: [source.width, source.height], framesBuilt: result.frameCount });
  } else {
    const source = await describeSpriteSheet(root, file, { mode: "objects" });
    assert.equal(source.paths.length, entry.objects, entry.id);
    assert.equal(source.maskPrepared, true);
    let lostPixels = 0;
    for (const frame of source.paths) {
      const original = await sharp(frame).ensureAlpha().raw().toBuffer();
      const keyed = await keyFrame(frame, "auto", 28, 3, 0, { maskPrepared: source.maskPrepared });
      const after = await sharp(keyed.buffer).ensureAlpha().raw().toBuffer();
      for (let i = 3; i < original.length; i += 4) if (original[i] > 12 && after[i] <= 12) lostPixels++;
      assert.deepEqual(after, original, "Auto must retain every prepared RGBA pixel");
    }
    assert.equal(lostPixels, 0);
    const result = await processSprites({ source, appRoot: root, outputDir: path.join(output, entry.id), name: entry.id, options: { keyMode: "auto", fps: 8, maxFrames: 20, autoSize: true, autoColumns: true, pixelPerfect: true, anchor: "body", padding: 12, removeDuplicates: false, exports: { sheet: true, metadata: true, frames: true, preview: false } } });
    assert.equal(result.frameCount, entry.objects);
    const json = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
    assert.equal(json.frames.length, entry.objects);
    assert.ok(!result.atlasIssues?.some(issue => issue.severity === "error"));
    report.cases.push({ id: entry.id, sha256: hash, objects: source.paths.length, lostPixels, issues: source.sourceIssues, atlas: [result.atlas.width, result.atlas.height], json: result.manifestPath });
  }
  console.log(JSON.stringify(report.cases.at(-1)));
}
await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
