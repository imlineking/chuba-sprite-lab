import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { keyFrame, processFramePreview, processSprites, supportedImageExtensions } from "./processor.mjs";
import { sliceSpriteSheet } from "./sheet-slicer.mjs";
import { hasConfirmedChecker, hasPreparedAlpha, measureSource, planAutoPilot } from "./auto-pilot.mjs";
import { findWhiteRemainders } from "./white-remainders.mjs";
import { healImage } from "./healing-bridge.mjs";
import { reviewMatteFile } from "./matte-review.mjs";
import { chooseLightArtworkPolicy } from "./light-artwork-policy.mjs";
import { backgroundKeyMode } from "./background-analysis.mjs";

const solidBackgroundModes = new Set(["white", "black", "green", "magenta", "blue"]);
const backgroundNames = { white: "белый", black: "чёрный", green: "зелёный", magenta: "маджента", blue: "синий", auto: "подбор цвета" };

function detectedSolidMode(measurements) {
  if (!measurements?.solidBackground || Number(measurements.borderSolidRatio) < .92) return null;
  return backgroundKeyMode({ solid: true, transparentRatio: 0, colour: measurements.borderColour });
}

async function compareImagePixels(beforePath, afterPath) {
  const [before, after] = await Promise.all([beforePath, afterPath].map(file => sharp(file).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true })));
  if (before.info.width !== after.info.width || before.info.height !== after.info.height) return { changed: null, resized: true };
  let changed = 0;
  for (let offset = 0; offset < before.data.length; offset += 4) {
    if (before.data[offset + 3] !== after.data[offset + 3]
      || (after.data[offset + 3] && (before.data[offset] !== after.data[offset]
        || before.data[offset + 1] !== after.data[offset + 1] || before.data[offset + 2] !== after.data[offset + 2]))) changed += 1;
  }
  return { changed, resized: false };
}

