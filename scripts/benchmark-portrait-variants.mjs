import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { keyFrame, processFramePreview, clearRenderCache } from "../src/processor.mjs";
import { pixelModes, pixelDithers } from "../src/pixelate.mjs";
const root = path.resolve(import.meta.dirname, "..");
const photo = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const report = { matting: [], styles: [] };
for (const model of ["toonout"]) {
  clearRenderCache(); const started = performance.now();
  const result = await keyFrame(photo, "ai", 28, 0, 0, { appRoot: root, aiModelDirs: [path.join(root, "models")], aiModel: model, aiProvider: "cpu", aiQuality: "fast", aiCutoff: "auto", aiSoftness: 0, aiForceModel: true });
  const file = path.join(output, `photo-${model}.png`); await fs.writeFile(file, result.buffer);
  report.matting.push({ model, file, elapsedMs: Math.round(performance.now() - started), metrics: result.aiMetrics });
}
const input = path.join(output, "photo-toonout.png");
const choices = [...pixelModes.map(mode => ({ name: `portrait-best-${mode}`, mode, dither: "none", size: 6, colors: 24 })), ...pixelDithers.map(dither => ({ name: `portrait-best-dither-${dither}`, mode: "shaded", dither, size: 6, colors: 24 })), { name: "portrait-best-tuned-clean", mode: "clean", dither: "none", size: 4, colors: 48 }, { name: "portrait-best-tuned-shaded", mode: "shaded", dither: "none", size: 4, colors: 48, shadingSteps: 8 }];
for (const { name, ...pixelate } of choices) {
  const result = await processFramePreview({ inputPath: input, appRoot: root, options: { keyMode: "alpha", pixelate } });
  const file = path.join(output, `${name}.png`); await fs.copyFile(result.afterPath, file);
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const colours = new Set(); for (let o = 0; o < data.length; o += 4) if (data[o + 3] > 127) colours.add(`${data[o]},${data[o + 1]},${data[o + 2]}`);
  report.styles.push({ name, pixelate, file, size: [info.width, info.height], colours: colours.size });
}
await fs.writeFile(path.join(output, "portrait-variants-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.matting));
