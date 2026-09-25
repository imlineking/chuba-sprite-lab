// Compares processing widths and reports the stage breakdown of a real build, so a speed
// change is decided by measurement instead of by intuition.
//
//   node scripts/benchmark-pipeline.mjs <папка-с-кадрами> [кадров] [keyMode] [ширины]
//   node scripts/benchmark-pipeline.mjs "public\images\enemies" 12 ai 1,2,4
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clearRenderCache, processSprites } from "../src/processor.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const folder = process.argv[2];
const limit = Number(process.argv[3]) || 12;
const keyMode = process.argv[4] || "ai";
const widths = (process.argv[5] || "1,2,4").split(",").map((value) => Number(value)).filter((value) => value > 0);
const atlasMaxSize = Number(process.argv[6]) || 0;

if (!folder) {
  console.log('Укажите папку с кадрами: node scripts/benchmark-pipeline.mjs <папка> [кадров] [keyMode] [ширины]');
  process.exit(1);
}

const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => null);
if (!entries) {
  console.log(`Папка не найдена: ${folder}`);
  process.exit(1);
}
const paths = entries
  .filter((entry) => entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name))
  .map((entry) => path.join(folder, entry.name))
  .sort()
  .slice(0, limit);
if (!paths.length) {
  console.log("В папке нет изображений.");
  process.exit(1);
}

console.log(`Кадров: ${paths.length} · режим очистки: ${keyMode} · ширина пула: ${widths.join(", ")}`);
for (const width of widths) {
  // Every width has to do the work: the shared render cache would otherwise answer instantly.
  clearRenderCache();
  const started = performance.now();
  const result = await processSprites({
    source: { kind: "frames", paths, title: "benchmark" },
    appRoot,
    previewOnly: true,
    options: {
      keyMode, maxFrames: limit, autoSize: true, autoColumns: true, removeDuplicates: false,
      outputBackground: "transparent", frameParallelism: width,
      ...(atlasMaxSize ? { atlasMaxSize, atlasOverflow: "split" } : {}),
      exports: { sheet: true, frames: false, metadata: true, preview: false },
    },
  });
  const total = Math.round(performance.now() - started);
  const report = JSON.parse(await fs.readFile(result.reportPath, "utf8"));
  const stages = report.timingsMs || {};
  const build = report.buildMs || {};
  console.log(`  пул ${String(width).padStart(2)} · всего ${String(total).padStart(6)} мс · очистка ${String(stages.key ?? 0).padStart(5)}, выравнивание ${String(stages.normalize ?? 0).padStart(5)} · подготовка ${String(build.items ?? 0).padStart(5)}, склейка ${String(build.sheetPrep ?? 0).padStart(4)} + ${String(build.sheetEncode ?? 0).padStart(4)}, метаданные ${String(build.metadata ?? 0).padStart(3)}, превью ${String(build.preview ?? 0).padStart(5)} · ускоритель ${report.aiProvider || "—"}`);
}