export async function inspectCleanupQuality(preview, measurements, lightDecision, changeReport) {
  const issues=[];
  let white=preview.whiteRemainders;
  if(!white?.count && measurements?.borderColour?.every(value=>value>=230)) {
    const raw=await sharp(preview.afterPath).toColourspace('srgb').ensureAlpha().raw().toBuffer({resolveWithObject:true});
    white=findWhiteRemainders(raw.data,raw.info,measurements.borderColour);
  }
  if(white?.count && !(lightDecision?.policy === 'protect' && lightDecision.confidence === 'high')) issues.push({code:'white-regions-to-review',count:white.count,message:`Светлые области: ${white.count}. Это могут быть детали рисунка или остатки фона; проверьте просветы на цветной подложке.`});
  // ToonOut may replace the checker step entirely. Validate the result against
  // the input measurements, rather than the name of the selected stage.
  const preparedAlpha = hasPreparedAlpha(measurements);
  if(hasConfirmedChecker(measurements,{preparedAlpha})) {
    const remaining=await measureSource([preview.afterPath]);
    const remainingPrepared = hasPreparedAlpha(remaining);
    if(hasConfirmedChecker(remaining,{preparedAlpha:remainingPrepared})) issues.push({code:'residual-checker',pixels:Math.round(remaining.checkerPixels),message:`Обнаружены области, похожие на остатки клетки (${Math.round(remaining.checkerPixels)} пикселей). Проверьте их на цветной подложке; детали рисунка могут выглядеть похоже.`});
  }
  // Small pale candidates may be below the threshold for destructive grid
  // removal. Keeping them is reasonable; silently accepting a no-op is not.
  if (changeReport?.changed === 0 && preparedAlpha && measurements?.edgeMeasurement === "native"
    && measurements.checkerPixels >= Math.max(30, measurements.width * measurements.height * .005)
    && !issues.some(issue => issue.code === "residual-checker")) {
    issues.push({ code: "unchanged-pale-regions", pixels: Math.round(measurements.checkerPixels),
      message: "Файл не изменён: остались спорные светлые области. Если в рисунке нет белого и серого, выберите «Белого нет — убрать светлые остатки»; иначе сравните другой способ вырезки и защитите светлые детали." });
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

export async function processImageBatch({ paths, outputDir, options = {}, splitObjects = true, outputKind = "atlas", automatic = false, healFirst = false, installed = [], sourceIndexes = [], appRoot, signal, onProgress, shouldStop, previewFrame = processFramePreview }) {
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
        const lightRequest = options.edgeRefine?.noLightArtwork ? "none" : options.edgeRefine?.lightArtworkPolicy || "protect";
        let lightDecision = chooseLightArtworkPolicy(null, lightRequest);
        if (healing && (!settings.edgeRefine || settings.edgeRefine.mode === "none")) {
          // Repaint a confirmed pale fringe on dark/coloured sprites. Cream
          // petals and mushroom spots are material, so their boundary stays
          // untouched until the user explicitly chooses an edge policy.
          if (!healing.report.lightDetailGuard?.enabled) settings.edgeRefine = { mode: "recolor", width: 1, depth: 2, whiteOnly: true };
        }
        let plan = null;
        let measurements=null;
        let forcedBackground = null;
        if (!automatic && solidBackgroundModes.has(options.batchBackgroundMode)) {
          settings = { ...settings, keyMode: options.batchBackgroundMode, keyScope: "exterior",
            blackOutline: options.batchBackgroundMode === "black" && options.batchBlackContour === "remove" ? 0 : (Number(settings.blackOutline) || 3),
            edgeDecontaminate: options.batchBackgroundMode !== "black" };
        }
        if (automatic) {
          measurements = await measureSource([inputPath]);
          lightDecision = chooseLightArtworkPolicy(measurements, lightRequest);
          // The repaired alpha is the baseline. Do not replace it with a new
          // whole-object ToonOut mask during the specialist cleanup pass.
          const available = healing ? installed.filter(id => id !== "toonout") : installed;
          plan = planAutoPilot({ measurements, installed: available, source: { kind: "images", frameCount: 1 }, target: { intent: "images", cleanupRequested: true } });
          const explicitChoice = Object.hasOwn(options, "batchModelOverride");
          forcedBackground = solidBackgroundModes.has(options.batchBackgroundMode) ? options.batchBackgroundMode : null;
          const requestedModel = healing || forcedBackground ? null : explicitChoice ? options.batchModelOverride : options.keyMode === "ai" ? options.aiModel : null;
          const matting = plan.steps.find(step => step.stage === "matting");
          if (forcedBackground) {
            settings = { ...settings, keyMode: forcedBackground, keyScope: "exterior", aiForceModel: false };
            plan = { ...plan, steps: [
              { stage: "key", kind: "builtin", tool: forcedBackground, title: `Удалить ${forcedBackground} фон`, why: "Цвет фона выбран пользователем.", confidence: "high", status: "ready" },
              ...plan.steps.filter(step => !["matting", "key", "checker"].includes(step.stage)),
            ] };
          } else if (requestedModel) {
            if (!installed.includes(requestedModel)) throw new Error(`Выбранная модель ${requestedModel} не установлена. Выберите другую модель или автовыбор.`);
            // A model selected by the user must not disappear behind the automatic
            // alpha shortcut, even when the source is already partly transparent.
            settings = { ...settings, keyMode: "ai", aiModel: requestedModel, aiForceModel: true };
            plan = { ...plan, steps: [
              { stage: "matting", kind: "model", modelId: requestedModel, title: `Выделение · ${requestedModel}`, why: "Модель выбрана пользователем.", confidence: "high", status: "ready" },
              ...plan.steps.filter(step => !["matting", "key", "checker"].includes(step.stage)),
            ], settings: { ...plan.settings, modelId: requestedModel, provider: settings.aiProvider, quality: settings.aiQuality },
            summary: `Выбрана модель ${requestedModel}. Сравните контур и белые детали перед применением.` };
          } else {
            if (matting?.status === "blocked") throw new Error(`Нужна локальная модель ${matting.modelId}. Откройте каталог моделей.`);
            const keyStep = plan.steps.find(step => step.stage === "key");
            const solidMode = keyStep?.tool === "key" ? detectedSolidMode(measurements) : null;
            settings = { ...settings, keyMode: matting ? "ai" : keyStep?.tool === "alpha" ? "alpha" : solidMode || "auto",
              keyScope: solidMode ? "exterior" : settings.keyScope,
              aiModel: matting?.modelId || settings.aiModel, aiQuality: plan.settings.quality, aiForceModel: Boolean(matting) };
          }
          if (settings.keyMode === "black") settings.blackOutline = options.batchBlackContour === "remove" ? 0 : (Number(settings.blackOutline) || 3);
          if (solidBackgroundModes.has(settings.keyMode) && settings.keyMode !== "black") settings.edgeDecontaminate = true;
          // An already transparent sprite can still contain pale holes and a
          // light fringe. The planner's fringe stage must actually run.
          if (!healing && measurements.hasTransparency && plan.steps.some(step => step.stage === "fringe")
            && (!settings.edgeRefine || settings.edgeRefine.mode === "none")) {
            settings.edgeRefine = { mode: "recolor", width: 2, depth: 3, whiteOnly: true,
              whiteThreshold: 175, neutralTolerance: 45, autoPaleCleanup: true };
          }
          if (!requestedModel && lightDecision.policy !== "none" && plan.steps.some(step => step.stage === "checker")) settings.aiEdits = [...(settings.aiEdits || []), { type: "checker", frameIndex: sourceIndex }];
        }
        if (lightDecision.policy === "none") {
          // An explicit palette choice wins over the planner's conservative
          // pale-detail guard, including when Podorozhnik ran first.
          settings.edgeRefine = { mode: "none", width: 1, depth: 2, whiteOnly: true,
            ...settings.edgeRefine, mode: "none", noLightArtwork: true, autoPaleCleanup: false };
          settings.aiEdits = (settings.aiEdits || []).filter(edit => edit.type !== "checker" || edit.frameIndex !== sourceIndex);
          // On a partly transparent sprite this is a residual-cleanup task.
          // Keep the existing silhouette unless the user selected a model.
          if (automatic && measurements?.hasTransparency && !options.batchModelOverride && !forcedBackground && !healing) {
            settings.keyMode = "alpha";
            settings.aiForceModel = false;
            plan = { ...plan, steps: plan.steps.filter(step => step.stage !== "matting" && step.stage !== "checker"),
              summary: "Сохраняем существующий контур и удаляем светлые остатки по выбранной палитре." };
          }
        }
        signal?.throwIfAborted();
        const { result: preview, fallback } = await previewWithModelFallback({ inputPath, options: settings, appRoot, automatic, installed, signal, preview: previewFrame });
        signal?.throwIfAborted();
        if (!preview.bounds?.width || !preview.bounds?.height) throw new Error("После очистки не осталось объекта. Попробуйте другой профиль или защитите детали маской.");
        const changeReport = await compareImagePixels(file, preview.afterPath);
        const qualityIssues=await inspectCleanupQuality(preview,measurements,lightDecision,changeReport);
        const qualityWarnings=qualityIssues.map(issue=>issue.message);
        const matteReview=await reviewMatteFile(preview.afterPath);
        if (automatic && changeReport.changed === 0 && qualityIssues.length) qualityWarnings.push("Автоматическая очистка не изменила этот файл; проверьте отмеченные области.");
        if (automatic && changeReport.changed === 0 && settings.keyMode === "ai" && settings.aiForceModel) qualityWarnings.push("Результат выбранной модели совпадает с исходником; проверьте фон или попробуйте другой способ.");
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
        const route = [
          ...(healing ? ["Восстановление"] : []),
          settings.keyMode === "ai" ? `Выделение · ${settings.aiModel}` : settings.keyMode === "alpha" ? "Сохранена прозрачность" : settings.keyMode === "black" ? `Чёрный фон · ${settings.blackOutline ? "контур сохранён" : "без сохранения контура"}` : `Очистка фона · ${backgroundNames[settings.keyMode] || settings.keyMode}`,
          ...((settings.aiEdits || []).some(edit => edit.type === "checker" && edit.frameIndex === sourceIndex) ? ["Удаление шахматки"] : []),
          ...(preview.edgeRefineReport?.removed || preview.edgeRefineReport?.recolored ? [settings.edgeRefine?.noLightArtwork ? "Очистка светлых остатков и края" : "Очистка края"] : []),
          "Проверка результата",
        ];
        results.push({ input: file, name, outputDir, imagePath, sheetPath: imagePath, frameCount: 1, bounds: preview.bounds, plan, route, fallback, qualityIssues, qualityWarnings, matteReview, healingPath, healingReport: healing?.report || null, cleanupReport: preview.edgeRefineReport || null, lightDecision, changeReport });
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
