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
let imageBatchReturnFocus = null;
let imageBatchReviewIndex = 0;
const imageBatchUrl = file => "file:///" + file.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/");
function persistImageBatchDraft() {
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
  $("#applyImageBatch").disabled = state.busy || !scope.length || ready !== scope.length;
  $("#imageBatchScope").disabled = state.busy;
  $("#imageBatchModel").disabled = state.busy || Boolean(imageBatchDraft.configuration?.healFirst);
  $("#imageBatchBackground").disabled = state.busy;
  $("#imageBatchBlackContour").disabled = state.busy;
  $("#imageBatchLightArtwork").disabled = state.busy;
  $("#imageBatchContourWidth").disabled = state.busy;
  $("#imageBatchOtherModels").disabled = state.busy;
  window.renderBatchCleanupSuggestion?.();
  $$("#imageBatchTasks button, .batch-color-adjust input, #imageBatchResetColor").forEach(control => { control.disabled = state.busy; });
}
window.openImageBatchPreview = function (configuration = {}) {
  if ((!configuration.paths && state.source?.kind !== "frames") || state.busy) return;
  const initialOptions = configuration.options || collectOptions();
  const modelOverride = configuration.healFirst ? "" : configuration.modelOverride ?? (initialOptions.keyMode === "ai" ? initialOptions.aiModel : "");
  configuration = { ...configuration, modelOverride: modelOverride || "", backgroundMode: ["white", "black", "green", "magenta"].includes(configuration.backgroundMode) ? configuration.backgroundMode : "auto", blackContour: configuration.blackContour === "remove" ? "remove" : "preserve", lightArtworkPolicy: ["auto", "protect", "none"].includes(configuration.lightArtworkPolicy) ? configuration.lightArtworkPolicy : "auto", contourWidth: configuration.contourWidth === 4 ? 4 : 2 };
  imageBatchReturnFocus = document.activeElement;
  const paths = configuration.paths || state.source.paths;
  const exportAtlases = Boolean(configuration.exportAtlases);
  const configurationKey = JSON.stringify({version:8, exportAtlases, options:configuration.options, splitObjects:configuration.splitObjects, automatic:configuration.automatic, healFirst:configuration.healFirst, modelOverride:configuration.modelOverride, backgroundMode:configuration.backgroundMode, blackContour:configuration.blackContour, lightArtworkPolicy:configuration.lightArtworkPolicy, contourWidth:configuration.contourWidth});
  let saved; try { saved = JSON.parse(localStorage.getItem("spriteLab.pendingImageBatch")); } catch { /* No prior job. */ }
  if (!imageBatchDraft || JSON.stringify(imageBatchDraft.paths) !== JSON.stringify(paths) || imageBatchDraft.configurationKey !== configurationKey) {
    const adjustments = JSON.stringify(imageBatchDraft?.paths) === JSON.stringify(paths)
      ? imageBatchDraft.adjustments || { brightness: 0, contrast: 0, warmth: 0 }
      : { brightness: 0, contrast: 0, warmth: 0 };
    imageBatchDraft = saved && JSON.stringify(saved.paths) === JSON.stringify(paths) && saved.configurationKey === configurationKey && saved.results && saved.failures && saved.selected ? saved : { paths: [...paths], selected: [Math.min(state.selectedFrameIndex,paths.length-1)], results: {}, failures: {}, settings: {}, directory: null, configurationKey, configuration, adjustments };
  }
  imageBatchDraft.adjustments ||= { brightness: 0, contrast: 0, warmth: 0 };
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
    if (!configuration.showAllModels && !["toonout", "birefnet-tiny", configuration.modelOverride].includes(option.value)) continue;
    const choice = document.createElement("option"); choice.value = option.value; choice.textContent = option.textContent; modelSelect.append(choice);
  }
  if (configuration.modelOverride && ![...modelSelect.options].some(option => option.value === configuration.modelOverride)) {
    const missing = document.createElement("option"); missing.value = configuration.modelOverride; missing.textContent = `${configuration.modelOverride} · проверьте установку`; modelSelect.append(missing);
  }
  modelSelect.value = configuration.modelOverride;
  $("#imageBatchOtherModels").textContent = configuration.showAllModels ? "Скрыть остальные модели" : "Другие модели";
  $("#imageBatchBackground").value = configuration.backgroundMode;
  $("#imageBatchBlackContour").value = configuration.blackContour;
  $("#imageBatchLightArtwork").value = configuration.lightArtworkPolicy;
  $("#imageBatchContourWidth").value = String(configuration.contourWidth);
  $("#imageBatchContourChoice").classList.toggle("hidden", configuration.lightArtworkPolicy === "protect");
  $("#imageBatchModelHint").textContent = configuration.healFirst
    ? "После восстановления сохраняем его контур и запускаем обычную очистку."
    : configuration.modelOverride
      ? "Выбранная модель запустится для каждого файла, даже если у PNG уже есть прозрачность. Сравните белые детали и край перед применением."
      : "Автовыбор может сохранить уже имеющуюся прозрачность без запуска модели. Если фон остался, выберите модель и сравните результат.";
  $('#imageBatchTitle').textContent = configuration.healFirst ? 'Восстановление объекта · Подорожник' : exportAtlases ? 'Пакетная подготовка PNG + JSON' : 'Автоочистка изображений';
  $('.batch-preview-header p').textContent = configuration.healFirst ? 'Сравните исходник, восстановленный объект и результат обычной очистки. Применение можно отменить Ctrl+Z; исходные файлы остаются на месте.' : exportAtlases ? 'Проверьте очистку каждого исходника. После просмотра сохраняются отдельные PNG + JSON. Исходные файлы остаются на месте.' : 'Сравните исходник и результат. Применение можно отменить Ctrl+Z; PNG сохраняются отдельной кнопкой.';
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
  const indexes = (requestedIndexes || imageBatchIndexes()).filter(index => mode === "failed" ? imageBatchDraft.failures[index] : mode === "remaining" ? !imageBatchDraft.results[index] && !imageBatchDraft.failures[index] : true);
  if (!indexes.length) return;
  const configuration = imageBatchDraft.configuration || {};
  const baseline = configuration.options || collectOptions();
  const settings = { ...baseline, batchModelOverride: configuration.modelOverride, batchBackgroundMode: configuration.backgroundMode, batchBlackContour: configuration.blackContour, edgeRefine: { mode: "none", width: 1, depth: 2, whiteOnly: true, ...baseline.edgeRefine, noLightArtwork: configuration.lightArtworkPolicy === "none", lightArtworkPolicy: configuration.lightArtworkPolicy, contourWidth: configuration.contourWidth }, pixelate: configuration.exportAtlases ? baseline.pixelate : null, toning: configuration.exportAtlases ? baseline.toning : null, colorAdjust: { ...imageBatchDraft.adjustments }, frameTransforms: {}, attachments: [], attachmentPlacements: null };
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
      imageBatchDraft.results[index] = item; imageBatchDraft.settings[index] = baseline; delete imageBatchDraft.failures[index];
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
$("#imageBatchOtherModels").addEventListener("click", () => {
  if (state.busy || !imageBatchDraft) return;
  const configuration = imageBatchDraft.configuration;
  configuration.showAllModels = !configuration.showAllModels;
  const select = $("#imageBatchModel");
  for (const option of [...select.options]) if (option.value) option.remove();
  for (const option of $("#aiModel").options) {
    if (!configuration.showAllModels && !["toonout", "birefnet-tiny", configuration.modelOverride].includes(option.value)) continue;
    const choice = document.createElement("option"); choice.value = option.value; choice.textContent = option.textContent; select.append(choice);
  }
  select.value = configuration.modelOverride;
  $("#imageBatchOtherModels").textContent = configuration.showAllModels ? "Скрыть остальные модели" : "Другие модели";
  persistImageBatchDraft();
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
  const healFirst = button.dataset.batchTask === "healing";
  if (healFirst === Boolean(imageBatchDraft.configuration?.healFirst)) return;
  window.openImageBatchPreview({ ...imageBatchDraft.configuration, healFirst, automatic: true });
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
    const options={...configuration.options, keyMode:'alpha', fringeCleanup:false, edgeDecontaminate:false, edgeRefine:{mode:'none'}, pixelate:null, toning:null, frameOverrides:{}, preparedCleanup:{}, maskEdits:[], aiEdits:[], frameTransforms:{},attachments:[],attachmentPlacements:null};
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
