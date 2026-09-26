// Local operator tests on real assets. Not part of EXE packaging.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { processFramePreview } from "../src/processor.mjs";
import { selectionContains } from "../src/region-color.mjs";
const root = path.resolve(import.meta.dirname, "..");
const output = path.resolve(process.argv[2]);
const bzzz = path.resolve(process.argv[3]);
const result = { checks: [], failures: [] };
const original = await sharp(bzzz).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
async function run(name, options, check) {
  try {
    const preview = await processFramePreview({ inputPath: bzzz, appRoot: root, options });
    const file = path.join(output, `${name}.png`); await fs.copyFile(preview.afterPath, file);
    const raw = await sharp(file).ensureAlpha().raw().toBuffer();
    const details = check ? await check(raw) : {};
    result.checks.push({ name, file, ...details });
  } catch (error) { result.failures.push({ name, message: error.message }); }
}
for (const [name, selection] of [
  ["selection-rectangle", { left: .62, top: .1, right: .9, bottom: .8 }],
  ["selection-lasso", { points: [{ x: .5, y: .2 }, { x: .9, y: .2 }, { x: .84, y: .85 }, { x: .58, y: .75 }] }],
]) await run(name, { keyMode: "alpha", aiEdits: [{ type: "region-color", frameIndex: 0, color: [255, 255, 255], tolerance: 28, selection }] }, raw => {
  let changed = 0;
  for (let y = 0; y < original.info.height; y++) for (let x = 0; x < original.info.width; x++) {
    const o = (y * original.info.width + x) * 4;
    if (!selectionContains(selection, (x + .5) / original.info.width, (y + .5) / original.info.height)) assert.ok(raw.subarray(o, o + 4).equals(original.data.subarray(o, o + 4)), "Selection modified pixels outside its boundary");
    else if (raw[o + 3] !== original.data[o + 3]) changed++;
  }
  assert.ok(changed > 0); return { changed, outsideUnchanged: true };
});
for (const [mode, width, depth] of [["trim", 1, 2], ["trim", 3, 2], ["recolor", 1, 2], ["recolor", 3, 5]]) {
  await run(`edge-${mode}-${width}-${depth}`, { keyMode: "white", tolerance: 18, blackOutline: 0, blackFeather: 0, edgeRefine: { mode, width, depth, whiteOnly: true } });
}
const alphaPreview = await processFramePreview({ inputPath: bzzz, appRoot: root, options: { keyMode: "white", tolerance: 18, blackOutline: 0 } });
const alpha = await sharp(alphaPreview.afterPath).ensureAlpha().raw().toBuffer();
const toned = await processFramePreview({ inputPath: alphaPreview.afterPath, appRoot: root, options: { keyMode: "alpha", toning: { color: "#c46eff", strength: 35 } } });
const tonePath = path.join(output, "toned-bzzz.png"); await fs.copyFile(toned.afterPath, tonePath);
const toneBytes = await sharp(tonePath).ensureAlpha().raw().toBuffer();
for (let o = 3; o < alpha.length; o += 4) assert.equal(toneBytes[o], alpha[o]);
result.checks.push({ name: "toning-keeps-alpha", file: tonePath });
const photo = path.join(output, "photo-birefnet-tiny.png");
for (const [name, options] of [["portrait-tuned-clean", { size: 4, colors: 48, mode: "clean", dither: "none", palette: "auto" }], ["portrait-tuned-outline", { size: 4, colors: 48, mode: "outline", dither: "none", palette: "auto" }]]) {
  const preview = await processFramePreview({ inputPath: photo, appRoot: root, options: { keyMode: "alpha", pixelate: options } });
  const file = path.join(output, `${name}.png`); await fs.copyFile(preview.afterPath, file); result.checks.push({ name, file });
}
await fs.writeFile(path.join(output, "editor-ops-report.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result)); process.exitCode = result.failures.length ? 1 : 0;
