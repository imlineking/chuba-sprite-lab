// Independent images keep their original canvas. No slicing, rescaling or timeline.
window.startImageEditing = function startImageEditing() {
  if (state.source?.kind !== "frames") return false;
  state.intent = "images"; document.body.dataset.intent = "images";
  $("#sourceBadge").textContent = "PNG";
  $("#sourceTitle").textContent = state.source.title.replace(/кадров/g, "изображений");
  // Do not carry an animation's resize/style settings into a plain cleanup task.
  if (state.result?.imageWorkspace) return true;
  const paths = state.source.paths;
  const urls = paths.map(file => "file:///" + file.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/"));
  state.result = { imageWorkspace: true, frameCount: paths.length, allSourceFramePaths: [...paths], allSourceFrameUrls: urls, sourceFrameIndexes: paths.map((_, i) => i), frameUrls: urls, copyableFrameIndexes: [], skipped: {}, warnings: [], frameIssues: [], atlasIssues: [] };
  state.timeline = null;
  state.warnings = []; showWarnings([], []);
  buildFilmstrip(state.result);
  $$("#filmstrip button").forEach((button, index) => { button.draggable = false; button.title = baseName(paths[index]); });
  $("#filmstripNote").textContent = `${paths.length} отдельных изображений · выберите файл для правки`;
  $("#metaFrames").textContent = String(paths.length);
  $("#metaCell").textContent = "Исходный размер"; $("#metaGrid").textContent = "—";
  $("#metaAnchor").textContent = "Без смещения"; $("#metaAtlas").textContent = "Отдельные PNG";
  state.selectedFrameIndex = Math.min(state.selectedFrameIndex, paths.length - 1);
  setPreviewMode("after"); updateActionState();
  scheduleFramePreview(0);
  return true;
};

window.saveIndependentImages = async function saveIndependentImages({ all = false, automatic = false } = {}) {
  if (state.source?.kind !== "frames" || state.busy) return null;
  if (automatic) { window.openImageBatchPreview(); return null; }
  const sourceIndexes = all ? state.source.paths.map((_, i) => i) : [state.selectedFrameIndex];
  const paths = sourceIndexes.map(i => state.source.paths[i]);
  state.busy = true; updateActionState();
  try {
    const outputDir = state.outputFolder || await window.spriteLab.automaticOutput(paths[0]);
    state.outputFolder = outputDir; $("#outputFolder").textContent = outputDir;
    $("#cancelJob").classList.remove("hidden");
    setStatus(`Сохраняю ${paths.length} PNG в исходном размере…`, "busy", .02);
    const result = await window.spriteLab.imageBatch({ paths, sourceIndexes, outputDir, outputKind: "images", automatic, options: collectOptions() });
    state.lastExportDir = outputDir; state.lastRevealPath = result.revealPath;
    if (result.failed) showError(result.failures.map(item => `${item.name}: ${item.message}`).join("\n"));
    else hideError();
    setStatus(`Сохранено PNG: ${result.completed}/${result.total}${result.cancelled ? " · отменено" : ""}${result.failed ? ` · ошибок: ${result.failed}` : ""}`, result.failed ? "error" : "done", 1);
    for (const item of result.results) {
      const index = state.source.paths.indexOf(item.input);
      if (index >= 0) $("#filmstrip button[data-source-index='" + index + "'] img").src = "file:///" + item.imagePath.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/");
    }
    return result;
  } catch (error) { showError(error.message); setStatus(error.message, "error", 0); return null; }
  finally { state.busy = false; updateActionState(); $("#cancelJob").classList.add("hidden"); scheduleFramePreview(0); }
};

$("#regionEditImage").addEventListener("click", () => openMaskEditor({ tool: "select" }).catch(error => showError(error.message)));
$("#saveImagePng").addEventListener("click", () => window.saveIndependentImages());
$("#saveAllImagePng").addEventListener("click", () => window.saveIndependentImages({ all: true }));
$("#imageAutoCleanup").addEventListener("click", () => window.openImageBatchPreview());
$("#imageHealBatch").addEventListener("click", () => window.openImageBatchPreview({ healFirst: true, automatic: true }));
$("#imageScenarioChoices").addEventListener("click", event => {
  const button = event.target.closest("button[data-image-task]");
  if (!button) return;
  if (button.dataset.imageTask === "pixels") { window.startImageEditing(); setTab("process"); $("#openPixelEditor").click(); return; }
  if (button.dataset.imageTask === "background") { window.openImageBatchPreview(); return; }
  if (button.dataset.imageTask === "healing") { window.openImageBatchPreview({ healFirst: true, automatic: true }); return; }
  window.taskChoose(button.dataset.imageTask, "manual");
});
// History belongs beside Apply/Cancel and must stay visible when tools scroll.
const maskHistoryButtons = $(".mask-history-actions");
$(".mask-editor-footer").insertBefore(maskHistoryButtons, $(".mask-editor-footer").firstChild);
const checkerButton = $("#removeCheckerboard");
$(".mask-tools").insertBefore(checkerButton, $(".mask-tools").firstChild);

let imageBatchDraft = null;

function batchAssemblySignature() {
  return JSON.stringify({ indexes: imageBatchIndexes(), paths: imageBatchIndexes().map(i => imageBatchDraft.results[i]?.imagePath), output: imageBatchDraft.outputKind, scale: imageBatchDraft.pixelScale || 1, background: imageBatchDraft.atlasBackground, backgroundColor: imageBatchDraft.atlasBackgroundColor, layout: collectOptions() });
}

function batchAssemblyRequest(previewOnly, outputDir) {
  const indexes = imageBatchIndexes(), paths = indexes.map(i => imageBatchDraft.results[i].imagePath);
  const atlas = imageBatchDraft.outputKind === "atlas", options = collectOptions();
  return { source: { kind: "frames", paths, title: "Обработанные спрайты", maskPrepared: true }, name: $("#spriteName").value || "sprites", previewOnly, outputDir,
    options: { ...options, maxFrames: indexes.length, frameMetadata: Object.fromEntries(indexes.map((src, i) => [i, state.frameMetadata[src] || {}])), anchorReference: Math.max(0, indexes.indexOf(state.anchorReference)), keyMode: "alpha", frameOverrides: {}, preparedCleanup: {}, aiEdits: [], edgeRefine: { mode: "none" }, fringeCleanup: false, edgeDecontaminate: false, attachments: [], frameTransforms: {}, pixelate: null, toning: null, imageGeometry: null, preserveFrameCanvas: true, atlasBackground: imageBatchDraft.atlasBackground || "transparent", atlasBackgroundColor: imageBatchDraft.atlasBackgroundColor || "#ff00ff", pixelScale: imageBatchDraft.pixelScale || 1, packing: atlas ? "maxrects" : "grid", atlasExtrude: atlas ? Number($("#atlasExtrude").value) : 0, atlasRotate: atlas && $("#atlasRotate").checked, atlasOverflow: "split", removeDuplicates: false, excludedFrames: [], auxAI: {}, outputBackground: "transparent", timeline: indexes.map((src, i) => ({ src: i, durationMs: state.timeline?.find(e => e.src === src)?.d })), exports: { sheet: true, metadata: true, frames: false, preview: false } } };
}

async function prepareBatchAssembly() {
  state.busy = true; renderImageBatchDraft(); updateActionState();
  try {
    if (imageBatchDraft.results.length > 1000) throw new Error("Для одной сборки выберите не больше 1000 файлов.");
    const signature = batchAssemblySignature();
    const result = await window.spriteLab.build(batchAssemblyRequest(true));
    imageBatchDraft.assembly = { signature, result };
    $("#imageBatchAfter").src = result.sheetUrl;
    $("#imageBatchSummary").textContent = `Готов ${imageBatchDraft.outputKind === "atlas" ? "атлас" : "лист"} · ${result.sheetPaths.length} страниц · ${result.cellWidth}×${result.cellHeight} кадр`;
  } catch (error) { showError(error.message); }
  finally { state.busy = false; updateActionState(); renderImageBatchDraft(); persistImageBatchDraft(); }
}

async function saveBatchAssembly() {
  if (imageBatchDraft.assembly?.signature !== batchAssemblySignature()) return;
  const outputDir = state.outputFolder || await window.spriteLab.automaticOutput(imageBatchDraft.paths[0]);
  state.busy = true; renderImageBatchDraft(); updateActionState();
  try {
    const result = await window.spriteLab.build(batchAssemblyRequest(false, outputDir));
    state.lastExportDir = result.outputDir; state.lastRevealPath = result.sheetPath; state.outputFolder = outputDir;
    $("#exportSummary").textContent = `Сохранены PNG + JSON: ${result.sheetPaths.length} страниц · ${result.outputDir}`;
    $("#exportSummary").classList.remove("hidden"); $("#completionActions").classList.remove("hidden");
    setStatus("Лист и JSON сохранены · исходники сохранены", "done", 1);
    state.busy = false; window.closeImageBatchPreview();
  } catch (error) { showError(error.message); }
  finally { state.busy = false; updateActionState(); renderImageBatchDraft(); }
}

for (const id of ["imageBatchOutput", "imageBatchScale", "imageBatchAtlasBackground", "imageBatchAtlasColor"]) $("#" + id).addEventListener("change", () => {
  imageBatchDraft.outputKind = $("#imageBatchOutput").value;
  imageBatchDraft.pixelScale = Number($("#imageBatchScale").value);
  imageBatchDraft.atlasBackground = $("#imageBatchAtlasBackground").value;
  imageBatchDraft.atlasBackgroundColor = $("#imageBatchAtlasColor").value;
  delete imageBatchDraft.assembly; persistImageBatchDraft(); renderImageBatchDraft();
  $("#applyImageBatch").textContent = imageBatchDraft.outputKind === "png" ? "Применить выбранные" : "Сохранить лист и JSON";
});
let imageBatchReturnFocus = null;
let imageBatchReviewIndex = 0;
const imageBatchUrl = file => "file:///" + file.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/");
function persistImageBatchDraft() {
  const references = [imageBatchDraft?.directory, ...(state.source?.paths || []), ...state.history.flatMap(h => h.source?.paths || []), ...state.animations.flatMap(a => a.source?.paths || []), ...Object.values(imageBatchDraft?.results || {}).map(r => r.imagePath), ...Object.values(state.frameOverrides || {}), ...state.history.flatMap(h => Object.values(h.frameOverrides || {}))].filter(Boolean);
  window.spriteLab.retainPreviews?.(references).catch(() => {});
  try { localStorage.setItem("spriteLab.pendingImageBatch", JSON.stringify(imageBatchDraft)); } catch { /* UI still keeps the preview. */ }
}
function imageBatchIndexes() {
  const scope = $("#imageBatchScope").value;
  if (scope === "current") return [Math.min(imageBatchReviewIndex, imageBatchDraft.paths.length - 1)];
  return imageBatchDraft.paths.map((_, index) => index).filter(index => scope === "all" || imageBatchDraft.selected.includes(index));
}
function showImageBatchPair(index) {
  imageBatchReviewIndex = index;
  $("#imageBatchBefore").src = imageBatchUrl(imageBatchDraft.paths[index]);
  const item = imageBatchDraft.results[index];
  if (item) $("#imageBatchAfter").src = imageBatchUrl(item.imagePath);
  else $("#imageBatchAfter").removeAttribute("src");
  if (item?.healingPath) $("#imageBatchHealing").src = imageBatchUrl(item.healingPath);
  else $("#imageBatchHealing").removeAttribute("src");
  renderImageBatchMatteReview();
  window.renderBatchCleanupSuggestion?.();
}
function renderImageBatchMatteReview() {
  const review = imageBatchDraft?.results[imageBatchReviewIndex]?.matteReview;
  const scale = $("#imageBatchReviewScale").value;
  const before = $("#imageBatchBefore"), after = $("#imageBatchAfter");
  const beforeCanvas = $("#imageBatchBeforeGamePreview"), afterCanvas = $("#imageBatchGamePreview");
  const showGameSize = scale !== "original" && Boolean(review);
  before.classList.toggle("hidden", showGameSize && before.complete && Boolean(before.naturalWidth));
  after.classList.toggle("hidden", showGameSize && after.complete && Boolean(after.naturalWidth));
  beforeCanvas.classList.add("hidden"); afterCanvas.classList.add("hidden");
  if (!review) { $("#imageBatchMatteSummary").textContent = "Выберите подготовленный файл."; return; }
  const notes = [`RGBA ${review.width} × ${review.height}`, `${review.partial.toLocaleString("ru-RU")} пикс. с частичной прозрачностью`];
  if (review.palePartial) notes.push(`${review.palePartial.toLocaleString("ru-RU")} светлых на полупрозрачной кромке — проверьте, это могут быть детали`);
  if (review.innerPartial) notes.push(`${review.innerPartial.toLocaleString("ru-RU")} частично прозрачных внутри объекта`);
  if (review.touchesCanvas) notes.push("объект касается края холста — проверьте обрезание");
  if (review.contentFraction < 25) notes.push(`объект занимает ${review.contentFraction}% холста — перед упаковкой проверьте лишние поля`);
  $("#imageBatchMatteSummary").textContent = `${notes.join(" · ")}. Жёсткую альфу применяйте только для пиксельной графики после просмотра.`;
  if (!showGameSize) return;
  const [widthText, zoomText] = scale.split("-");
  const targetWidth = widthText === "zoom" ? review.width : Number(widthText);
  const zoom = widthText === "zoom" ? Number(zoomText) : zoomText === "2" ? 2 : 1;
  for (const [image, canvas] of [[before, beforeCanvas], [after, afterCanvas]]) {
    if (!image.complete || !image.naturalWidth) continue;
    const targetHeight = Math.max(1, Math.round(targetWidth * image.naturalHeight / image.naturalWidth));
    canvas.width = targetWidth; canvas.height = targetHeight;
    canvas.style.width = `${targetWidth * zoom}px`; canvas.style.height = `${targetHeight * zoom}px`;
    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, targetWidth, targetHeight);
    context.drawImage(image, 0, 0, targetWidth, targetHeight);
    canvas.classList.remove("hidden");
  }
}
$("#imageBatchBefore").addEventListener("load", renderImageBatchMatteReview);
$("#imageBatchAfter").addEventListener("load", renderImageBatchMatteReview);
$("#imageBatchReviewScale").addEventListener("change", renderImageBatchMatteReview);
$("#imageBatchReviewBackdrop").addEventListener("change", event => {
  $("#imageBatchComparison").dataset.reviewBackground = event.target.value;
});
function renderImageBatchDraft() {
  const scope = imageBatchIndexes();
  const list = $("#imageBatchList"); list.replaceChildren();
  imageBatchDraft.paths.forEach((file, index) => {
    const row = document.createElement("div"); row.className = "batch-preview-row";
    const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = scope.includes(index); checkbox.disabled = state.busy;
    checkbox.setAttribute("aria-label", `Выбрать ${baseName(file)}`);
    checkbox.addEventListener("change", () => {
      imageBatchDraft.selected = scope.filter(value => value !== index);
      if (checkbox.checked) imageBatchDraft.selected.push(index);
      $("#imageBatchScope").value = "selected"; persistImageBatchDraft(); renderImageBatchDraft();
    });
    const button = document.createElement("button"); button.type = "button";
    const title = document.createElement("span"); title.textContent = `${index + 1} · ${baseName(file)}`;
    const detail = document.createElement("small"), item = imageBatchDraft.results[index];
    const model = item?.fallback?.model || item?.plan?.steps?.find(step => step.stage === "matting")?.modelId;
    const cleanup = item?.cleanupReport;
    const cleanupText = cleanup ? cleanup.removed || cleanup.recolored
      ? ` · удалено ${cleanup.removed} пикс. остатков · перекрашено ${cleanup.recolored} пикс. кромки`
      : " · светлая кромка не изменилась" : "";
    const changeText = item?.changeReport?.changed === 0 ? " · пиксели не изменились" : item?.changeReport?.changed != null ? ` · всего изменено ${item.changeReport.changed} пикс.` : "";
    const lightText = item?.colorRemoval?.length ? " · удаляется только выбранный цвет" : item?.lightDecision?.policy === "none" ? " · светлые остатки убраны" : item?.lightDecision?.confidence === "uncertain" ? " · светлые детали сохранены: решение неуверенное" : item?.lightDecision ? " · светлые детали сохранены" : "";
    detail.textContent = imageBatchDraft.exportFailures?.[index] ? `Ошибка сохранения: ${imageBatchDraft.exportFailures[index]}` : imageBatchDraft.failures[index] ? `Ошибка: ${imageBatchDraft.failures[index]}` : imageBatchDraft.exported?.[index] ? "Сохранено · PNG + JSON" : item ? `${item.changeReport?.changed === 0 ? "Без изменений" : "Готово"} · ${item.route?.join(" → ") || model || "локальная очистка"}${lightText}${cleanupText}${changeText}${item.fallback ? " · CPU fallback" : ""}${item.qualityWarnings?.length ? " · " + item.qualityWarnings.join(" ") : ""}` : "Ещё не обработано";
    if (item?.lightDecision?.reason) button.title = item.lightDecision.reason;
    button.append(title, detail); button.addEventListener("click", () => showImageBatchPair(index)); row.append(checkbox, button); list.append(row);
  });
  const ready = scope.filter(index => imageBatchDraft.results[index]).length;
  $("#imageBatchSummary").textContent = `${scope.length} выбрано · ${ready} готово · ${scope.filter(index => imageBatchDraft.failures[index]).length} ошибок`;
  $("#prepareImageBatch").disabled = state.busy || !scope.length;
  $("#retryImageBatch").disabled = state.busy || !scope.some(index => imageBatchDraft.failures[index]);
  $("#continueImageBatch").disabled = state.busy || !scope.some(index => !imageBatchDraft.results[index] && !imageBatchDraft.failures[index]);
  $("#cancelImageBatchJob").disabled = !state.busy;
  const combined = imageBatchDraft.outputKind && imageBatchDraft.outputKind !== "png";
  $("#applyImageBatch").disabled = state.busy || !scope.length || ready !== scope.length || combined && imageBatchDraft.assembly?.signature !== batchAssemblySignature();
  if (combined) $("#applyImageBatch").textContent = "Сохранить лист и JSON";
  $("#imageBatchOutput").disabled = state.busy;
  $("#imageBatchScale").disabled = state.busy;
  $("#imageBatchScope").disabled = state.busy;
  $("#imageBatchModel").disabled = state.busy || Boolean(imageBatchDraft.configuration?.healFirst);
  $("#imageBatchBackground").disabled = state.busy;
  $("#imageBatchBlackContour").disabled = state.busy;
  $("#imageBatchLightArtwork").disabled = state.busy;
  $("#imageBatchContourWidth").disabled = state.busy;
  window.renderBatchCleanupSuggestion?.();
  $$("#imageBatchTasks button").forEach(control => { control.disabled = state.busy; });
  $$(".batch-color-adjust input, #imageBatchResetColor").forEach(control => { control.disabled = state.busy || imageBatchDraft.configuration?.readyOnly; });
  $$("#imageBatchPixelation input, #imageBatchPixelation select").forEach(control => {
    control.disabled = state.busy || imageBatchDraft.configuration?.readyOnly || (control.id !== "imageBatchPixelateEnabled" && !imageBatchDraft.pixelate);
  });
  const readyOnly = Boolean(imageBatchDraft.configuration?.readyOnly);
  $$(".batch-preview-settings > *").forEach(element => element.classList.toggle("hidden", readyOnly && element.id !== "imageBatchAssembly"));
  $$("#imageBatchTasks button").forEach(button => button.classList.toggle("selected", button.dataset.batchTask === (readyOnly ? "ready" : imageBatchDraft.configuration?.healFirst ? "healing" : "cleanup")));
  const assemblyValid = combined && imageBatchDraft.assembly?.signature === batchAssemblySignature();
  const title = $("#imageBatchAfter").closest("figure")?.querySelector("figcaption");
  if (title) title.textContent = combined ? "Собранный лист · выбранный фон записывается в PNG" : "После обработки · подложка просмотра не меняет PNG";
  if (assemblyValid) {
    const urls = imageBatchDraft.assembly.result.sheetUrls;
    const page = Math.min(Number($("#imageBatchPage").value) || 0, urls.length - 1);
    if ($("#imageBatchPage").options.length !== urls.length) $("#imageBatchPage").replaceChildren(...urls.map((_, i) => { const option = document.createElement("option"); option.value = i; option.textContent = `Страница ${i + 1}/${urls.length}`; return option; }));
    $("#imageBatchPage").value = String(page); $("#imageBatchAfter").src = urls[page];
  }
  $("#imageBatchPage").disabled = state.busy || !assemblyValid;
  const fitMode = ["contain", "cover", "stretch"].includes(imageBatchDraft.imageGeometry?.mode);
  $$("#imageBatchGeometry input, #imageBatchGeometry select").forEach(control => {
    control.disabled = state.busy || imageBatchDraft.configuration?.readyOnly || (control.id !== "imageBatchGeometryMode" && !fitMode);
  });
}
window.openImageBatchPreview = function (configuration = {}) {
  if ((!configuration.paths && state.source?.kind !== "frames") || state.busy) return;
  const initialOptions = configuration.options || collectOptions();
  const modelOverride = configuration.healFirst ? "" : configuration.modelOverride ?? (initialOptions.keyMode === "ai" ? initialOptions.aiModel : "");
  configuration = { ...configuration, modelOverride: modelOverride ? "toonout" : "", backgroundMode: ["white", "black", "green", "magenta"].includes(configuration.backgroundMode) ? configuration.backgroundMode : "auto", blackContour: configuration.blackContour === "remove" ? "remove" : "preserve", lightArtworkPolicy: ["auto", "protect", "none"].includes(configuration.lightArtworkPolicy) ? configuration.lightArtworkPolicy : "auto", contourWidth: configuration.contourWidth === 4 ? 4 : 2 };
  imageBatchReturnFocus = document.activeElement;
  const paths = configuration.paths || state.source.paths;
  const exportAtlases = Boolean(configuration.exportAtlases);
  const configurationKey = JSON.stringify({version:13, readyOnly:configuration.readyOnly, exportAtlases, options:configuration.options, splitObjects:configuration.splitObjects, automatic:configuration.automatic, healFirst:configuration.healFirst, modelOverride:configuration.modelOverride, backgroundMode:configuration.backgroundMode, blackContour:configuration.blackContour, lightArtworkPolicy:configuration.lightArtworkPolicy, contourWidth:configuration.contourWidth});
  let saved; try { saved = JSON.parse(localStorage.getItem("spriteLab.pendingImageBatch")); } catch { /* No prior job. */ }
  if (!imageBatchDraft || JSON.stringify(imageBatchDraft.paths) !== JSON.stringify(paths) || imageBatchDraft.configurationKey !== configurationKey) {
    const adjustments = JSON.stringify(imageBatchDraft?.paths) === JSON.stringify(paths)
      ? imageBatchDraft.adjustments || { brightness: 0, contrast: 0, warmth: 0 }
      : { brightness: 0, contrast: 0, warmth: 0 };
    const pixelate = JSON.stringify(imageBatchDraft?.paths) === JSON.stringify(paths) ? imageBatchDraft.pixelate || null : null;
    const imageGeometry = JSON.stringify(imageBatchDraft?.paths) === JSON.stringify(paths) ? imageBatchDraft.imageGeometry || null : null;
    imageBatchDraft = saved && JSON.stringify(saved.paths) === JSON.stringify(paths) && saved.configurationKey === configurationKey && saved.results && saved.failures && saved.selected ? saved : { paths: [...paths], selected: [Math.min(state.selectedFrameIndex,paths.length-1)], results: {}, failures: {}, settings: {}, directory: null, configurationKey, configuration, adjustments, pixelate, imageGeometry };
  }
  $("#imageBatchOutput").value = imageBatchDraft.outputKind || "png";
  $("#imageBatchScale").value = String(imageBatchDraft.pixelScale || 1);
  $("#imageBatchAtlasBackground").value = imageBatchDraft.atlasBackground || "transparent";
  $("#imageBatchAtlasColor").value = imageBatchDraft.atlasBackgroundColor || "#ff00ff";
  if (configuration.readyOnly) {
    if (configuration.outputKind) imageBatchDraft.outputKind = configuration.outputKind;
    imageBatchDraft.outputKind ||= "sheet"; $("#imageBatchOutput").value = imageBatchDraft.outputKind;
    imageBatchDraft.paths.forEach((file, index) => { imageBatchDraft.results[index] ||= { input: file, imagePath: state.frameOverrides[index] || file, route: ["готовый файл · без очистки"] }; });
  }
  imageBatchDraft.adjustments ||= { brightness: 0, contrast: 0, warmth: 0 };
  $("#imageBatchPixelateEnabled").checked = Boolean(imageBatchDraft.pixelate);
  $("#imageBatchSharedPalette").checked = imageBatchDraft.pixelate?.paletteScope !== "frame";
  $("#imageBatchPixelateSize").value = String(imageBatchDraft.pixelate?.size || 3);
  $("#imageBatchPixelateColors").value = String(imageBatchDraft.pixelate?.colors || 32);
  $("#imageBatchPixelateDither").value = imageBatchDraft.pixelate?.dither || "none";
  $("#imageBatchGeometryMode").value = imageBatchDraft.imageGeometry?.mode || "original";
  $("#imageBatchWidth").value = String(imageBatchDraft.imageGeometry?.width || 64);
  $("#imageBatchHeight").value = String(imageBatchDraft.imageGeometry?.height || 64);
  $("#imageBatchGeometryTrim").checked = imageBatchDraft.imageGeometry?.trimToObject ?? true;
  $("#imageBatchGeometryKernel").value = imageBatchDraft.imageGeometry?.kernel || "nearest";
  renderImageBatchGeometryHint();
  for (const key of ["brightness", "contrast", "warmth"]) {
    document.getElementById("imageBatch" + key[0].toUpperCase() + key.slice(1)).value = String(imageBatchDraft.adjustments[key] || 0);
    document.getElementById("imageBatch" + key[0].toUpperCase() + key.slice(1) + "Value").textContent = String(imageBatchDraft.adjustments[key] || 0);
  }
  $$("#imageBatchTasks button").forEach(button => {
    const active = (button.dataset.batchTask === "healing") === Boolean(configuration.healFirst);
    button.classList.toggle("selected", active); button.setAttribute("aria-pressed", String(active));
  });
  const modelSelect = $("#imageBatchModel");
  modelSelect.replaceChildren();
  const autoOption = document.createElement("option"); autoOption.value = ""; autoOption.textContent = "Автоматически подобрать способ"; modelSelect.append(autoOption);
  for (const option of $("#aiModel").options) {
    if (option.value !== "toonout") continue;
    const choice = document.createElement("option"); choice.value = option.value; choice.textContent = option.textContent; modelSelect.append(choice);
  }
  if (configuration.modelOverride && ![...modelSelect.options].some(option => option.value === configuration.modelOverride)) {
    const missing = document.createElement("option"); missing.value = configuration.modelOverride; missing.textContent = `${configuration.modelOverride} · проверьте установку`; modelSelect.append(missing);
  }
  modelSelect.value = configuration.modelOverride;
  $("#imageBatchBackground").value = configuration.backgroundMode;
  $("#imageBatchBlackContour").value = configuration.blackContour;
  $("#imageBatchLightArtwork").value = configuration.lightArtworkPolicy;
  $("#imageBatchContourWidth").value = String(configuration.contourWidth);
  $("#imageBatchContourChoice").classList.toggle("hidden", configuration.lightArtworkPolicy === "protect");
  $("#imageBatchModelHint").textContent = configuration.healFirst
    ? "После восстановления сохраняем его контур и запускаем обычную очистку."
    : configuration.modelOverride
      ? "Выбранная модель запустится для каждого файла, даже если у PNG уже есть прозрачность. Сравните белые детали и край перед применением."
      : "Автовыбор может сохранить уже имеющуюся прозрачность без запуска модели. Если фон остался, выберите ToonOut и сравните результат.";
  $('#imageBatchTitle').textContent = configuration.readyOnly ? "Сборка готовых изображений" : configuration.healFirst ? 'Восстановление объекта · Подорожник' : exportAtlases ? 'Пакетная подготовка PNG + JSON' : 'Автоочистка изображений';
  $('.batch-preview-header p').textContent = configuration.readyOnly ? "Файлы используются как есть. Выберите лист или атлас и фон сохраняемого PNG. Исходники сохраняются." : configuration.healFirst ? 'Сравните исходник, восстановленный объект и результат обычной очистки. Применение можно отменить Ctrl+Z; исходные файлы остаются на месте.' : exportAtlases ? 'Проверьте очистку каждого исходника. После просмотра сохраняются отдельные PNG + JSON. Исходные файлы остаются на месте.' : 'Сравните исходник и результат. Применение можно отменить Ctrl+Z; PNG сохраняются отдельной кнопкой.';
  $('#imageBatchHealingFigure').classList.toggle('hidden', !configuration.healFirst);
  $('#imageBatchComparison').classList.toggle('with-healing', Boolean(configuration.healFirst));
  $('#applyImageBatch').textContent = exportAtlases ? 'Сохранить выбранные · PNG + JSON' : 'Применить выбранные';
  $("#imageBatchModal").classList.remove("hidden"); $("#imageBatchScope").value = "all";
  renderImageBatchDraft(); showImageBatchPair(Math.min(state.selectedFrameIndex,paths.length-1)); $("#imageBatchScope").focus();
  if (!Object.keys(imageBatchDraft.results).length && !Object.keys(imageBatchDraft.failures).length) void prepareImageBatch();
};
window.closeImageBatchPreview = function () {
  if (state.busy) { $("#imageBatchSummary").textContent = "Остановите обработку перед закрытием. Готовые результаты сохранятся в просмотре."; return; }
  persistImageBatchDraft(); $("#imageBatchModal").classList.add("hidden"); imageBatchReturnFocus?.focus();
};
async function prepareImageBatch(mode = "all", requestedIndexes = null) {
  if (state.busy) return;
  if (mode === "all" && imageBatchDraft.outputKind && imageBatchDraft.outputKind !== "png" && imageBatchIndexes().every(index => imageBatchDraft.results[index])) { await prepareBatchAssembly(); return; }
  const indexes = (requestedIndexes || imageBatchIndexes()).filter(index => mode === "failed" ? imageBatchDraft.failures[index] : mode === "remaining" ? !imageBatchDraft.results[index] && !imageBatchDraft.failures[index] : true);
  if (!indexes.length) return;
  const configuration = imageBatchDraft.configuration || {};
  const baseline = configuration.options || collectOptions();
  const settings = { ...baseline, pixelScale: imageBatchDraft.pixelScale || 1, batchModelOverride: configuration.modelOverride, batchBackgroundMode: configuration.backgroundMode, batchBlackContour: configuration.blackContour, edgeRefine: { mode: "none", width: 1, depth: 2, whiteOnly: true, ...baseline.edgeRefine, noLightArtwork: configuration.lightArtworkPolicy === "none", lightArtworkPolicy: configuration.lightArtworkPolicy, contourWidth: configuration.contourWidth }, pixelate: imageBatchDraft.pixelate || (configuration.exportAtlases ? baseline.pixelate : null), toning: configuration.exportAtlases ? baseline.toning : null, imageGeometry: imageBatchDraft.imageGeometry || (configuration.exportAtlases ? baseline.imageGeometry : null), colorAdjust: { ...imageBatchDraft.adjustments }, frameTransforms: {}, attachments: [], attachmentPlacements: null };
  state.busy = true; updateActionState(); renderImageBatchDraft();
  $("#prepareImageBatch").textContent = "Обрабатываю…";
  settings.batchCleanupByIndex = imageBatchDraft.cleanupChoices || {};
  $("#cancelJob").classList.remove("hidden");
  setStatus(`Готовлю просмотр: ${indexes.length} изображений…`, "busy", .02);
  try {
    const result = await window.spriteLab.imageBatch({ paths: indexes.map(index => imageBatchDraft.paths[index]), sourceIndexes: indexes, outputKind: "images", automatic: configuration.automatic ?? true, healFirst: Boolean(configuration.healFirst), previewOnly: true, previewDirectory: imageBatchDraft.directory, options: settings });
    imageBatchDraft.directory = result.outputDir;
    for (const item of result.results) {
      const index = imageBatchDraft.paths.indexOf(item.input);
      imageBatchDraft.results[index] = item; imageBatchDraft.settings[index] = { ...baseline, pixelate: settings.pixelate, imageGeometry: settings.imageGeometry }; delete imageBatchDraft.failures[index];
      delete imageBatchDraft.exported?.[index]; delete imageBatchDraft.exportFailures?.[index];
    }
    for (const item of result.failures) {
      const index = imageBatchDraft.paths.indexOf(item.input); imageBatchDraft.failures[index] = item.message; delete imageBatchDraft.results[index];
    }
    persistImageBatchDraft(); showImageBatchPair(indexes[0]);
    setStatus(result.cancelled || result.stopped ? "Обработка остановлена · готовое осталось в просмотре" : "Предпросмотр готов · сравните и примените", "done", 0);
  } catch (error) { showError(error.message); }
  finally { state.busy = false; updateActionState(); renderImageBatchDraft(); $("#prepareImageBatch").textContent = "Обновить просмотр"; $("#cancelJob").classList.add("hidden"); }
}
$("#closeImageBatch").addEventListener("click", window.closeImageBatchPreview);
$("#imageBatchScope").addEventListener("change", renderImageBatchDraft);
$("#imageBatchModel").addEventListener("change", event => {
  if (state.busy || !imageBatchDraft) return;
  window.openImageBatchPreview({ ...imageBatchDraft.configuration, modelOverride: event.target.value, backgroundMode: "auto" });
});
$("#imageBatchBackground").addEventListener("change", event => {
  if (state.busy || !imageBatchDraft) return;
  window.openImageBatchPreview({ ...imageBatchDraft.configuration, backgroundMode: event.target.value, modelOverride: "" });
});
$("#imageBatchBlackContour").addEventListener("change", event => {
  if (state.busy || !imageBatchDraft) return;
  window.openImageBatchPreview({ ...imageBatchDraft.configuration, blackContour: event.target.value });
});
$("#imageBatchLightArtwork").addEventListener("change", event => {
  if (state.busy || !imageBatchDraft) return;
  if (event.target.value === "none") {
    event.target.value = imageBatchDraft.configuration.lightArtworkPolicy;
    void window.confirmBatchNoLightArtwork(imageBatchIndexes());
    return;
  }
  window.openImageBatchPreview({ ...imageBatchDraft.configuration, lightArtworkPolicy: event.target.value });
});
$("#imageBatchContourWidth").addEventListener("change", event => {
  if (state.busy || !imageBatchDraft) return;
  window.openImageBatchPreview({ ...imageBatchDraft.configuration, contourWidth: Number(event.target.value) });
});
$("#imageBatchTasks").addEventListener("click", event => {
  const button = event.target.closest("button[data-batch-task]");
  if (!button || state.busy) return;
  if (button.dataset.batchTask === "ready") { window.openImageBatchPreview({ readyOnly: true, automatic: false }); return; }
  const healFirst = button.dataset.batchTask === "healing";
  if (!imageBatchDraft.configuration?.readyOnly && healFirst === Boolean(imageBatchDraft.configuration?.healFirst)) return;
  window.openImageBatchPreview({ ...imageBatchDraft.configuration, healFirst, readyOnly: false, automatic: true });
});
function imageBatchColorChanged() {
  if (!imageBatchDraft || state.busy) return;
  for (const key of ["brightness", "contrast", "warmth"]) {
    const element = document.getElementById("imageBatch" + key[0].toUpperCase() + key.slice(1));
    imageBatchDraft.adjustments[key] = Number(element.value);
    document.getElementById("imageBatch" + key[0].toUpperCase() + key.slice(1) + "Value").textContent = element.value;
  }
  imageBatchDraft.results = {}; imageBatchDraft.failures = {}; imageBatchDraft.settings = {}; imageBatchDraft.exported = {}; imageBatchDraft.exportFailures = {};
  persistImageBatchDraft(); renderImageBatchDraft(); showImageBatchPair(imageBatchReviewIndex);
  $("#imageBatchSummary").textContent = "Цвет изменён · обновите просмотр, затем примените PNG";
  $("#prepareImageBatch").textContent = "Обновить просмотр";
}
function imageBatchPixelationChanged() {
  if (!imageBatchDraft || state.busy) return;
  const sizeControl = $("#imageBatchPixelateSize");
  const size = Math.max(2, Math.min(32, Math.round(Number(sizeControl.value) || 3)));
  sizeControl.value = String(size);
  imageBatchDraft.pixelate = $("#imageBatchPixelateEnabled").checked
    ? { size, colors: Number($("#imageBatchPixelateColors").value), palette: "auto", mode: "clean", paletteScope: $("#imageBatchSharedPalette").checked ? "series" : "frame", dither: $("#imageBatchPixelateDither").value }
    : null;
  imageBatchDraft.results = {}; imageBatchDraft.failures = {}; imageBatchDraft.settings = {}; imageBatchDraft.exported = {}; imageBatchDraft.exportFailures = {};
  persistImageBatchDraft(); renderImageBatchDraft(); showImageBatchPair(imageBatchReviewIndex);
  $("#imageBatchSummary").textContent = "Пикселизация изменена · обновите просмотр, затем примените PNG";
}
function renderImageBatchGeometryHint() {
  const mode = $("#imageBatchGeometryMode").value;
  $("#imageBatchGeometryHint").textContent = {
    original: "Сохраняется исходное разрешение каждого PNG.",
    trim: "Убираются только прозрачные поля. Пиксели объекта не масштабируются.",
    contain: "Объект вписывается с сохранением пропорций. Свободные поля прозрачные.",
    cover: "Кадр заполняется с сохранением пропорций; выступающие края обрезаются. Проверьте детали.",
    stretch: "Ширина и высота меняются независимо; пропорции рисунка изменятся.",
  }[mode];
}
function imageBatchGeometryChanged() {
  if (!imageBatchDraft || state.busy) return;
  const dimensions = {};
  for (const dimension of ["Width", "Height"]) {
    const control = document.getElementById("imageBatch" + dimension);
    dimensions[dimension.toLowerCase()] = Math.max(1, Math.min(4096, Math.round(Number(control.value) || 64)));
    control.value = String(dimensions[dimension.toLowerCase()]);
  }
  const mode = $("#imageBatchGeometryMode").value;
  imageBatchDraft.imageGeometry = mode === "original" ? null : { mode, ...dimensions,
    kernel: $("#imageBatchGeometryKernel").value, trimToObject: $("#imageBatchGeometryTrim").checked };
  imageBatchDraft.results = {}; imageBatchDraft.failures = {}; imageBatchDraft.settings = {}; imageBatchDraft.exported = {}; imageBatchDraft.exportFailures = {};
  renderImageBatchGeometryHint(); persistImageBatchDraft(); renderImageBatchDraft(); showImageBatchPair(imageBatchReviewIndex);
  $("#imageBatchSummary").textContent = "Размер изменён · обновите просмотр, затем примените PNG";
}
for (const id of ["imageBatchGeometryMode", "imageBatchWidth", "imageBatchHeight", "imageBatchGeometryTrim", "imageBatchGeometryKernel"]) {
  document.getElementById(id).addEventListener("change", imageBatchGeometryChanged);
}
for (const id of ["imageBatchPixelateEnabled", "imageBatchPixelateSize", "imageBatchPixelateColors", "imageBatchPixelateDither", "imageBatchSharedPalette"]) {
  document.getElementById(id).addEventListener("change", imageBatchPixelationChanged);
}
for (const key of ["Brightness", "Contrast", "Warmth"]) document.getElementById("imageBatch" + key).addEventListener("input", imageBatchColorChanged);
$("#imageBatchResetColor").addEventListener("click", () => {
  for (const key of ["Brightness", "Contrast", "Warmth"]) document.getElementById("imageBatch" + key).value = "0";
  imageBatchColorChanged();
});
$("#prepareImageBatch").addEventListener("click", () => prepareImageBatch());
$("#retryImageBatch").addEventListener("click", () => prepareImageBatch("failed"));
$("#continueImageBatch").addEventListener("click", () => prepareImageBatch("remaining"));
$("#cancelImageBatchJob").addEventListener("click", () => window.spriteLab.cancelBuild());
async function exportReviewedImageAtlases(indexes) {
  const configuration = imageBatchDraft.configuration;
  const pending = indexes.filter(index=>!imageBatchDraft.exported?.[index]);
  if (!pending.length) { setStatus('Все выбранные PNG + JSON уже сохранены', 'done', 1); window.closeImageBatchPreview(); return; }
  state.busy = true; updateActionState(); renderImageBatchDraft(); $('#cancelJob').classList.remove('hidden');
  imageBatchDraft.exported ||= {}; imageBatchDraft.exportFailures ||= {};
  try {
    const outputDir = state.outputFolder || await window.spriteLab.automaticOutput(imageBatchDraft.paths[0]);
    state.outputFolder=outputDir; $('#outputFolder').textContent=outputDir;
    const options={...configuration.options, keyMode:'alpha', fringeCleanup:false, edgeDecontaminate:false, edgeRefine:{mode:'none'}, pixelate:null, toning:null, imageGeometry:null, frameOverrides:{}, preparedCleanup:{}, maskEdits:[], aiEdits:[], frameTransforms:{},attachments:[],attachmentPlacements:null};
    const result=await window.spriteLab.imageBatch({paths:pending.map(index=>imageBatchDraft.results[index].imagePath),outputDir,options,splitObjects:configuration.splitObjects});
    for(const item of result.results) {
      const index=pending.find(value=>imageBatchDraft.results[value].imagePath===item.input);
      imageBatchDraft.exported[index]=item;delete imageBatchDraft.exportFailures[index];
    }
    for(const item of result.failures) {
      const index=pending.find(value=>imageBatchDraft.results[value].imagePath===item.input);imageBatchDraft.exportFailures[index]=item.message;
    }
    state.lastExportDir=outputDir;state.lastRevealPath=result.revealPath;
    const count=indexes.filter(index=>imageBatchDraft.exported[index]).length;
    setStatus(`Сохранено PNG + JSON: ${count}/${indexes.length} · исходники сохранены${result.failed?' · повторите сохранение для ошибок':''}`,result.failed?'error':'done',1);
    $('#exportSummary').textContent=`PNG + JSON: ${count}/${indexes.length} · ${outputDir}`;
    $('#exportSummary').classList.remove('hidden');$('#completionActions').classList.remove('hidden');
  } catch(error) { showError(error.message); }
  finally { state.busy=false;updateActionState();$('#cancelJob').classList.add('hidden');persistImageBatchDraft();renderImageBatchDraft(); }
  if(indexes.every(index=>imageBatchDraft.exported[index])) window.closeImageBatchPreview();
}
$("#applyImageBatch").addEventListener("click", async () => {
  const indexes = imageBatchIndexes();
  if (state.busy || !indexes.length || indexes.some(index => !imageBatchDraft.results[index])) return;
  if (imageBatchDraft.outputKind && imageBatchDraft.outputKind !== "png") { await saveBatchAssembly(); return; }
  if (imageBatchDraft.configuration?.exportAtlases) { await exportReviewedImageAtlases(indexes); return; }
  const { preparedCleanupRecord } = await import("./prepared-cleanup.mjs");
  clearTimeout(state.historyTimer); pushHistory("До пакетной очистки");
  for (const index of indexes) {
    const item = imageBatchDraft.results[index]; state.frameOverrides[index] = item.imagePath;
    state.preparedCleanup[index] = preparedCleanupRecord(imageBatchDraft.settings[index], item.imagePath);
    const thumbnail = $("#filmstrip button[data-source-index='" + index + "'] img"); if (thumbnail) thumbnail.src = imageBatchUrl(item.imagePath);
  }
  pushHistory(`Очистка ${indexes.length} изображений`); markPreviewDirty(); scheduleFramePreview(0);
  window.closeImageBatchPreview(); setStatus(`Применено: ${indexes.length} · Ctrl+Z отменяет весь пакет · сохраните PNG`, "done", 0);
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !$("#imageBatchModal").classList.contains("hidden")) { event.preventDefault(); window.closeImageBatchPreview(); }
});

$("#assembleReadyImages").addEventListener("click", () => window.openImageBatchPreview({ readyOnly: true, automatic: false }));

$("#imageBatchPage").addEventListener("change", renderImageBatchDraft);
