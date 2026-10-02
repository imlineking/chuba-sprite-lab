// Repeatable P1 review of real assets. Originals stay outside Git and are never written.
// node scripts/review-cleanup-corpus.mjs <input-directory> <new-output-directory>
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { processImageBatch } from "../src/image-batch.mjs";

const root = path.resolve(import.meta.dirname, "..");
if (!process.argv[2] || !process.argv[3]) throw new Error("Укажите папку исходных PNG и новую папку отчёта.");
const input = path.resolve(process.argv[2]), output = path.resolve(process.argv[3]);
const mode = process.argv[4] || "auto";
if (!["auto", "confirmed", "toonout"].includes(mode)) throw new Error("Способ: auto, confirmed или toonout.");
const annotations = JSON.parse(await fs.readFile(path.join(root, "test/fixtures/cleanup-review-cases.json"), "utf8"));
assert.notEqual(input, output, "Отчёт должен находиться отдельно от исходников");
await fs.mkdir(output); // Refuse to mix a previous run with this run.
const selectedNames = process.argv[5] ? JSON.parse(process.argv[5]) : null;
const names = (await fs.readdir(input)).filter(name => /\.png$/i.test(name) && (!selectedNames || selectedNames.includes(name))).sort();
assert.ok(names.length && names.length <= 256, "Нужны 1–256 PNG");
const hash = async file => crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
const escaped = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const cases = [];
for (const [index, name] of names.entries()) {
  const file = path.join(input, name), beforeHash = await hash(file);
  const directory = path.join(output, String(index + 1).padStart(2, "0"));
  const start = performance.now();
  const palette = annotations.find(entry => entry.file === name)?.lightArtworkPolicy;
  if (mode === "confirmed" && !palette) throw new Error(`Нет подтверждённой палитры для ${name}`);
  const options = { keyMode: "auto", tolerance: 20, blackOutline: 3, batchBlackContour: "preserve",
    edgeRefine: { mode: "none", lightArtworkPolicy: "auto" } };
  if (mode === "confirmed") options.batchCleanupByIndex = { 0: { lightArtworkPolicy: palette } };
  if (["toonout"].includes(mode)) Object.assign(options, { keyMode: "ai", aiModel: mode,
    batchModelOverride: mode, aiProvider: "dml", aiQuality: "balanced", aiForceModel: true,
    edgeRefine: { mode: "none", lightArtworkPolicy: "protect" } });
  const batch = await processImageBatch({ paths: [file], outputDir: directory, appRoot: root,
    outputKind: "images", automatic: true, installed: ["toonout"],
    options });
  const ms = Math.round(performance.now() - start);
  assert.equal(await hash(file), beforeHash, `Изменён исходник ${name}`);
  assert.equal(batch.failed, 0, JSON.stringify(batch.failures));
  const result = batch.results[0];
  const [before, after] = await Promise.all([file, result.imagePath].map(p => sharp(p).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true })));
  assert.equal(after.info.width, before.info.width);
  assert.equal(after.info.height, before.info.height);
  let removed = 0, restored = 0, recolored = 0;
  for (let at = 0; at < before.data.length; at += 4) {
    if (before.data[at + 3] > 12 && after.data[at + 3] <= 12) removed++;
    if (before.data[at + 3] <= 12 && after.data[at + 3] > 12) restored++;
    if (before.data[at + 3] > 12 && after.data[at + 3] > 12 && [0, 1, 2].some(c => before.data[at + c] !== after.data[at + c])) recolored++;
  }
  const previews = [];
  for (const [title, color] of [["black", "#101010"], ["white", "#ffffff"], ["magenta", "#ed00a9"]]) {
    const images = [];
    for (const [label, source] of [["input", file], ["result", result.imagePath]]) {
      const preview = `${label}-${title}.png`;
      await sharp(source).flatten({ background: color }).resize({ width: 640, height: 460, fit: "inside", withoutEnlargement: true }).png().toFile(path.join(directory, preview));
      images.push(`${path.basename(directory)}/${preview}`);
    }
    previews.push({ title, images });
  }
  const item = { name, beforeHash, outputHash: await hash(result.imagePath), width: after.info.width,
    height: after.info.height, ms, removed, restored, recolored, changed: result.changeReport.changed,
    lightDecision: result.lightDecision, route: result.route, issues: result.qualityIssues,
    warnings: result.qualityWarnings, imagePath: result.imagePath, previews,
    reviewStatus: result.changeReport.changed === 0 ? "unchanged-review-required" : "visual-review-required" };
  cases.push(item);
  console.log(JSON.stringify({ name, ms, changed: item.changed, removed, recolored, policy: item.lightDecision.policy, issues: item.issues }));
}
const report = { generatedAt: new Date().toISOString(), mode, originalUnchanged: true, groundTruth: false,
  note: "Счётчики показывают изменения, а не точность маски. Без эталонных масок требуется визуальная приёмка. Нулевое изменение не считается успешной очисткой.", cases };
await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
await fs.writeFile(path.join(output, "review.html"), `<!doctype html><html lang="ru"><meta charset="utf-8"><title>P1 · Проверка очистки спрайтов</title><style>body{font:16px system-ui;margin:24px;background:#f1f1f1;color:#161616}section{background:white;padding:20px;margin:24px 0}details{margin:14px 0}summary{cursor:pointer}figure{margin:8px 0}img{max-width:49%;vertical-align:top;image-rendering:pixelated}p{line-height:1.5}code{overflow-wrap:anywhere}</style><h1>P1 · Реальные спрайты</h1><p>${escaped(report.note)} Исходники сохранены. Слева — вход, справа — результат.</p>${cases.map(item => `<section><h2>${escaped(item.name)}</h2><p>${item.width}×${item.height} · ${item.ms} мс · изменено ${item.changed} px · удалено ${item.removed} · восстановлено ${item.restored} · перекрашено ${item.recolored}</p><p>${escaped(item.route.join(" → "))} · светлые детали: ${escaped(item.lightDecision.policy)} (${escaped(item.lightDecision.confidence)})</p><p>${escaped(item.warnings.join(" ") || (item.changed === 0 ? "Без изменений: требуется решение по остатку фона." : "Требуется визуальная проверка контура и деталей."))}</p>${item.previews.map((p, index) => `<details ${index === 0 ? "open" : ""}><summary>Подложка: ${p.title}</summary><figure>${p.images.map(image => `<img src="${escaped(image)}" alt="${escaped(item.name)}">`).join("")}</figure></details>`).join("")}<a href="${path.basename(path.dirname(item.imagePath))}/${encodeURIComponent(path.basename(item.imagePath))}">Прозрачный PNG</a></section>`).join("")}</html>`);
