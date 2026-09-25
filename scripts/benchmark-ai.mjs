// Measures the local segmentation model on real frames: which accelerator this machine can
// use and what a pass over a folder actually costs. Absolute numbers depend on the machine,
// so run it where the work happens.
//
//   node scripts/benchmark-ai.mjs <папка-с-кадрами> [кадров]
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { segmentSubject } from "../src/ai-segmentation.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];
const limit = Number(process.argv[3]) || 12;
const quality = process.argv[4] || "balanced";
if (!target) {
  console.log("Укажите папку с кадрами: node scripts/benchmark-ai.mjs <папка> [кадров]");
  process.exit(1);
}

const entries = await fs.readdir(target, { withFileTypes: true }).catch(() => null);
if (!entries) {
  console.log(`Папка не найдена: ${target}`);
  process.exit(1);
}
const files = entries
  .filter((entry) => entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name))
  .map((entry) => path.join(target, entry.name))
  .sort()
  .slice(0, limit);
if (!files.length) {
  console.log("В папке нет изображений.");
  process.exit(1);
}

console.log(`Кадров: ${files.length} из ${target} · качество: ${quality}`);
for (const provider of ["cpu", "dml"]) {
  const started = performance.now();
  let first = 0;
  let last = null;
  try {
    for (const [index, file] of files.entries()) {
      const mark = performance.now();
      last = await segmentSubject(file, { appRoot, provider, cutoff: "auto", quality });
      if (index === 0) first = performance.now() - mark;
    }
  } catch (error) {
    console.log(`${provider.padEnd(4)} недоступен: ${error?.message || error}`);
    continue;
  }
  const total = performance.now() - started;
  const rest = files.length > 1 ? Math.round((total - first) / (files.length - 1)) : 0;
  console.log(`${provider.padEnd(4)} всего ${(total / 1000).toFixed(1)} с · первый кадр ${Math.round(first)} мс (включая старт модели) · дальше ${rest} мс/кадр · тайлов ${last?.tiles ?? 0}, покрытие ${((last?.coverage ?? 0) * 100).toFixed(1)}%, порог ${last?.threshold ?? "—"}`);
}
