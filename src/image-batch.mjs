import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { keyFrame, processFramePreview, processSprites, supportedImageExtensions } from "./processor.mjs";
import { sliceSpriteSheet } from "./sheet-slicer.mjs";
import { measureSource, planAutoPilot } from "./auto-pilot.mjs";

export async function previewWithModelFallback({ inputPath, options, appRoot, automatic, installed = [], signal, preview = processFramePreview }) {
  try { return { result: await preview({ inputPath, options, appRoot }), fallback: null }; }
  catch (error) {
    if (!automatic || options.keyMode !== "ai" || signal?.aborted || !/Dml|out of memory|8007000E|allocation|memory|device|execution provider/i.test(error.message)) throw error;
    const models = [options.aiModel, ...["birefnet-tiny", "isnet-general", "u2netp"].filter(id => installed.includes(id) && id !== options.aiModel)];
    let lastError = error;
    for (const model of models) {
      signal?.throwIfAborted();
      try {
        const settings = { ...options, aiProvider: "cpu", aiModel: model, aiQuality: model === "u2netp" ? "fast" : "balanced" };
        return { result: await preview({ inputPath, options: settings, appRoot }), fallback: { reason: error.message, provider: "cpu", model, quality: settings.aiQuality } };
      } catch (failure) {
        lastError = failure;
        if (signal?.aborted || !/Dml|out of memory|8007000E|allocation|memory|device|execution provider/i.test(failure.message)) throw failure;
      }
    }
    throw lastError;
  }
}

export async function processImageBatch({ paths, outputDir, options = {}, splitObjects = true, outputKind = "atlas", automatic = false, installed = [], sourceIndexes = [], appRoot, signal, onProgress, shouldStop }) {
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
      if (outputKind === "images") {
        const sourceIndex = sourceIndexes[index] ?? index;
        const inputPath = options.frameOverrides?.[sourceIndex] || file;
        let settings = { ...options, previewFrameIndex: sourceIndex, outputBackground: "transparent" };
        let plan = null;
        if (automatic) {
          const measurements = await measureSource([inputPath]);
          plan = planAutoPilot({ measurements, installed, source: { kind: "images", frameCount: 1 }, target: { intent: "images", cleanupRequested: true } });
          const matting = plan.steps.find(step => step.stage === "matting");
          if (matting?.status === "blocked") throw new Error(`Нужна локальная модель ${matting.modelId}. Откройте каталог моделей.`);
          settings = { ...settings, keyMode: matting ? "ai" : plan.steps.find(step => step.stage === "key")?.tool === "alpha" ? "alpha" : "auto", aiModel: matting?.modelId || settings.aiModel, aiQuality: plan.settings.quality, aiForceModel: Boolean(matting) };
          if (plan.steps.some(step => step.stage === "checker")) settings.aiEdits = [...(settings.aiEdits || []), { type: "checker", frameIndex: sourceIndex }];
        }
        signal?.throwIfAborted();
        const { result: preview, fallback } = await previewWithModelFallback({ inputPath, options: settings, appRoot, automatic, installed, signal });
        signal?.throwIfAborted();
        let imagePath = path.join(outputDir, `${name}.png`), version = 2;
        // Exclusive copy prevents overwriting sources or previous results, even on collision.
        for (;;) {
          try { await fs.copyFile(preview.afterPath, imagePath, 1); break; }
          catch (error) { if (error.code !== "EEXIST") throw error; imagePath = path.join(outputDir, `${name}-${version++}.png`); }
        }
        results.push({ input: file, name, outputDir, imagePath, sheetPath: imagePath, frameCount: 1, bounds: preview.bounds, plan, fallback });
        onProgress?.({ stage: "batch", value: (index + 1) / inputs.length, message: `Сохранено ${index + 1}/${inputs.length} · ${name}.png` });
        continue;
      }
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
  await fs.writeFile(reportPath, JSON.stringify({ ...summary, profile: options, splitObjects, outputKind, automatic }, null, 2));
  return { ...summary, outputKind, automatic, reportPath };
}
