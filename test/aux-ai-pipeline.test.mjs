import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { processSprites } from "../src/processor.mjs";

const modelsDir = process.env.CHUBA_AUX_MODELS;

test("LaMa, Real-ESRGAN, RIFE and Depth Anything V2 finish one atlas without changing the sources", { skip: !modelsDir }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-aux-smoke-"));
  try {
    const sourcePaths = [];
    for (let frame = 0; frame < 2; frame += 1) {
      const bytes = Buffer.alloc(64 * 64 * 4);
      for (let y = 14; y < 46; y += 1) for (let x = 12 + frame * 8; x < 36 + frame * 8; x += 1) {
        const offset = (y * 64 + x) * 4;
        bytes[offset] = 230; bytes[offset + 1] = 105 + frame * 30; bytes[offset + 2] = 28; bytes[offset + 3] = 255;
      }
      const file = path.join(root, `frame-${frame}.png`);
      await sharp(bytes, { raw: { width: 64, height: 64, channels: 4 } }).png().toFile(file);
      sourcePaths.push(file);
    }
    const before = await Promise.all(sourcePaths.map((file) => fs.readFile(file)));
    const maskBytes = Buffer.alloc(64 * 64, 0);
    for (let y = 20; y < 27; y += 1) for (let x = 20; x < 27; x += 1) maskBytes[y * 64 + x] = 255;
    const maskPath = path.join(root, "mask.png");
    await sharp(maskBytes, { raw: { width: 64, height: 64, channels: 1 } }).png().toFile(maskPath);

    const result = await processSprites({
      source: { kind: "frames", paths: sourcePaths, title: "aux-smoke" },
      outputDir: root,
      name: "result",
      appRoot: path.resolve(import.meta.dirname, ".."),
      options: {
        aiModelDirs: [modelsDir], auxAI: { inpaintMaskPath: maskPath, upscale: true, interpolate: true, depth: true },
        keyMode: "alpha", fps: 8, autoSize: true, padding: 8, columns: 2,
        exports: { sheet: true, frames: true, metadata: true, preview: false },
      },
    });
    const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
    const report = JSON.parse(await fs.readFile(result.reportPath, "utf8"));
    assert.equal(result.frameCount, 3);
    assert.equal(manifest.fps, 16);
    assert.equal(manifest.depthMaps[0].images.length, 3);
    assert.deepEqual(report.aiStages, { lama: true, rife: true, realEsrgan: true, depthAnythingV2: true });
    for (const file of result.depthPaths) assert.ok((await fs.stat(file)).size > 100);
    const after = await Promise.all(sourcePaths.map((file) => fs.readFile(file)));
    after.forEach((bytes, index) => assert.deepEqual(bytes, before[index]));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
