import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { keyFrame, processFramePreview, processSprites, supportedImageExtensions } from "./processor.mjs";
import { sliceSpriteSheet } from "./sheet-slicer.mjs";
import { measureSource, planAutoPilot } from "./auto-pilot.mjs";
import { findWhiteRemainders } from "./white-remainders.mjs";
import { healImage } from "./healing-bridge.mjs";

export async function inspectCleanupQuality(preview, measurements) {
  const issues=[];
  let white=preview.whiteRemainders;
  if(!white?.count && measurements?.borderColour?.every(value=>value>=230)) {
    const raw=await sharp(preview.afterPath).toColourspace('srgb').ensureAlpha().raw().toBuffer({resolveWithObject:true});
    white=findWhiteRemainders(raw.data,raw.info,measurements.borderColour);
  }
  if(white?.count) issues.push({code:'white-regions-to-review',count:white.count,message:`Светлые области: ${white.count}. Это могут быть детали рисунка или остатки фона; проверьте просветы на цветной подложке.`});
  // ToonOut may replace the checker step entirely. Validate the result against
  // the input measurements, rather than the name of the selected stage.
  if(measurements?.checkerPixels>=64) {
    const remaining=await measureSource([preview.afterPath]);
    if(remaining?.checkerPixels>=64) issues.push({code:'residual-checker',pixels:Math.round(remaining.checkerPixels),message:`Обнаружены области, похожие на остатки клетки (${Math.round(remaining.checkerPixels)} пикселей). Проверьте их на цветной подложке; детали рисунка могут выглядеть похоже.`});
  }
  return issues;
}

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

export async function processImageBatch({ paths, outputDir, options = {}, splitObjects = true, outputKind = "atlas", automatic = false, healFirst = false, installed = [], sourceIndexes = [], appRoot, signal, onProgress, shouldStop }) {
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
        let inputPath = options.frameOverrides?.[sourceIndex] || file;
        let healing = null;
        if (healFirst) {
          onProgress?.({ stage: "healing", value: index / inputs.length, message: `Подорожник · ${index + 1}/${inputs.length} · восстанавливаю ${name}` });
          healing = await healImage(inputPath, path.join(workspace, "healing"), { signal });
          inputPath = healing.imagePath;
        }
        let settings = { ...options, previewFrameIndex: sourceIndex, outputBackground: "transparent" };
        if (healing && (!settings.edgeRefine || settings.edgeRefine.mode === "none")) {
          // Repaint a confirmed pale fringe on dark/coloured sprites. Cream
          // petals and mushroom spots are material, so their boundary stays
          // untouched until the user explicitly chooses an edge policy.
          if (!healing.report.lightDetailGuard?.enabled) settings.edgeRefine = { mode: "recolor", width: 1, depth: 2, whiteOnly: true };
        }
        let plan = null;
        let measurements=null;
        if (automatic) {
          measurements = await measureSource([inputPath]);
          // The repaired alpha is the baseline. Do not replace it with a new
          // whole-object ToonOut mask during the specialist cleanup pass.
          const available = healing ? installed.filter(id => id !== "toonout") : installed;
          plan = planAutoPilot({ measurements, installed: available, source: { kind: "images", frameCount: 1 }, target: { intent: "images", cleanupRequested: true } });
          const matting = plan.steps.find(step => step.stage === "matting");
          if (matting?.status === "blocked") throw new Error(`Нужна локальная модель ${matting.modelId}. Откройте каталог моделей.`);
          settings = { ...settings, keyMode: matting ? "ai" : plan.steps.find(step => step.stage === "key")?.tool === "alpha" ? "alpha" : "auto", aiModel: matting?.modelId || settings.aiModel, aiQuality: plan.settings.quality, aiForceModel: Boolean(matting) };
          if (plan.steps.some(step => step.stage === "checker")) settings.aiEdits = [...(settings.aiEdits || []), { type: "checker", frameIndex: sourceIndex }];
        }
        signal?.throwIfAborted();
        const { result: preview, fallback } = await previewWithModelFallback({ inputPath, options: settings, appRoot, automatic, installed, signal });
        signal?.throwIfAborted();
        if (!preview.bounds?.width || !preview.bounds?.height) throw new Error("После очистки не осталось объекта. Попробуйте другой профиль или защитите детали маской.");
        const qualityIssues=await inspectCleanupQuality(preview,measurements);
        const qualityWarnings=qualityIssues.map(issue=>issue.message);
        if (healing?.report.lightDetailGuard?.enabled && (!settings.edgeRefine || settings.edgeRefine.mode === "none")) qualityWarnings.push("Светлые детали защищены: перекраска кромки оставлена для ручной проверки.");
        let imagePath = path.join(outputDir, `${name}.png`), version = 2;
        // Exclusive copy prevents overwriting sources or previous results, even on collision.
        for (;;) {
          try { await fs.copyFile(preview.afterPath, imagePath, 1); break; }
          catch (error) { if (error.code !== "EEXIST") throw error; imagePath = path.join(outputDir, `${name}-${version++}.png`); }
        }
        let healingPath = null;
        if (healing) {
          healingPath = path.join(outputDir, `${name}-healed.png`);
          let healingVersion = 2;
          for (;;) {
            try { await fs.copyFile(healing.imagePath, healingPath, 1); break; }
            catch (error) { if (error.code !== "EEXIST") throw error; healingPath = path.join(outputDir, `${name}-healed-${healingVersion++}.png`); }
          }
        }
        results.push({ input: file, name, outputDir, imagePath, sheetPath: imagePath, frameCount: 1, bounds: preview.bounds, plan, fallback, qualityIssues, qualityWarnings, healingPath, healingReport: healing?.report || null });
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
  await fs.writeFile(reportPath, JSON.stringify({ ...summary, profile: options, splitObjects, outputKind, automatic, healFirst }, null, 2));
  return { ...summary, outputKind, automatic, reportPath };
}
