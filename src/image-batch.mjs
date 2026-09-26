import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { keyFrame, processSprites, supportedImageExtensions } from "./processor.mjs";
import { sliceSpriteSheet } from "./sheet-slicer.mjs";

export async function processImageBatch({ paths, outputDir, options = {}, splitObjects = true, appRoot, signal, onProgress, shouldStop }) {
  const inputs = [...new Set((paths || []).map(file => path.resolve(file)))];
  if (!inputs.length || inputs.length > 256) throw new Error("Выберите от 1 до 256 изображений.");
  if (!outputDir) throw new Error("Выберите папку результатов.");
  await fs.mkdir(outputDir, { recursive: true });
  const results = []; const failures = [];
  for (const [index, file] of inputs.entries()) {
    if (signal?.aborted) break;
    if (shouldStop?.()) break;
    const name = path.parse(file).name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/^\.+|\.+$/g, "").slice(0, 80) || `image-${index + 1}`;
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-image-batch-"));
    try {
      if (!supportedImageExtensions.has(path.extname(file).toLowerCase()) || !(await fs.stat(file)).isFile()) throw new Error("Не удалось прочитать изображение.");
      onProgress?.({ stage: "batch", value: index / inputs.length, message: `Изображение ${index + 1}/${inputs.length} · ${name}` });
      const keyed = await keyFrame(file, options.keyMode || "white", options.tolerance ?? 18, options.blackOutline, options.blackFeather, { ...options, appRoot, frameIndex: 0 });
      signal?.throwIfAborted();
      if (!keyed.bounds?.width || !keyed.bounds?.height) throw new Error("После удаления фона не осталось объектов. Измените профиль очистки.");
      const cleaned = path.join(workspace, "cleaned.png"); await fs.writeFile(cleaned, keyed.buffer);
      const sliced = splitObjects ? await sliceSpriteSheet(cleaned, path.join(workspace, "objects"), { mode: "objects", alphaOnly: true, attachFragments: true }) : null;
      let outputName = name; let version = 2;
      while (await fs.stat(path.join(outputDir, outputName)).then(() => true, () => false)) outputName = `${name}-${version++}`;
      const result = await processSprites({
        appRoot, outputDir, name: outputName, source: { kind: sliced ? "sheet" : "frames", paths: sliced?.framePaths || [cleaned], title: name }, signal,
        options: { ...options, keyMode: "alpha", fringeCleanup: false, edgeDecontaminate: false, aiEdits: [], removeDuplicates: false, outputBackground: "transparent", exports: { sheet: true, metadata: true, frames: false, preview: false } },
        onProgress: progress => onProgress?.({ ...progress, value: (index + progress.value) / inputs.length, message: `${index + 1}/${inputs.length} · ${name} · ${progress.message}` }),
      });
      results.push({ input: file, name, outputDir: result.outputDir, sheetPath: result.sheetPath, manifestPath: result.manifestPath, frameCount: result.frameCount, warnings: result.warnings, aiMetrics: keyed.aiMetrics || null });
    } catch (error) {
      if (signal?.aborted || error.name === "AbortError") break;
      failures.push({ input: file, name, message: error.message });
    } finally { await fs.rm(workspace, { recursive: true, force: true }); }
  }
  const summary = { batch: true, kind: "images", outputDir, total: inputs.length, completed: results.length, failed: failures.length, stopped: results.length + failures.length < inputs.length, cancelled: Boolean(signal?.aborted), results, failures, revealPath: results[0]?.sheetPath || outputDir };
  let reportPath = path.join(outputDir, "image-batch-report.json"); let version = 2;
  while (await fs.stat(reportPath).then(() => true, () => false)) reportPath = path.join(outputDir, `image-batch-report-${version++}.json`);
  await fs.writeFile(reportPath, JSON.stringify({ ...summary, profile: options, splitObjects }, null, 2));
  return { ...summary, reportPath };
}
