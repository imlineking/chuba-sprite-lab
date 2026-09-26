import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { aiModelCatalog } from "../src/ai-models.mjs";
import { loadAuxSession, upscaleEsrgan, estimateDepth, inpaintLama } from "../src/aux-ai.mjs";
const root = path.resolve(import.meta.dirname, "..");
const photo = path.resolve(process.argv[2]), output = path.resolve(process.argv[3]);
const small = path.join(output, "inputs/photo-small-quality.png"); await sharp(photo).resize(96, 96).png().toFile(small);
await sharp(small).resize(384, 384, { kernel: "lanczos3" }).png().toFile(path.join(output, "aux-resize-baseline.png"));
const cases = [];
for (const tool of ["real-esrgan", "depth-anything-v2", "lama"]) {
  const entry = aiModelCatalog.find(item => item.id === tool), session = await loadAuxSession(path.join(root, "models", entry.file));
  const start = performance.now(); let result;
  if (tool === "real-esrgan") { result = await upscaleEsrgan(session, small); assert.equal(result.width, 384); }
  if (tool === "depth-anything-v2") result = await estimateDepth(session, photo);
  if (tool === "lama") {
    const input = path.join(output, "inputs/photo-320.png"), mask = path.join(output, "inputs/lama-handle-mask.png");
    const bytes = Buffer.alloc(320 * 320); for (let y = 221; y < 247; y++) for (let x = 10; x < 50; x++) bytes[y * 320 + x] = 255;
    await sharp(bytes, { raw: { width: 320, height: 320, channels: 1 } }).png().toFile(mask);
    result = await inpaintLama(session, input, mask);
    const before = await sharp(input).ensureAlpha().raw().toBuffer(), after = await sharp(result.buffer).ensureAlpha().raw().toBuffer();
    let changed = 0;
    for (let i = 0; i < bytes.length; i++) {
      const equals = before.subarray(i * 4, i * 4 + 4).equals(after.subarray(i * 4, i * 4 + 4));
      if (!bytes[i]) assert.ok(equals, "Outside the LaMa mask changed"); else if (!equals) changed++;
    }
    assert.ok(changed > 0);
  }
  const file = path.join(output, `aux-quality-${tool}.png`); await fs.writeFile(file, result.buffer);
  cases.push({ tool, file, elapsedMs: Math.round(performance.now() - start), width: result.width, height: result.height }); await session.release();
}
await fs.writeFile(path.join(output, "aux-quality-report.json"), JSON.stringify(cases, null, 2)); console.log(JSON.stringify(cases));
