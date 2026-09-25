const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  source: null, outputFolder: null, result: null, previewMode: "after", keyMode: "auto", anchor: "ground",
  busy: false, lastExportDir: null, lastRevealPath: null, framePreview: null, selectedFrameIndex: 0,
  excludedFrames: new Set(), quickTimer: null, quickToken: 0,
  zoom: 1, guides: false, backdrop: 0, timelineValid: true, sourceRevision: 0, resultDirty: false,
  maskEdits: [], maskBrushMode: "smart", maskDrawing: false, maskStrokeId: 0,
  maskEditorSnapshot: [], maskEditorImage: null, maskEditorPixels: null,
  attachments: [], attachmentAsset: null, attachmentSourceImage: null, attachmentAssetImage: null,
  attachmentPoints: [], attachmentPointCount: 1, attachmentEditingId: null, attachmentReferenceFrame: 0,
  frameOverrides: {}, externalEdit: null, externalEditTimer: null,
};
let posterTimer = null;
let aboutReturnFocus = null;
let pendingUpdate = null;

const exportControls = { sheet: "#exportSheet", frames: "#exportFrames", metadata: "#exportMetadata", preview: "#exportPreview" };
const exportNames = { sheet: "спрайт-лист", frames: "кадры", metadata: "JSON", preview: "WebP" };
const exportPresets = {
  chuba: { sheet: true, frames: true, metadata: true, preview: true },
  sheet: { sheet: true, frames: false, metadata: false, preview: false },
  frames: { sheet: false, frames: true, metadata: false, preview: false },
  artist: { sheet: false, frames: true, metadata: false, preview: true },
  engine: { sheet: true, frames: false, metadata: true, preview: false },
};

function setTab(name) {
  $$(".tab").forEach((button) => {
    const selected = button.dataset.tab === name;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
  });
  $$(".panel").forEach((panel) => {
    const active = panel.dataset.panel === name;
    panel.classList.toggle("active", active);
    panel.setAttribute("aria-hidden", String(!active));
  });
  if (name === "process") scheduleFramePreview(0);
}

function setStatus(message, kind = "idle", value = 0) {
  $("#statusText").textContent = message;
  $("#statusLed").className = kind === "idle" ? "" : kind;
  const percent = Math.max(0, Math.min(100, Math.round(value * 100)));
  $("#progressBar").style.width = `${percent}%`;
  $("#statusPercent").textContent = `${percent}%`;
  $("#cancelJob").classList.toggle("hidden", !state.busy);
}

function showError(message) {
  $("#errorText").textContent = message || "Неизвестная ошибка.";
  $("#errorCard").classList.remove("hidden");
}

function hideError() {
  $("#errorCard").classList.add("hidden");
}

async function openAbout() {
  aboutReturnFocus = document.activeElement;
  $("#aboutModal").classList.remove("hidden");
  $("#checkUpdates").disabled = state.busy;
  $("#checkUpdates").textContent = "Проверить обновления";
  pendingUpdate = null;
  $("#updateStatus").className = "update-status";
  $("#updateStatus").textContent = state.busy
    ? "Дождитесь завершения текущей обработки перед проверкой обновлений."
    : "Обновления устанавливаются из официальных GitHub Releases с проверкой SHA-256.";
  try {
    const info = await window.spriteLab.getAppInfo();
    $("#versionBadge").textContent = info.version;
    $("#aboutVersion").textContent = info.version;
  } catch { /* The package version is already present in the document. */ }
  $("#closeAbout").focus();
}

function closeAbout() {
  $("#aboutModal").classList.add("hidden");
  aboutReturnFocus?.focus?.();
}

async function checkForUpdates() {
  if (state.busy) return;
  const button = $("#checkUpdates");
  const status = $("#updateStatus");
  if (pendingUpdate) {
    button.disabled = true;
    button.textContent = pendingUpdate.portable ? "УСТАНАВЛИВАЮ…" : "ОТКРЫВАЮ…";
    status.className = "update-status busy";
    status.textContent = pendingUpdate.portable ? "Скачиваю и проверяю новую версию…" : "Открываю страницу официального релиза…";
    try {
      const result = await window.spriteLab.installUpdate();
      if (result.status === "installing") {
        status.className = "update-status success";
        status.textContent = `Версия ${result.latestVersion} проверена. Перезапускаю программу…`;
        return;
      }
      if (result.status === "manual") {
        status.className = "update-status success";
        status.textContent = `Страница версии ${result.latestVersion} открыта в браузере.`;
      } else if (result.status === "current") {
        status.className = "update-status success";
        status.textContent = `Версия ${result.currentVersion} уже актуальна.`;
      } else {
        status.className = "update-status error";
        status.textContent = result.message || "Не удалось установить обновление.";
      }
    } catch (error) {
      status.className = "update-status error";
      status.textContent = error.message || "Не удалось установить обновление.";
    } finally {
      pendingUpdate = null;
      button.disabled = false;
      button.textContent = "Проверить обновления";
    }
    return;
  }
  button.disabled = true;
  button.textContent = "ПРОВЕРЯЮ…";
  status.className = "update-status busy";
  status.textContent = "Соединяюсь с GitHub Releases…";
  try {
    const result = await window.spriteLab.checkForUpdates();
    if (result.status === "current") {
      status.className = "update-status success";
      status.textContent = `Версия ${result.currentVersion} актуальна.`;
    } else if (result.status === "available") {
      pendingUpdate = result;
      status.className = "update-status success";
      status.textContent = result.portable
        ? `Доступна версия ${result.latestVersion}. Нажмите ещё раз, чтобы скачать и установить её.`
        : `Доступна версия ${result.latestVersion}. Нажмите ещё раз, чтобы открыть официальный релиз.`;
      button.textContent = result.portable ? `Установить ${result.latestVersion}` : "Открыть релиз";
    } else if (result.status === "error") {
      status.className = "update-status error";
      status.textContent = result.message;
    } else {
      status.className = "update-status";
      status.textContent = "Проверка обновлений завершена.";
    }
  } catch (error) {
    status.className = "update-status error";
    status.textContent = error.message || "Не удалось проверить обновления.";
  } finally {
    button.disabled = false;
    if (!pendingUpdate) button.textContent = "Проверить обновления";
  }
}

function sourceDefaultName(source) {
  const title = source?.title || "sprite-animation";
  return title.replace(/\.[^.]+$/, "").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "sprite-animation";
}

function suggestedFps(source) {
  const sourceFps = Number(source?.fps) || 0;
  if (!sourceFps) return 8;
  return sourceFps > 16 ? Math.max(8, Math.round(sourceFps / 2)) : Math.max(1, Math.round(sourceFps));
}

function collectExports() {
  return Object.fromEntries(Object.entries(exportControls).map(([name, selector]) => [name, $(selector).checked]));
}

function updateActionState() {
  const hasSource = Boolean(state.source);
  const batchCount = state.source?.kind === "video-batch" ? state.source.paths.length : 0;
  const selectedNames = Object.entries(collectExports()).filter(([, selected]) => selected).map(([name]) => exportNames[name]);
  $("#appShell").inert = state.busy;
  $("#appShell").setAttribute("aria-busy", String(state.busy));
  $(".tabs").inert = state.busy;
  $("#buildPreview").disabled = !hasSource || state.busy || !state.timelineValid;
  $("#chooseOutput").disabled = state.busy;
  $("#exportSprites").disabled = !hasSource || !state.outputFolder || state.busy || selectedNames.length === 0;
  $("#exportHint").textContent = !hasSource ? "Сначала выберите источник"
    : !state.outputFolder ? "Выберите папку назначения"
      : selectedNames.length === 0 ? "Выберите хотя бы один формат"
        : state.busy ? "Обработка выполняется…"
          : state.lastExportDir ? `Сохранено: ${state.lastExportDir}`
            : batchCount ? `${batchCount} наборов · ${selectedNames.join(" · ")}` : selectedNames.join(" · ");
  $("#exportComposition").textContent = selectedNames.length
    ? batchCount ? `Для каждого из ${batchCount} видео: ${selectedNames.join(", ")}.` : `Будет создано: ${selectedNames.join(", ")}.`
    : "Не выбран ни один формат.";
  $("#exportButtonTitle").textContent = batchCount
    ? `ЭКСПОРТИРОВАТЬ ${batchCount} ВИДЕО`
    : state.result?.frameCount && !state.resultDirty ? `ЭКСПОРТИРОВАТЬ ${state.result.frameCount} КАДРОВ` : "ЭКСПОРТИРОВАТЬ";
  $("#openMaskEditor").disabled = !hasSource || state.busy;
  $("#addAttachment").disabled = !hasSource || state.busy || state.source?.kind === "video-batch";
  $("#editFrame").disabled = !state.result?.allSourceFramePaths?.length || state.busy || state.source?.kind === "video-batch";
}

function currentFramePath() {
  if (state.frameOverrides[state.selectedFrameIndex]) return state.frameOverrides[state.selectedFrameIndex];
  if (state.result?.allSourceFramePaths?.[state.selectedFrameIndex]) return state.result.allSourceFramePaths[state.selectedFrameIndex];
  if (state.source?.samplePaths?.[state.selectedFrameIndex]) return state.source.samplePaths[state.selectedFrameIndex];
  return state.source?.previewPath || state.source?.paths?.[0] || null;
}

function setSource(source) {
  clearTimeout(posterTimer);
  clearTimeout(state.quickTimer);
  state.sourceRevision += 1;
  state.quickToken += 1;
  state.source = source;
  state.result = null;
  state.framePreview = null;
  state.excludedFrames.clear();
  state.maskEdits = [];
  state.attachments = [];
  state.frameOverrides = {};
  state.selectedFrameIndex = 0;
  state.lastExportDir = null;
  state.lastRevealPath = null;
  hideError();
  if (!source) {
    $("#sourceCard").classList.add("hidden");
    $("#sourceRange").classList.add("hidden");
    $("#sourceTitle").textContent = "—";
    $("#sourceDetail").textContent = "—";
    $("#spriteName").value = "sprite-animation";
    $("#sourcePreview").classList.add("hidden");
    $("#sourcePreviewImage").removeAttribute("src");
    $("#recommendationCard").classList.add("hidden");
    $("#batchNote").classList.add("hidden");
    $("#sheetControls").classList.add("hidden");
    $("#spriteName").disabled = false;
    $("#spriteNameLabel").textContent = "Имя набора";
    $("#sampleStrip").replaceChildren();
    updateMaskEditSummary();
    renderAttachmentList();
    resetPreview();
    $("#framePreviewTabs").classList.add("hidden");
    setStatus("Готов к работе");
    updateActionState();
    return;
  }
  $("#sourceCard").classList.remove("hidden");
  const isBatch = source.kind === "video-batch";
  const isSheet = source.kind === "sheet";
  $("#sourceBadge").textContent = isBatch ? "BATCH" : isSheet ? "SHEET" : source.kind === "video" ? "VIDEO" : "FRAMES";
  $("#sourceTitle").textContent = source.title;
  $("#sourceDetail").textContent = source.detail;
  $("#sourceRange").classList.toggle("hidden", source.kind !== "video");
  $("#sourcePreviewLabel").textContent = isBatch ? "ПЕРВОЕ ВИДЕО" : source.kind === "video" ? "НАЧАЛО ДИАПАЗОНА" : isSheet ? "ПЕРВЫЙ ОБЪЕКТ" : "ПЕРВЫЙ КАДР";
  $("#batchNote").classList.toggle("hidden", !isBatch);
  $("#sheetControls").classList.toggle("hidden", !isSheet);
  if (isSheet) {
    $("#sheetObjectCount").textContent = `${source.paths.length} объектов`;
    $$("#sheetSliceMode button").forEach((button) => button.classList.toggle("selected", button.dataset.sheetMode === source.sheetMode));
    $("#sheetGridFields").classList.toggle("hidden", source.sheetMode !== "grid");
  }
  configureTimeline(source);
  if (source.previewUrl) {
    $("#sourcePreviewImage").src = source.previewUrl;
    $("#sourcePreview").classList.remove("hidden");
  }
  $("#spriteName").disabled = isBatch;
  $("#spriteNameLabel").textContent = isBatch ? "Имена наборов" : "Имя набора";
  $("#spriteName").value = isBatch ? "Автоматически — по именам видео" : sourceDefaultName(source);
  resetPreview();
  renderRecommendations(source);
  renderAttachmentList();
  $("#framePreviewTabs").classList.remove("hidden");
  setStatus(`Источник загружен · ${source.detail}`, "done", 0);
  updateActionState();
  savePreferences();
}

function resetPreview() {
  $("#previewImage").classList.add("hidden");
  $("#compareView").classList.add("hidden");
  $("#previewImage").removeAttribute("src");
  $("#previewEmpty").classList.remove("hidden");
  $("#filmstripBar").classList.add("hidden");
  $("#filmstripNote").classList.add("hidden");
  $("#filmstrip").replaceChildren();
  for (const id of ["metaFrames", "metaCell", "metaGrid", "metaAnchor"]) $(`#${id}`).textContent = "—";
  $("#warningBox").classList.add("hidden");
  $("#completionActions").classList.add("hidden");
  $("#resultPreviewTabs").classList.add("hidden");
  $("#exportSummary").classList.add("hidden");
  state.resultDirty = false;
  $("#previewFreshness").classList.add("hidden");
}

function markPreviewDirty() {
  if (!state.result || state.busy) return;
  state.resultDirty = true;
  $("#previewFreshness").classList.remove("hidden");
  updateActionState();
}

function confidenceLabel(value) {
  if (value >= 0.99) return "высокая уверенность";
  if (value >= 0.66) return "средняя уверенность";
  return "нужно проверить";
}

function modeLabel(mode) {
  return ({ auto: "авто", alpha: "готовая прозрачность", white: "белый", black: "чёрный", green: "зелёный", blue: "синий", ai: "локальный ИИ" })[mode] || mode;
}

function renderRecommendations(source) {
  const recommendation = source.recommendations;
  if (!recommendation) return;
  $("#recommendationConfidence").textContent = confidenceLabel(recommendation.confidence);
  const sizeText = recommendation.cellWidth && recommendation.cellHeight ? `ячейка около ${recommendation.cellWidth} × ${recommendation.cellHeight}` : "размер ячейки автоматически";
  const frameText = recommendation.estimatedFrames ? ` · примерно ${recommendation.estimatedFrames} кадров` : "";
  const anchorText = ({ ground: "ноги на месте", center: "центр на месте", motion: "сохранить движение" })[recommendation.anchor] || "ноги на месте";
  const batchText = source.kind === "video-batch" ? " · по первому видео" : "";
  $("#recommendationSummary").textContent = `Фон: ${modeLabel(recommendation.keyMode)} · ${recommendation.fps} FPS · ${anchorText} · ${sizeText}${frameText}${batchText}`;
  $("#detectedBackground").textContent = `обнаружен: ${modeLabel(recommendation.keyMode)}`;
  const strip = $("#sampleStrip");
  strip.replaceChildren();
  (source.sampleUrls || []).forEach((url, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.classList.toggle("selected", index === 0);
    button.setAttribute("aria-pressed", String(index === 0));
    const img = document.createElement("img"); img.src = url; img.alt = `Контрольный кадр ${index + 1}`;
    button.append(img);
    button.addEventListener("click", () => {
      state.selectedFrameIndex = index;
      $$("#sampleStrip button").forEach((item, itemIndex) => {
        const selected = itemIndex === index;
        item.classList.toggle("selected", selected);
        item.setAttribute("aria-pressed", String(selected));
      });
      requestFramePreview(source.samplePaths[index]);
      setTab("process");
    });
    strip.append(button);
  });
  $("#recommendationCard").classList.remove("hidden");
}

function applyRecommendations() {
  const recommendation = state.source?.recommendations;
  if (!recommendation) return;
  setKeyMode(recommendation.keyMode);
  setAnchor(recommendation.anchor || "ground");
  $("#fps").value = String(recommendation.fps || 8);
  $("#autoSize").checked = true;
  $("#autoColumns").checked = true;
  $("#pixelPerfect").checked = false;
  syncAutoSize();
  setTab("process");
  scheduleFramePreview(0);
}

function configureTimeline(source) {
  const duration = Math.max(0, Number(source.duration) || 0);
  const step = source.fps ? Math.max(0.01, 1 / source.fps) : 0.04;
  for (const id of ["trimStartRange", "trimEndRange"]) {
    $(`#${id}`).max = String(duration || 1);
    $(`#${id}`).step = String(step);
  }
  $("#trimStartRange").value = "0";
  $("#trimEndRange").value = String(duration || 1);
  $("#trimStart").value = "0";
  $("#trimEnd").value = duration ? duration.toFixed(2) : "0";
  updateTimeline(false);
}

function updateTimeline(refreshPoster = true) {
  const duration = Number(state.source?.duration) || 0;
  let start = Math.max(0, Number($("#trimStart").value) || 0);
  let end = Math.min(duration || Infinity, Number($("#trimEnd").value) || duration);
  const valid = end > start;
  state.timelineValid = valid;
  $("#trimError").classList.toggle("hidden", valid);
  $("#trimError").textContent = valid ? "" : "Конец диапазона должен быть позже начала.";
  updateActionState();
  if (!valid) return;
  $("#trimStartRange").value = String(start);
  $("#trimEndRange").value = String(end);
  $("#trimDuration").textContent = `${(end - start).toFixed(1).replace(".", ",")} с`;
  markPreviewDirty();
  if (refreshPoster && state.source?.kind === "video") schedulePoster(start);
}

function schedulePoster(time) {
  clearTimeout(posterTimer);
  const revision = state.sourceRevision;
  const sourcePath = state.source?.paths?.[0];
  if (!sourcePath) return;
  posterTimer = setTimeout(async () => {
    try {
      const poster = await window.spriteLab.previewPoster({ path: sourcePath, time });
      if (revision !== state.sourceRevision || sourcePath !== state.source?.paths?.[0]) return;
      state.source.previewPath = poster.previewPath;
      state.source.previewUrl = poster.previewUrl;
      $("#sourcePreviewImage").src = poster.previewUrl;
      if (!state.result) requestFramePreview(poster.previewPath);
    } catch (error) { showError(error.message); }
  }, 220);
}

function collectOptions() {
  const isBatch = state.source?.kind === "video-batch";
  return {
    fps: Number($("#fps").value), columns: Number($("#columns").value),
    cellWidth: Number($("#cellWidth").value), cellHeight: Number($("#cellHeight").value),
    padding: Number($("#padding").value), maxFrames: Number($("#maxFrames").value),
    tolerance: Number($("#tolerance").value), blackOutline: Number($("#blackOutline").value), blackFeather: Number($("#blackFeather").value),
    trimStart: isBatch ? 0 : Number($("#trimStart").value) || 0,
    trimEnd: isBatch ? 0 : Number($("#trimEnd").value) || 0,
    keyMode: state.keyMode, anchor: state.anchor, autoSize: $("#autoSize").checked, autoColumns: $("#autoColumns").checked,
    pixelPerfect: $("#pixelPerfect").checked, removeDuplicates: $("#removeDuplicates").checked,
    outputBackground: $("#whiteOutput").checked ? "white" : "transparent",
    excludedFrames: [...state.excludedFrames], exports: collectExports(),
    aiCutoff: Number($("#aiCutoff").value), aiSoftness: Number($("#aiSoftness").value),
    aiEdits: state.maskEdits, previewFrameIndex: state.result ? state.selectedFrameIndex : 0,
    fringeCleanup: $("#fringeCleanup").checked, fringeStrength: Number($("#fringeStrength").value),
    attachments: state.attachments.filter((attachment) => attachment.enabled !== false), attachmentPlacements: state.resultDirty ? null : state.result?.attachmentPlacements || null,
    frameOverrides: state.frameOverrides,
    fitEachFrame: state.source?.kind === "sheet" && $("#sheetFitEach").checked,
  };
}

function syncExportDependencies(changedName) {
  const sheet = $(exportControls.sheet);
  const metadata = $(exportControls.metadata);
  if (changedName === "metadata" && metadata.checked) sheet.checked = true;
  if (changedName === "sheet" && !sheet.checked) metadata.checked = false;
  sheet.disabled = metadata.checked;
  state.lastExportDir = null;
  if (changedName) $("#exportPreset").value = "custom";
  updateActionState();
  savePreferences();
}

function applyExportPreset(name) {
  const preset = exportPresets[name];
  if (!preset) return;
  Object.entries(preset).forEach(([key, checked]) => { $(exportControls[key]).checked = checked; });
  $(exportControls.sheet).disabled = preset.metadata;
  state.lastExportDir = null;
  updateActionState();
  savePreferences();
}

function setKeyMode(mode) {
  state.keyMode = mode;
  $$("#keyMode button").forEach((item) => {
    const selected = item.dataset.value === mode;
    item.classList.toggle("selected", selected);
    item.setAttribute("aria-pressed", String(selected));
  });
  $("#blackKeyNote").classList.toggle("hidden", mode !== "black");
  $("#blackOutlineRow").classList.toggle("hidden", mode !== "black");
  $("#blackFeatherRow").classList.toggle("hidden", mode !== "black");
  $("#toleranceRow").classList.toggle("hidden", mode === "ai");
  $("#aiCleanupPanel").classList.toggle("hidden", mode !== "ai");
  markPreviewDirty();
}

function setAnchor(anchor) {
  state.anchor = anchor;
  $$("#anchorMode button").forEach((item) => {
    const selected = item.dataset.value === anchor;
    item.classList.toggle("selected", selected);
    item.setAttribute("aria-pressed", String(selected));
  });
  markPreviewDirty();
}

function syncAutoSize() {
  const automatic = $("#autoSize").checked;
  $$(".manual-size input").forEach((input) => { input.disabled = automatic; });
  $("#columns").disabled = $("#autoColumns").checked;
  markPreviewDirty();
}

function applyProcessPreset(name) {
  $$("#processPresets button[data-preset]").forEach((button) => {
    const selected = button.dataset.preset === name;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  if (name === "effect") {
    setAnchor("center"); $("#removeDuplicates").checked = false; $("#pixelPerfect").checked = false;
  } else if (name === "pixel") {
    setAnchor("ground"); $("#removeDuplicates").checked = true; $("#pixelPerfect").checked = true;
  } else {
    setAnchor("ground"); $("#removeDuplicates").checked = true; $("#pixelPerfect").checked = false;
  }
  markPreviewDirty();
  savePreferences();
}

function resetRecommended() {
  const recommendation = state.source?.recommendations;
  setKeyMode(recommendation?.keyMode || state.source?.suggestedKeyMode || "auto");
  setAnchor(recommendation?.anchor || "ground");
  $("#fps").value = String(recommendation?.fps || suggestedFps(state.source));
  $("#tolerance").value = "28"; $("#toleranceValue").textContent = "28";
  $("#blackOutline").value = "3"; $("#blackOutlineValue").textContent = "3";
  $("#blackFeather").value = "0"; $("#blackFeatherValue").textContent = "0 px";
  $("#aiCutoff").value = "50"; $("#aiCutoffValue").textContent = "50";
  $("#aiSoftness").value = "0"; $("#aiSoftnessValue").textContent = "0 px";
  $("#fringeCleanup").checked = false; $("#fringeStrength").value = "55"; $("#fringeStrengthValue").textContent = "55"; $("#fringeStrengthRow").classList.add("hidden");
  state.maskEdits = []; updateMaskEditSummary();
  $("#padding").value = "20"; $("#columns").value = "8"; $("#maxFrames").value = "192";
  $("#autoSize").checked = true; $("#autoColumns").checked = true; $("#pixelPerfect").checked = true; $("#removeDuplicates").checked = true; $("#whiteOutput").checked = false;
  syncAutoSize(); applyProcessPreset("character"); scheduleFramePreview();
}

function showWarnings(warnings) {
  const list = $("#warningList");
  list.replaceChildren();
  if (!warnings?.length) { $("#warningBox").classList.add("hidden"); return; }
  const groups = new Map();
  warnings.forEach((warning) => {
    const key = warning.includes("касается края") ? "Персонаж касается края"
      : warning.includes("ширина силуэта") ? "Скачок ширины силуэта"
        : warning.includes("высота силуэта") ? "Скачок высоты силуэта"
          : warning.includes("уверенность привязки") ? "Проверьте привязку PNG"
            : warning.includes("умная область") ? "Проверьте удаление объекта" : warning.replace(/Кадр\s+\d+:?\s*/i, "");
    const match = warning.match(/Кадр\s+(\d+)/i);
    if (!groups.has(key)) groups.set(key, []);
    if (match) groups.get(key).push(Number(match[1]) - 1);
  });
  [...groups.entries()].slice(0, 12).forEach(([label, frameIndexes]) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = frameIndexes.length ? `${label} · ${frameIndexes.length} кадр.` : label;
    button.className = label.includes("края") || label.includes("привязку") || label.includes("удаление") ? "severity-error" : "severity-info";
    if (frameIndexes.length) button.addEventListener("click", () => {
      const outputIndex = frameIndexes[0];
      selectFrame(state.result?.sourceFrameIndexes?.[outputIndex] ?? outputIndex);
    });
    item.append(button); list.append(item);
  });
  $("#warningCount").textContent = String(warnings.length);
  $("#warningBox").classList.remove("hidden");
}

function buildFilmstrip(result) {
  const strip = $("#filmstrip"); strip.replaceChildren();
  const processedBySource = new Map((result.sourceFrameIndexes || []).map((sourceIndex, outputIndex) => [sourceIndex, result.frameUrls[outputIndex]]));
  result.allSourceFrameUrls.forEach((sourceUrl, sourceIndex) => {
    const button = document.createElement("button");
    button.type = "button"; button.title = `Исходный кадр ${sourceIndex + 1}`; button.dataset.sourceIndex = String(sourceIndex);
    const img = document.createElement("img"); img.src = processedBySource.get(sourceIndex) || sourceUrl; img.alt = `Кадр ${sourceIndex + 1}`;
    button.classList.toggle("excluded", state.excludedFrames.has(sourceIndex));
    const isDuplicate = result.skipped?.duplicateIndexes?.includes(sourceIndex);
    const isEmpty = result.skipped?.emptyIndexes?.includes(sourceIndex);
    button.classList.toggle("skipped", isDuplicate || isEmpty);
    if (isDuplicate) button.title += " · точный дубль";
    if (isEmpty) button.title += " · пустой после очистки";
    button.append(img); button.addEventListener("click", () => selectFrame(sourceIndex)); strip.append(button);
  });
  $("#filmstripBar").classList.toggle("hidden", result.allSourceFrameUrls.length === 0);
  const truncated = result.allSourceFramePaths.length - result.allSourceFrameUrls.length;
  $("#filmstripNote").textContent = truncated > 0 ? `Показаны первые ${result.allSourceFrameUrls.length} кадров. Ещё кадров: ${truncated}.` : `${result.allSourceFramePaths.length} исходных кадров · исключено: ${state.excludedFrames.size}`;
  $("#filmstripNote").classList.remove("hidden");
}

function selectFrame(sourceIndex, activateFrameView = true) {
  if (!state.result?.allSourceFramePaths?.length) return;
  state.selectedFrameIndex = Math.max(0, Math.min(sourceIndex, state.result.allSourceFramePaths.length - 1));
  $$("#filmstrip button").forEach((button) => {
    const buttonSourceIndex = Number(button.dataset.sourceIndex);
    button.classList.toggle("selected", buttonSourceIndex === state.selectedFrameIndex);
    button.classList.toggle("excluded", state.excludedFrames.has(buttonSourceIndex));
  });
  const automaticallySkipped = state.result.skipped?.duplicateIndexes?.includes(state.selectedFrameIndex)
    || state.result.skipped?.emptyIndexes?.includes(state.selectedFrameIndex);
  const isBatch = state.source?.kind === "video-batch";
  $("#excludeFrame").disabled = automaticallySkipped || isBatch;
  $("#excludeFrame").textContent = isBatch
    ? "Только для одного видео"
    : automaticallySkipped
    ? "Пропущен автоматически"
    : state.excludedFrames.has(state.selectedFrameIndex) ? "Вернуть кадр" : "Исключить кадр";
  if (activateFrameView) setPreviewMode("after");
  requestFramePreview(currentFramePath());
}

function activeMaskFrameIndex() {
  return state.result?.allSourceFramePaths?.length ? state.selectedFrameIndex : 0;
}

function maskEditApplies(edit, frameIndex = activeMaskFrameIndex()) {
  return Boolean(edit?.applyAll) || Number(edit?.frameIndex) === Number(frameIndex);
}

function updateMaskEditSummary() {
  const regions = state.maskEdits.filter((edit) => edit.type === "tracked-region").length;
  const strokes = new Set(state.maskEdits.filter((edit) => edit.type !== "tracked-region").map((edit) => edit.strokeId)).size;
  $("#clearMaskEdits").disabled = regions + strokes === 0;
  $("#maskEditSummary").textContent = regions + strokes
    ? `Умных областей: ${regions} · мазков: ${strokes}.`
    : "Стена, пятно или просвет — один раз для всей серии.";
  updateFinishingSummary();
}

function updateFinishingSummary() {
  const objectSummary = $("[data-summary='object']");
  const edgeSummary = $("[data-summary='edge']");
  const overlaySummary = $("[data-summary='overlay']");
  if (!objectSummary || !edgeSummary || !overlaySummary) return;
  const regions = state.maskEdits.filter((edit) => edit.type === "tracked-region").length;
  const strokes = new Set(state.maskEdits.filter((edit) => edit.type !== "tracked-region").map((edit) => edit.strokeId)).size;
  objectSummary.textContent = regions + strokes ? `Лишнее: ${regions + strokes}` : "Лишнее: нет";
  objectSummary.classList.toggle("active", regions + strokes > 0);
  edgeSummary.textContent = $("#fringeCleanup").checked ? "Контур: очищается" : "Контур: нет";
  edgeSummary.classList.toggle("active", $("#fringeCleanup").checked);
  const enabledAttachments = state.attachments.filter((attachment) => attachment.enabled !== false).length;
  overlaySummary.textContent = `PNG: ${enabledAttachments}${enabledAttachments !== state.attachments.length ? `/${state.attachments.length}` : ""}`;
  overlaySummary.classList.toggle("active", enabledAttachments > 0);
}

function updateMaskEditorStatus() {
  const frameIndex = activeMaskFrameIndex();
  const relevant = state.maskEdits.filter((edit) => maskEditApplies(edit, frameIndex));
  const regions = relevant.filter((edit) => edit.type === "tracked-region").length;
  const strokes = new Set(relevant.filter((edit) => edit.type !== "tracked-region").map((edit) => edit.strokeId)).size;
  $("#maskEditorStatus").textContent = `Кадр ${frameIndex + 1} · ${regions ? `${regions} обл.` : "0 обл."} · ${strokes ? `${strokes} действ.` : "без кисти"}`;
  $("#undoMaskStroke").disabled = strokes === 0;
  $("#resetMaskStrokes").disabled = relevant.length === 0;
}

function redrawMaskCanvas() {
  const canvas = $("#maskCanvas");
  const context = canvas.getContext("2d");
  if (!state.maskEditorImage || !canvas.width || !canvas.height) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(state.maskEditorImage, 0, 0, canvas.width, canvas.height);
  for (const edit of state.maskEdits) {
    if (!maskEditApplies(edit)) continue;
    if (edit.type === "tracked-region") {
      const left = (Number(edit.selectionLeft) || Math.max(0, (Number(edit.centroidX) || 0) - (Number(edit.selectionWidth) || 0.04) / 2)) * canvas.width;
      const top = (Number(edit.selectionTop) || Math.max(0, (Number(edit.centroidY) || 0) - (Number(edit.selectionHeight) || 0.04) / 2)) * canvas.height;
      const width = Math.max(12, (Number(edit.selectionWidth) || 0.04) * canvas.width);
      const height = Math.max(12, (Number(edit.selectionHeight) || 0.04) * canvas.height);
      context.save();
      context.fillStyle = "rgba(255, 118, 23, .12)";
      context.strokeStyle = "rgba(255, 143, 65, .95)";
      context.lineWidth = Math.max(1.5, Math.max(canvas.width, canvas.height) / 620);
      context.setLineDash([8, 5]);
      context.fillRect(left, top, width, height);
      context.strokeRect(left, top, width, height);
      context.setLineDash([]);
      const pinX = (Number(edit.centroidX) || Number(edit.x) || 0) * canvas.width;
      const pinY = (Number(edit.centroidY) || Number(edit.y) || 0) * canvas.height;
      context.beginPath(); context.arc(pinX, pinY, 6, 0, Math.PI * 2); context.fillStyle = "#ff7617"; context.fill();
      context.restore();
      continue;
    }
    context.beginPath();
    context.arc(edit.x * canvas.width, edit.y * canvas.height, edit.radius * Math.max(canvas.width, canvas.height), 0, Math.PI * 2);
    context.fillStyle = edit.mode === "keep" ? "rgba(200, 223, 111, .34)" : "rgba(255, 92, 98, .34)";
    context.fill();
    context.strokeStyle = edit.mode === "keep" ? "rgba(220, 239, 143, .72)" : "rgba(255, 126, 130, .72)";
    context.lineWidth = Math.max(1, Math.max(canvas.width, canvas.height) / 700);
    context.stroke();
  }
  updateMaskEditorStatus();
}

async function openMaskEditor() {
  if (!state.source || state.busy) return;
  setStatus("Готовлю выбранный кадр…", "busy", 0.12);
  await requestFramePreview(currentFramePath());
  const imageUrl = state.framePreview?.beforeUrl || state.source.previewUrl;
  if (!imageUrl) {
    setStatus("Не удалось открыть кадр для редактора", "error", 0);
    return;
  }
  state.maskEditorSnapshot = state.maskEdits.map((edit) => ({ ...edit }));
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error("Не удалось загрузить кадр в редактор маски."));
    image.src = imageUrl;
  });
  state.maskEditorImage = image;
  const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = $("#maskCanvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const sourceContext = canvas.getContext("2d", { willReadFrequently: true });
  sourceContext.clearRect(0, 0, canvas.width, canvas.height);
  sourceContext.drawImage(image, 0, 0, canvas.width, canvas.height);
  state.maskEditorPixels = sourceContext.getImageData(0, 0, canvas.width, canvas.height).data.slice();
  redrawMaskCanvas();
  $("#aiMaskModal").classList.remove("hidden");
  $("#applyMaskEditor").focus();
  setStatus("Редактор маски открыт", "done", 0);
}

function closeMaskEditor({ discard = false } = {}) {
  if (discard) state.maskEdits = state.maskEditorSnapshot.map((edit) => ({ ...edit }));
  state.maskDrawing = false;
  state.maskEditorImage = null;
  state.maskEditorPixels = null;
  $("#aiMaskModal").classList.add("hidden");
  updateMaskEditSummary();
  $("#openMaskEditor").focus();
}

function addMaskPoint(event) {
  if (!state.maskDrawing || !state.maskEditorImage) return;
  const canvas = $("#maskCanvas");
  const rect = canvas.getBoundingClientRect();
  const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
  const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height)));
  const radius = Number($("#maskBrushSize").value) / Math.max(rect.width, rect.height, 1);
  const previous = state.maskEdits.at(-1);
  if (previous?.strokeId === state.maskStrokeId && Math.hypot(previous.x - x, previous.y - y) < radius * 0.32) return;
  state.maskEdits.push({
    x, y, radius,
    mode: state.maskBrushMode,
    frameIndex: activeMaskFrameIndex(),
    applyAll: $("#maskApplyAll").checked,
    strokeId: state.maskStrokeId,
  });
  redrawMaskCanvas();
}

function selectTrackedRegion(event) {
  if (!state.maskEditorPixels || !state.maskEditorImage) return;
  const canvas = $("#maskCanvas");
  const rect = canvas.getBoundingClientRect();
  const seedX = Math.max(0, Math.min(canvas.width - 1, Math.round((event.clientX - rect.left) / Math.max(1, rect.width) * canvas.width)));
  const seedY = Math.max(0, Math.min(canvas.height - 1, Math.round((event.clientY - rect.top) / Math.max(1, rect.height) * canvas.height)));
  const pixels = state.maskEditorPixels;
  const color = [0, 0, 0];
  let samples = 0;
  for (let y = Math.max(0, seedY - 2); y <= Math.min(canvas.height - 1, seedY + 2); y += 1) {
    for (let x = Math.max(0, seedX - 2); x <= Math.min(canvas.width - 1, seedX + 2); x += 1) {
      const offset = (y * canvas.width + x) * 4;
      color[0] += pixels[offset]; color[1] += pixels[offset + 1]; color[2] += pixels[offset + 2]; samples += 1;
    }
  }
  for (let index = 0; index < 3; index += 1) color[index] = Math.round(color[index] / Math.max(1, samples));
  const tolerance = Number($("#smartRegionTolerance").value) || 42;
  const thresholdSquared = tolerance * tolerance;
  const visited = new Uint8Array(canvas.width * canvas.height);
  const queue = new Int32Array(visited.length);
  let head = 0;
  let tail = 0;
  let minX = canvas.width; let minY = canvas.height; let maxX = -1; let maxY = -1; let sumX = 0; let sumY = 0;
  const enqueue = (x, y) => {
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
    const index = y * canvas.width + x;
    if (visited[index]) return;
    visited[index] = 1;
    const offset = index * 4;
    const dr = pixels[offset] - color[0]; const dg = pixels[offset + 1] - color[1]; const db = pixels[offset + 2] - color[2];
    if (pixels[offset + 3] < 8 || dr * dr + dg * dg + db * db > thresholdSquared) return;
    queue[tail++] = index;
  };
  enqueue(seedX, seedY);
  while (head < tail) {
    const index = queue[head++];
    const x = index % canvas.width; const y = Math.floor(index / canvas.width);
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    sumX += x; sumY += y;
    enqueue(x - 1, y); enqueue(x + 1, y); enqueue(x, y - 1); enqueue(x, y + 1);
  }
  if (tail < 4) {
    $("#maskEditorStatus").textContent = "Область слишком мала · увеличьте чувствительность";
    return;
  }
  state.maskStrokeId += 1;
  state.maskEdits.push({
    type: "tracked-region", mode: "erase", color, tolerance,
    x: seedX / Math.max(1, canvas.width - 1), y: seedY / Math.max(1, canvas.height - 1),
    centroidX: sumX / tail / Math.max(1, canvas.width - 1), centroidY: sumY / tail / Math.max(1, canvas.height - 1),
    area: tail / Math.max(1, canvas.width * canvas.height),
    selectionLeft: minX / canvas.width, selectionTop: minY / canvas.height,
    selectionWidth: (maxX - minX + 1) / canvas.width, selectionHeight: (maxY - minY + 1) / canvas.height,
    searchRadius: 0.32, frameIndex: activeMaskFrameIndex(), applyAll: $("#maskApplyAll").checked,
    strokeId: state.maskStrokeId,
  });
  redrawMaskCanvas();
}

function setMaskTool(mode) {
  state.maskBrushMode = mode;
  $$("#maskBrushMode button").forEach((item) => item.classList.toggle("selected", item.dataset.mode === mode));
  $("#smartRegionRow").classList.toggle("hidden", mode !== "smart");
  $("#maskBrushSizeRow").classList.toggle("hidden", mode === "smart");
  $("#maskApplyTitle").textContent = mode === "smart" ? "Искать во всей серии" : "Повторить во всех кадрах";
  $("#maskApplyHint").textContent = mode === "smart" ? "слежение за цветом, размером и формой" : "кисть останется в тех же координатах";
  $("#maskToolTip").textContent = mode === "smart"
    ? "Щёлкните по стене, пятну или просвету. Область будет найдена заново в каждом кадре."
    : "Кисть исправляет маску вручную. Поиск движения для неё не применяется.";
}

function loadUiImage(url, errorMessage) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(errorMessage));
    image.src = url;
  });
}

function renderAttachmentList() {
  const list = $("#attachmentList");
  list.replaceChildren();
  if (!state.attachments.length) {
    const empty = document.createElement("p");
    empty.textContent = "PNG-элементов пока нет.";
    list.append(empty);
    updateFinishingSummary();
    return;
  }
  for (const attachment of state.attachments) {
    const trackedPoints = (state.result?.attachmentPlacements || [])
      .flatMap((frame) => frame.filter((entry) => entry.id === attachment.id).flatMap((entry) => entry.points || []));
    const confidence = trackedPoints.length
      ? trackedPoints.reduce((sum, point) => sum + Number(point.confidence || 0), 0) / trackedPoints.length
      : null;
    const item = document.createElement("article");
    item.className = "attachment-item";
    item.classList.toggle("low-confidence", confidence != null && confidence < 0.45);
    item.classList.toggle("disabled", attachment.enabled === false);
    const image = document.createElement("img"); image.src = attachment.url; image.alt = "";
    const text = document.createElement("div");
    const title = document.createElement("strong"); title.textContent = attachment.title;
    const detail = document.createElement("small"); detail.textContent = `${attachment.points.length} точк. · ${Math.round(attachment.sizeRatio * 100)}%${confidence == null ? " · не проверено" : ` · уверенность ${Math.round(confidence * 100)}%`}`;
    text.append(title, detail);
    const actions = document.createElement("div"); actions.className = "attachment-actions";
    const toggle = document.createElement("button"); toggle.type = "button"; toggle.textContent = attachment.enabled === false ? "○" : "●"; toggle.title = attachment.enabled === false ? "Включить PNG" : "Временно скрыть PNG";
    toggle.addEventListener("click", () => {
      attachment.enabled = attachment.enabled === false;
      renderAttachmentList(); markPreviewDirty(); scheduleFramePreview(0);
    });
    const edit = document.createElement("button"); edit.type = "button"; edit.textContent = "↗"; edit.title = "Изменить привязку";
    edit.addEventListener("click", async () => {
      try { await openAttachmentEditor(attachment); } catch (error) { setStatus(error.message || "Не удалось открыть привязку", "error", 0); showError(error.message); }
    });
    const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×"; remove.title = "Удалить PNG";
    remove.addEventListener("click", () => {
      state.attachments = state.attachments.filter((entry) => entry.id !== attachment.id);
      renderAttachmentList(); markPreviewDirty(); scheduleFramePreview(0);
    });
    actions.append(toggle, edit, remove);
    item.append(image, text, actions); list.append(item);
  }
  updateFinishingSummary();
}

function updateAttachmentPointStatus() {
  const needed = state.attachmentPointCount;
  const count = state.attachmentPoints.length;
  $("#attachmentPointStatus").textContent = count >= needed ? "точки готовы" : count === 0 ? "поставьте точку A" : "поставьте точку B";
  $("#attachmentEditorStatus").textContent = state.attachmentAsset
    ? `${state.attachmentAsset.title} · ${count}/${needed} точек`
    : "PNG не выбран";
  $("#saveAttachment").disabled = !state.attachmentAsset || count < needed;
}

function drawAttachmentEditor() {
  const canvas = $("#attachmentCanvas");
  const source = state.attachmentSourceImage;
  if (!source || !canvas.width || !canvas.height) return;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  if (state.attachmentPoints.length && state.attachmentAssetImage) {
    const first = state.attachmentPoints[0];
    const second = state.attachmentPoints[1];
    const centerX = (second ? (first.x + second.x) / 2 : first.x) * canvas.width;
    const centerY = (second ? (first.y + second.y) / 2 : first.y) * canvas.height;
    const targetWidth = canvas.width * (Number($("#attachmentSize").value) || 22) / 100;
    const targetHeight = targetWidth * state.attachmentAssetImage.naturalHeight / Math.max(1, state.attachmentAssetImage.naturalWidth);
    const rotation = (Number($("#attachmentRotation").value) || 0) * Math.PI / 180;
    context.save();
    context.translate(centerX, centerY); context.rotate(rotation); context.globalAlpha = 0.9;
    context.drawImage(state.attachmentAssetImage, -targetWidth / 2, -targetHeight / 2, targetWidth, targetHeight);
    context.restore();
  }
  if (state.attachmentPoints.length === 2) {
    context.beginPath();
    context.moveTo(state.attachmentPoints[0].x * canvas.width, state.attachmentPoints[0].y * canvas.height);
    context.lineTo(state.attachmentPoints[1].x * canvas.width, state.attachmentPoints[1].y * canvas.height);
    context.strokeStyle = "rgba(200,223,111,.85)"; context.lineWidth = 2; context.setLineDash([7, 5]); context.stroke(); context.setLineDash([]);
  }
  state.attachmentPoints.forEach((point, index) => {
    const x = point.x * canvas.width; const y = point.y * canvas.height;
    context.beginPath(); context.arc(x, y, 10, 0, Math.PI * 2); context.fillStyle = index ? "#c8df6f" : "#ff7617"; context.fill();
    context.strokeStyle = "#0b0e12"; context.lineWidth = 3; context.stroke();
    context.fillStyle = "#11151a"; context.font = '700 10px "Bahnschrift"'; context.textAlign = "center"; context.textBaseline = "middle"; context.fillText(index ? "B" : "A", x, y + 0.5);
  });
  updateAttachmentPointStatus();
}

async function openAttachmentEditor(existing = null) {
  if (!state.source || state.busy || state.source.kind === "video-batch") return;
  const asset = existing || await window.spriteLab.chooseOverlay();
  if (!asset) return;
  const referenceFrame = existing?.frameIndex ?? activeMaskFrameIndex();
  const framePath = state.result?.allSourceFramePaths?.[referenceFrame] || currentFramePath();
  if (!framePath) throw new Error("Сначала выберите исходный кадр.");
  await requestFramePreview(framePath);
  const resolvedFrameUrl = state.framePreview?.beforeUrl || state.source.previewUrl;
  const [sourceImage, assetImage] = await Promise.all([
    loadUiImage(resolvedFrameUrl, "Не удалось загрузить опорный кадр."),
    loadUiImage(asset.url, "Не удалось загрузить PNG-элемент."),
  ]);
  state.attachmentAsset = asset;
  state.attachmentSourceImage = sourceImage;
  state.attachmentAssetImage = assetImage;
  state.attachmentEditingId = existing?.id || null;
  state.attachmentReferenceFrame = referenceFrame;
  state.attachmentPoints = existing?.points?.map((point) => ({ ...point })) || [];
  state.attachmentPointCount = existing?.points?.length === 2 ? 2 : 1;
  const size = Math.round((existing?.sizeRatio || 0.22) * 100);
  const rotation = Number(existing?.rotation) || 0;
  $("#attachmentSize").value = String(size); $("#attachmentSizeValue").textContent = `${size}%`;
  $("#attachmentRotation").value = String(rotation); $("#attachmentRotationValue").textContent = `${rotation}°`;
  $$("#attachmentPointMode button").forEach((button) => button.classList.toggle("selected", Number(button.dataset.points) === state.attachmentPointCount));
  $("#attachmentTitle").textContent = existing ? "Перенастройте привязку" : "Прикрепите элемент к движению";
  $("#saveAttachment").textContent = existing ? "Сохранить привязку" : "Добавить к анимации";
  $("#attachmentAsset").innerHTML = `<img src="${asset.url}" alt=""><div><strong></strong><small>${asset.width}×${asset.height}${asset.hasAlpha ? " · прозрачность есть" : " · без прозрачности"}</small></div>`;
  $("#attachmentAsset strong").textContent = asset.title;
  const scale = Math.min(1, 1600 / Math.max(sourceImage.naturalWidth, sourceImage.naturalHeight));
  const canvas = $("#attachmentCanvas");
  canvas.width = Math.max(1, Math.round(sourceImage.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceImage.naturalHeight * scale));
  drawAttachmentEditor();
  $("#attachmentModal").classList.remove("hidden");
}

function closeAttachmentEditor() {
  state.attachmentAsset = null; state.attachmentSourceImage = null; state.attachmentAssetImage = null; state.attachmentPoints = []; state.attachmentEditingId = null; state.attachmentReferenceFrame = 0;
  $("#attachmentModal").classList.add("hidden");
  $("#addAttachment").focus();
}

function saveAttachment() {
  if (!state.attachmentAsset || state.attachmentPoints.length < state.attachmentPointCount) return;
  const points = state.attachmentPoints.slice(0, state.attachmentPointCount).map((point) => ({ ...point }));
  const first = points[0]; const second = points[1];
  const nextAttachment = {
    id: state.attachmentEditingId || `attachment-${Date.now()}-${state.attachments.length}`,
    ...state.attachmentAsset,
    frameIndex: state.attachmentReferenceFrame, points,
    sizeRatio: Number($("#attachmentSize").value) / 100,
    rotation: Number($("#attachmentRotation").value) || 0,
    anchorX: 0.5, anchorY: 0.5,
    referenceDistance: second ? Math.hypot(second.x - first.x, second.y - first.y) : 0,
    referenceAngle: second ? Math.atan2(second.y - first.y, second.x - first.x) * 180 / Math.PI : 0,
    enabled: state.attachmentEditingId ? state.attachments.find((attachment) => attachment.id === state.attachmentEditingId)?.enabled !== false : true,
  };
  if (state.attachmentEditingId) state.attachments = state.attachments.map((attachment) => attachment.id === state.attachmentEditingId ? nextAttachment : attachment);
  else state.attachments.push(nextAttachment);
  closeAttachmentEditor(); renderAttachmentList(); markPreviewDirty(); scheduleFramePreview(0);
  setStatus("PNG добавлен · при сборке движение будет отслежено", "done", 0);
}

function setFrameEditorStatus(message, kind = "ready") {
  const status = $("#frameEditorStatus");
  status.className = `frame-editor-status ${kind}`;
  status.querySelector("strong").textContent = message;
}

async function refreshExternalEdit({ force = false } = {}) {
  if (!state.externalEdit) return;
  try {
    const stats = await window.spriteLab.statFrameEdit(state.externalEdit.path);
    if (!force && stats.modifiedAt <= state.externalEdit.modifiedAt + 1) return;
    state.externalEdit.modifiedAt = stats.modifiedAt;
    state.frameOverrides[state.externalEdit.frameIndex] = state.externalEdit.path;
    $("#frameEditorImage").src = `${state.externalEdit.url.split("?")[0]}?v=${Math.round(stats.modifiedAt)}`;
    setFrameEditorStatus("Изменения найдены и подхвачены", "changed");
    markPreviewDirty();
    await requestFramePreview(state.externalEdit.path);
    setStatus(`Кадр ${state.externalEdit.frameIndex + 1} обновлён · пересоберите анимацию`, "done", 0);
  } catch (error) {
    setFrameEditorStatus(error.message || "Не удалось проверить рабочую копию", "error");
  }
}

async function openFrameEditor() {
  if (!state.result?.allSourceFramePaths?.length || state.busy || state.source?.kind === "video-batch") return;
  const frameIndex = state.selectedFrameIndex;
  const sourcePath = state.frameOverrides[frameIndex] || state.result.allSourceFramePaths[frameIndex];
  const edit = await window.spriteLab.prepareFrameEdit({ sourcePath, frameIndex, existingPath: state.frameOverrides[frameIndex] });
  state.frameOverrides[frameIndex] = edit.path;
  state.externalEdit = { ...edit, frameIndex };
  $("#frameEditorImage").src = `${edit.url}?v=${Math.round(edit.modifiedAt)}`;
  $("#frameEditorBadge").textContent = `КАДР ${frameIndex + 1}`;
  $("#frameEditorPath").textContent = edit.path;
  $("#frameEditorPath").title = edit.path;
  setFrameEditorStatus("Рабочая копия готова");
  $("#frameEditorModal").classList.remove("hidden");
  clearInterval(state.externalEditTimer);
  state.externalEditTimer = setInterval(() => refreshExternalEdit(), 1200);
  $("#openDefaultEditor").focus();
}

function closeFrameEditor() {
  clearInterval(state.externalEditTimer);
  state.externalEditTimer = null;
  state.externalEdit = null;
  $("#frameEditorModal").classList.add("hidden");
  $("#editFrame").focus();
}

async function replaceExternalEdit() {
  if (!state.externalEdit) return;
  const replaced = await window.spriteLab.replaceFrameEdit({ path: state.externalEdit.path });
  if (!replaced) return;
  state.externalEdit = { ...state.externalEdit, ...replaced, modifiedAt: 0 };
  await refreshExternalEdit({ force: true });
}

function undoMaskStroke() {
  const relevant = state.maskEdits.filter((edit) => maskEditApplies(edit));
  const strokeId = relevant.at(-1)?.strokeId;
  if (strokeId == null) return;
  state.maskEdits = state.maskEdits.filter((edit) => edit.strokeId !== strokeId);
  redrawMaskCanvas();
}

function clearCurrentMaskStrokes() {
  state.maskEdits = state.maskEdits.filter((edit) => !maskEditApplies(edit));
  redrawMaskCanvas();
}

function toggleSelectedFrame() {
  if (!state.result || state.source?.kind === "video-batch") return;
  const sourceIndex = state.selectedFrameIndex;
  const automaticallySkipped = new Set([
    ...(state.result.skipped?.duplicateIndexes || []),
    ...(state.result.skipped?.emptyIndexes || []),
  ]);
  if (automaticallySkipped.has(sourceIndex)) return;
  const includedCount = state.result.allSourceFramePaths.reduce((count, _path, index) => (
    count + (!automaticallySkipped.has(index) && !state.excludedFrames.has(index) ? 1 : 0)
  ), 0);
  if (!state.excludedFrames.has(sourceIndex) && includedCount <= 1) {
    showError("Нельзя исключить последний рабочий кадр анимации.");
    return;
  }
  state.excludedFrames.has(sourceIndex) ? state.excludedFrames.delete(sourceIndex) : state.excludedFrames.add(sourceIndex);
  selectFrame(state.selectedFrameIndex);
  markPreviewDirty();
  setStatus("Список исключений изменён · пересоберите предпросмотр", "done", 0);
  savePreferences();
}

function updatePreview(result) {
  state.result = result;
  state.resultDirty = false;
  $("#previewFreshness").classList.add("hidden");
  $("#metaFrames").textContent = String(result.frameCount);
  $("#metaCell").textContent = `${result.cellWidth} × ${result.cellHeight}`;
  $("#metaGrid").textContent = `${result.columns} × ${result.rows}`;
  $("#metaAnchor").textContent = ({ ground: "Земля", center: "Центр", motion: "Движение" })[state.anchor] || state.anchor;
  showWarnings(result.warnings); buildFilmstrip(result);
  renderAttachmentList();
  $("#resultPreviewTabs").classList.remove("hidden");
  state.previewMode = result.previewUrl ? "animation" : "sheet";
  setPreviewMode(state.previewMode);
  if (result.allSourceFramePaths?.length) selectFrame(result.sourceFrameIndexes?.[0] ?? 0, false);
}

function updateComparePosition() {
  const value = Number($("#compareSlider").value);
  $("#compareAfterWrap").style.clipPath = `inset(0 ${100 - value}% 0 0)`;
  $("#compareDivider").style.left = `${value}%`;
}

function applyZoom() {
  const transform = `scale(${state.zoom})`;
  $("#previewImage").style.transform = transform;
  $("#compareBefore").style.transform = transform;
  $("#compareAfter").style.transform = transform;
  $("#zoomValue").textContent = `${Math.round(state.zoom * 100)}%`;
}

function changeZoom(delta) {
  state.zoom = Math.max(0.25, Math.min(4, Math.round((state.zoom + delta) * 4) / 4));
  applyZoom();
}

function cycleBackdrop() {
  const stage = $("#previewStage");
  stage.classList.remove("backdrop-light", "backdrop-dark");
  state.backdrop = (state.backdrop + 1) % 3;
  if (state.backdrop === 1) stage.classList.add("backdrop-light");
  if (state.backdrop === 2) stage.classList.add("backdrop-dark");
}

function setPreviewMode(mode) {
  state.previewMode = mode;
  $$(".preview-tabs button").forEach((button) => {
    const selected = button.dataset.preview === mode;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  $("#previewImage").classList.add("hidden"); $("#compareView").classList.add("hidden");
  const inspection = state.framePreview;
  let url = null;
  if (mode === "before") url = inspection?.beforeUrl;
  if (mode === "after") url = inspection?.afterUrl;
  if (mode === "animation") url = state.result?.previewUrl;
  if (mode === "sheet") url = state.result?.sheetUrl;
  if (mode === "compare" && inspection) {
    $("#previewEmpty").classList.add("hidden");
    $("#compareBefore").src = inspection.beforeUrl; $("#compareAfter").src = inspection.afterUrl;
    $("#compareView").classList.remove("hidden"); updateComparePosition(); applyZoom(); return;
  }
  if (!url) { $("#previewEmpty").classList.remove("hidden"); return; }
  $("#previewEmpty").classList.add("hidden");
  $("#previewImage").src = `${url}${url.includes("?") ? "&" : "?"}v=${Date.now()}`;
  $("#previewImage").classList.toggle("pixel", $("#pixelPerfect").checked);
    $("#previewImage").classList.remove("hidden");
  applyZoom();
}

async function requestFramePreview(inputPath) {
  if (!inputPath || state.busy) return;
  const token = ++state.quickToken;
  const revision = state.sourceRevision;
  try {
    const result = await window.spriteLab.previewFrame({ inputPath, options: collectOptions() });
    if (token !== state.quickToken || revision !== state.sourceRevision) return;
    state.framePreview = result;
    $("#framePreviewTabs").classList.remove("hidden");
    hideError();
    if (["before", "after", "compare"].includes(state.previewMode)) setPreviewMode(state.previewMode);
    else if (!state.result) setPreviewMode("after");
    if (!state.busy && state.keyMode === "ai") setStatus("Предпросмотр обработки обновлён", "done", 0);
    return result;
  } catch (error) {
    if (token === state.quickToken && revision === state.sourceRevision) {
      setStatus(error.message || "Не удалось обновить кадр", "error", 0);
      showError(error.message || "Не удалось обновить кадр.");
    }
    return null;
  }
}

function scheduleFramePreview(delay = 260) {
  clearTimeout(state.quickTimer);
  state.quickTimer = setTimeout(() => requestFramePreview(currentFramePath()), delay);
  savePreferences();
}

async function chooseSource(method) {
  if (state.busy) return;
  try {
    setStatus("Открываю источник…", "busy", 0.02);
    const source = await window.spriteLab[method]();
    if (source) setSource(source);
    else setStatus(state.source ? `Источник загружен · ${state.source.detail}` : "Готов к работе", state.source ? "done" : "idle", 0);
  } catch (error) { setStatus(error.message || "Не удалось открыть источник", "error", 0); showError(error.message); }
}

async function runBuild(previewOnly) {
  if (!state.source || state.busy || (!previewOnly && !state.outputFolder)) return;
  state.busy = true; updateActionState();
  setStatus(previewOnly ? "Собираю предпросмотр…" : "Экспортирую набор…", "busy", 0.02);
  try {
    const result = await window.spriteLab.build({
      source: state.source, outputDir: previewOnly ? null : state.outputFolder,
      name: state.source.kind === "video-batch" ? null : $("#spriteName").value, options: collectOptions(), previewOnly,
    });
    if (result.batch) {
      state.lastExportDir = result.outputDir;
      state.lastRevealPath = result.revealPath;
      const failureText = result.failed ? ` · с ошибкой: ${result.failed}` : "";
      setStatus(`Готово · ${result.completed}/${result.total} видео${failureText}`, result.failed ? "error" : "done", 1);
      $("#exportSummary").textContent = result.failed
        ? `Готово наборов: ${result.completed} из ${result.total}. Не обработано: ${result.failures.map((item) => item.name).join(", ")}.`
        : `Готово: ${result.completed} наборов. Каждый ролик сохранён в отдельной папке с автоматическим именем.`;
      $("#exportSummary").classList.remove("hidden");
      $("#completionActions").classList.remove("hidden");
      if ($("#openAfterExport").checked && result.revealPath) window.spriteLab.revealOutput(result.revealPath);
      hideError();
      return;
    }
    updatePreview(result); hideError(); setStatus(`Готово · ${result.frameCount} кадров`, "done", 1);
    if (!previewOnly) {
      state.lastExportDir = result.outputDir;
      state.lastRevealPath = result.revealPath;
      const exported = collectExports();
      const details = [`${result.frameCount} кадров`];
      if (exported.sheet || exported.metadata) details.push(`лист ${result.cellWidth * result.columns} × ${result.cellHeight * result.rows}`);
      if (exported.frames) details.push("отдельные PNG");
      if (exported.preview) details.push("WebP-превью");
      $("#exportSummary").textContent = `Готово: ${details.join(" · ")}`;
      $("#exportSummary").classList.remove("hidden");
      $("#completionActions").classList.remove("hidden");
      if ($("#openAfterExport").checked && result.revealPath) window.spriteLab.revealOutput(result.revealPath);
    }
  } catch (error) {
    const cancelled = /отмен|abort/i.test(error.message || "");
    setStatus(cancelled ? "Обработка остановлена" : error.message || "Ошибка обработки", cancelled ? "idle" : "error", 0);
    if (!cancelled) showError(error.message || "Не удалось завершить обработку.");
  } finally {
    state.busy = false; updateActionState(); $("#cancelJob").classList.add("hidden");
  }
}

function savePreferences() {
  try {
    const controls = ["fps", "columns", "cellWidth", "cellHeight", "padding", "maxFrames", "tolerance", "blackOutline", "blackFeather", "aiCutoff", "aiSoftness", "fringeStrength"];
    const checks = ["autoSize", "autoColumns", "pixelPerfect", "removeDuplicates", "whiteOutput", "openAfterExport", "fringeCleanup"];
    localStorage.setItem("spriteLab.preferences", JSON.stringify({
      schema: 3,
      keyMode: state.keyMode, anchor: state.anchor, outputFolder: state.outputFolder,
      values: Object.fromEntries(controls.map((id) => [id, $(`#${id}`).value])),
      checks: Object.fromEntries(checks.map((id) => [id, $(`#${id}`).checked])),
    }));
  } catch { /* Preferences are optional. */ }
}

function loadPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem("spriteLab.preferences") || "null");
    if (!saved) return;
    Object.entries(saved.values || {}).forEach(([id, value]) => { if ($(`#${id}`)) $(`#${id}`).value = value; });
    if (Number(saved.schema || 0) < 2) $("#aiSoftness").value = "0";
    $("#toleranceValue").textContent = $("#tolerance").value;
    $("#blackOutlineValue").textContent = `${$("#blackOutline").value} px`;
    $("#blackFeatherValue").textContent = `${$("#blackFeather").value} px`;
    $("#aiCutoffValue").textContent = $("#aiCutoff").value;
    $("#aiSoftnessValue").textContent = `${$("#aiSoftness").value} px`;
    $("#fringeStrengthValue").textContent = $("#fringeStrength").value;
    Object.entries(saved.checks || {}).forEach(([id, value]) => { if ($(`#${id}`)) $(`#${id}`).checked = Boolean(value); });
    $("#fringeStrengthRow").classList.toggle("hidden", !$("#fringeCleanup").checked);
    if (saved.keyMode) setKeyMode(saved.keyMode);
    if (saved.anchor) setAnchor(saved.anchor);
    if (saved.outputFolder) {
      state.outputFolder = saved.outputFolder; $("#outputFolder").textContent = saved.outputFolder; $("#outputFolder").title = saved.outputFolder;
    }
  } catch { /* Ignore invalid old settings. */ }
}

$$(".tab").forEach((button) => button.addEventListener("click", () => setTab(button.dataset.tab)));
$$(".tab").forEach((button, index, tabs) => button.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const nextIndex = event.key === "Home" ? 0
    : event.key === "End" ? tabs.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  tabs[nextIndex].focus();
  setTab(tabs[nextIndex].dataset.tab);
}));
$("#chooseSource").addEventListener("click", () => chooseSource("chooseSource"));
$("#chooseFolder").addEventListener("click", () => chooseSource("chooseFolder"));
$("#chooseSheet").addEventListener("click", () => chooseSource("chooseSheet"));
$("#sheetSliceMode").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-sheet-mode]");
  if (!button) return;
  $$("#sheetSliceMode button").forEach((item) => item.classList.toggle("selected", item === button));
  $("#sheetGridFields").classList.toggle("hidden", button.dataset.sheetMode !== "grid");
});
$("#resliceSheet").addEventListener("click", async () => {
  if (!state.source?.sheetPath || state.busy) return;
  const mode = $("#sheetSliceMode button.selected")?.dataset.sheetMode || "objects";
  try {
    setStatus("Ищу отдельные объекты на листе…", "busy", 0.1);
    const source = await window.spriteLab.resliceSheet({
      sheetPath: state.source.sheetPath,
      options: { mode, columns: Number($("#sheetColumns").value), rows: Number($("#sheetRows").value) },
    });
    setSource(source);
  } catch (error) { setStatus(error.message || "Не удалось перенарезать лист", "error", 0); showError(error.message); }
});
$("#sheetFitEach").addEventListener("change", () => { markPreviewDirty(); });
$("#dropZone").addEventListener("click", () => chooseSource("chooseSource"));
$("#dropZone").addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") chooseSource("chooseSource"); });
$("#clearSource").addEventListener("click", () => setSource(null));
$("#newSource").addEventListener("click", () => { setSource(null); setTab("source"); });
$("#applyRecommendations").addEventListener("click", applyRecommendations);
$("#manualSetup").addEventListener("click", () => setTab("process"));
for (const eventName of ["dragenter", "dragover"]) $("#dropZone").addEventListener(eventName, (event) => { event.preventDefault(); $("#dropZone").classList.add("dragging"); });
for (const eventName of ["dragleave", "drop"]) $("#dropZone").addEventListener(eventName, (event) => { event.preventDefault(); $("#dropZone").classList.remove("dragging"); });
$("#dropZone").addEventListener("drop", async (event) => {
  try {
    setStatus("Проверяю перетащённые файлы…", "busy", 0.02);
    const source = await window.spriteLab.inspectDropped(event.dataTransfer.files);
    if (source) setSource(source);
  } catch (error) { setStatus(error.message || "Формат не поддерживается", "error", 0); }
});

$("#keyMode").addEventListener("click", (event) => { const button = event.target.closest("button[data-value]"); if (button) { setKeyMode(button.dataset.value); scheduleFramePreview(); } });
$("#anchorMode").addEventListener("click", (event) => { const button = event.target.closest("button[data-value]"); if (button) { setAnchor(button.dataset.value); savePreferences(); } });
$("#processPresets").addEventListener("click", (event) => { const button = event.target.closest("button[data-preset]"); if (button) applyProcessPreset(button.dataset.preset); });
$("#resetSettings").addEventListener("click", resetRecommended);
$("#tolerance").addEventListener("input", (event) => { $("#toleranceValue").textContent = event.target.value; markPreviewDirty(); scheduleFramePreview(); });
$("#blackOutline").addEventListener("input", (event) => { $("#blackOutlineValue").textContent = event.target.value; markPreviewDirty(); scheduleFramePreview(); });
$("#blackFeather").addEventListener("input", (event) => { $("#blackFeatherValue").textContent = `${event.target.value} px`; markPreviewDirty(); scheduleFramePreview(); });
$("#aiCutoff").addEventListener("input", (event) => { $("#aiCutoffValue").textContent = event.target.value; markPreviewDirty(); scheduleFramePreview(380); });
$("#aiSoftness").addEventListener("input", (event) => { $("#aiSoftnessValue").textContent = `${event.target.value} px`; markPreviewDirty(); scheduleFramePreview(380); });
$("#fringeCleanup").addEventListener("change", (event) => {
  $("#fringeStrengthRow").classList.toggle("hidden", !event.target.checked);
  updateFinishingSummary();
  markPreviewDirty(); scheduleFramePreview(0); savePreferences();
});
$("#fringeStrength").addEventListener("input", (event) => {
  $("#fringeStrengthValue").textContent = event.target.value;
  markPreviewDirty(); scheduleFramePreview(240); savePreferences();
});
$("#openMaskEditor").addEventListener("click", async () => {
  try { await openMaskEditor(); } catch (error) { setStatus(error.message || "Не удалось открыть редактор маски", "error", 0); showError(error.message); }
});
$("#clearMaskEdits").addEventListener("click", () => {
  state.maskEdits = []; updateMaskEditSummary(); markPreviewDirty(); scheduleFramePreview(0);
});
$("#maskBrushMode").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-mode]");
  if (!button) return;
  setMaskTool(button.dataset.mode);
});
$("#maskBrushSize").addEventListener("input", (event) => { $("#maskBrushSizeValue").textContent = `${event.target.value} px`; });
$("#smartRegionTolerance").addEventListener("input", (event) => { $("#smartRegionToleranceValue").textContent = event.target.value; });
$("#maskCanvas").addEventListener("pointerdown", (event) => {
  event.preventDefault();
  if (state.maskBrushMode === "smart") {
    selectTrackedRegion(event);
    return;
  }
  state.maskDrawing = true;
  state.maskStrokeId += 1;
  event.currentTarget.setPointerCapture(event.pointerId);
  addMaskPoint(event);
});
$("#maskCanvas").addEventListener("pointermove", addMaskPoint);
for (const eventName of ["pointerup", "pointercancel"]) $("#maskCanvas").addEventListener(eventName, () => { state.maskDrawing = false; });
$("#undoMaskStroke").addEventListener("click", undoMaskStroke);
$("#resetMaskStrokes").addEventListener("click", clearCurrentMaskStrokes);
$("#closeMaskEditor").addEventListener("click", () => closeMaskEditor({ discard: true }));
$("#cancelMaskEditor").addEventListener("click", () => closeMaskEditor({ discard: true }));
$("#applyMaskEditor").addEventListener("click", () => {
  closeMaskEditor(); markPreviewDirty(); setStatus("Исправления маски применены · проверяю кадр", "busy", 0.1); scheduleFramePreview(0);
});
$("#aiMaskModal").addEventListener("click", (event) => { if (event.target === $("#aiMaskModal")) closeMaskEditor({ discard: true }); });
$("#addAttachment").addEventListener("click", async () => {
  try { await openAttachmentEditor(); } catch (error) { showError(error.message || "Не удалось открыть PNG-элемент."); }
});
$("#attachmentPointMode").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-points]");
  if (!button) return;
  state.attachmentPointCount = Number(button.dataset.points) === 2 ? 2 : 1;
  state.attachmentPoints = state.attachmentPoints.slice(0, state.attachmentPointCount);
  $$("#attachmentPointMode button").forEach((item) => item.classList.toggle("selected", item === button));
  drawAttachmentEditor();
});
$("#attachmentCanvas").addEventListener("pointerdown", (event) => {
  event.preventDefault();
  const canvas = event.currentTarget; const rect = canvas.getBoundingClientRect();
  const point = {
    x: Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width))),
    y: Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height))),
  };
  if (state.attachmentPointCount === 1) state.attachmentPoints = [point];
  else if (state.attachmentPoints.length >= 2) state.attachmentPoints = [point];
  else state.attachmentPoints.push(point);
  drawAttachmentEditor();
});
$("#attachmentSize").addEventListener("input", (event) => { $("#attachmentSizeValue").textContent = `${event.target.value}%`; drawAttachmentEditor(); });
$("#attachmentRotation").addEventListener("input", (event) => { $("#attachmentRotationValue").textContent = `${event.target.value}°`; drawAttachmentEditor(); });
$("#resetAttachmentPoints").addEventListener("click", () => { state.attachmentPoints = []; drawAttachmentEditor(); });
$("#saveAttachment").addEventListener("click", saveAttachment);
$("#closeAttachmentEditor").addEventListener("click", closeAttachmentEditor);
$("#cancelAttachmentEditor").addEventListener("click", closeAttachmentEditor);
$("#attachmentModal").addEventListener("click", (event) => { if (event.target === $("#attachmentModal")) closeAttachmentEditor(); });
$("#autoSize").addEventListener("change", () => { syncAutoSize(); savePreferences(); });
$("#autoColumns").addEventListener("change", () => { syncAutoSize(); savePreferences(); });
$("#buildPreview").addEventListener("click", () => runBuild(true));
$("#excludeFrame").addEventListener("click", toggleSelectedFrame);
$("#editFrame").addEventListener("click", async () => {
  try { await openFrameEditor(); } catch (error) { setStatus(error.message || "Не удалось подготовить кадр", "error", 0); showError(error.message); }
});
$("#openDefaultEditor").addEventListener("click", async () => {
  if (!state.externalEdit) return;
  try { await window.spriteLab.openFrameEdit({ path: state.externalEdit.path, mode: "default" }); setFrameEditorStatus("Кадр открыт · сохраните его через Ctrl+S", "busy"); }
  catch (error) { setFrameEditorStatus(error.message || "Не удалось открыть редактор", "error"); }
});
$("#openWithEditor").addEventListener("click", async () => {
  if (!state.externalEdit) return;
  try { await window.spriteLab.openFrameEdit({ path: state.externalEdit.path, mode: "open-with" }); setFrameEditorStatus("Выберите приложение и сохраните кадр", "busy"); }
  catch (error) { setFrameEditorStatus(error.message || "Не удалось открыть список приложений", "error"); }
});
$$("[data-online-editor]").forEach((button) => button.addEventListener("click", async () => {
  if (!state.externalEdit) return;
  try {
    await window.spriteLab.openOnlineFrameEditor({ path: state.externalEdit.path, editor: button.dataset.onlineEditor });
    setFrameEditorStatus("Редактор открыт · путь к PNG скопирован", "busy");
  } catch (error) { setFrameEditorStatus(error.message || "Не удалось открыть онлайн-редактор", "error"); }
}));
$("#replaceEditedFrame").addEventListener("click", async () => {
  try { await replaceExternalEdit(); } catch (error) { setFrameEditorStatus(error.message || "Не удалось заменить кадр", "error"); }
});
$("#applyEditedFrame").addEventListener("click", () => { closeFrameEditor(); runBuild(true); });
$("#closeFrameEditor").addEventListener("click", closeFrameEditor);
$("#frameEditorModal").addEventListener("click", (event) => { if (event.target === $("#frameEditorModal")) closeFrameEditor(); });
$("#compareSlider").addEventListener("input", updateComparePosition);

$("#trimStartRange").addEventListener("input", (event) => { $("#trimStart").value = Number(event.target.value).toFixed(2); updateTimeline(); });
$("#trimEndRange").addEventListener("input", (event) => { $("#trimEnd").value = Number(event.target.value).toFixed(2); updateTimeline(false); });
$("#trimStart").addEventListener("input", () => updateTimeline());
$("#trimEnd").addEventListener("input", () => updateTimeline(false));
$("#resetTrim").addEventListener("click", () => { configureTimeline(state.source); if (state.source?.kind === "video") schedulePoster(0); });

$("#chooseOutput").addEventListener("click", async () => {
  const folder = await window.spriteLab.chooseOutput();
  if (!folder) return;
  state.outputFolder = folder; state.lastExportDir = null;
  state.lastRevealPath = null;
  $("#outputFolder").textContent = folder; $("#outputFolder").title = folder;
  $("#completionActions").classList.add("hidden"); $("#exportSummary").classList.add("hidden");
  updateActionState(); savePreferences();
});
$("#exportSprites").addEventListener("click", () => runBuild(false));
$("#revealOutput").addEventListener("click", () => { if (state.lastRevealPath) window.spriteLab.revealOutput(state.lastRevealPath); });
$("#copyOutputPath").addEventListener("click", async () => {
  if (!state.lastExportDir) return;
  await window.spriteLab.copyOutputPath(state.lastExportDir);
  $("#copyOutputPath").textContent = "Путь скопирован";
  setTimeout(() => { $("#copyOutputPath").textContent = "Скопировать путь"; }, 1400);
});
$("#exportPreset").addEventListener("change", (event) => applyExportPreset(event.target.value));
Object.entries(exportControls).forEach(([name, selector]) => $(selector).addEventListener("change", () => syncExportDependencies(name)));
$("#spriteName").addEventListener("input", () => {
  state.lastExportDir = null; state.lastRevealPath = null;
  $("#completionActions").classList.add("hidden"); $("#exportSummary").classList.add("hidden");
  updateActionState();
});

$$(".preview-tabs button").forEach((button) => button.addEventListener("click", () => setPreviewMode(button.dataset.preview)));
$("#cancelJob").addEventListener("click", () => window.spriteLab.cancelBuild());
$("#zoomOut").addEventListener("click", () => changeZoom(-0.25));
$("#zoomIn").addEventListener("click", () => changeZoom(0.25));
$("#zoomFit").addEventListener("click", () => { state.zoom = 1; applyZoom(); });
$("#toggleGuides").addEventListener("click", () => {
  state.guides = !state.guides;
  $("#guideLayer").classList.toggle("hidden", !state.guides);
  $("#toggleGuides").classList.toggle("active", state.guides);
});
$("#cycleBackdrop").addEventListener("click", cycleBackdrop);
$("#closeError").addEventListener("click", hideError);
$("#safeSettings").addEventListener("click", () => { resetRecommended(); hideError(); });
$("#showErrorFrame").addEventListener("click", () => { hideError(); if (state.result) selectFrame(state.selectedFrameIndex); });
$("#minimizeWindow").addEventListener("click", () => window.spriteLab.minimize());
$("#maximizeWindow").addEventListener("click", () => window.spriteLab.maximize());
$("#closeWindow").addEventListener("click", () => window.spriteLab.close());
$("#aboutApp").addEventListener("click", openAbout);
$("#closeAbout").addEventListener("click", closeAbout);
$("#aboutModal").addEventListener("click", (event) => { if (event.target === $("#aboutModal")) closeAbout(); });
$("#checkUpdates").addEventListener("click", checkForUpdates);
$("#openRepository").addEventListener("click", () => window.spriteLab.openRepository());
for (const id of ["fps", "columns", "cellWidth", "cellHeight", "padding", "maxFrames", "pixelPerfect", "removeDuplicates", "whiteOutput", "trimStart", "trimEnd"]) {
  $(`#${id}`).addEventListener("change", () => { markPreviewDirty(); savePreferences(); });
}
$("#openAfterExport").addEventListener("change", savePreferences);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#frameEditorModal").classList.contains("hidden")) { closeFrameEditor(); return; }
  if (event.key === "Escape" && !$("#attachmentModal").classList.contains("hidden")) { closeAttachmentEditor(); return; }
  if (event.key === "Escape" && !$("#aiMaskModal").classList.contains("hidden")) { closeMaskEditor({ discard: true }); return; }
  if (event.key === "Escape" && !$("#aboutModal").classList.contains("hidden")) { closeAbout(); return; }
  if (event.key === "Escape" && state.busy) window.spriteLab.cancelBuild();
  if (event.ctrlKey && event.key === "Enter") { event.preventDefault(); runBuild(true); }
  if (event.ctrlKey && event.key.toLowerCase() === "o") { event.preventDefault(); chooseSource("chooseSource"); }
});

window.spriteLab.onProgress((progress) => { if (state.busy) setStatus(progress.message || "Обработка…", "busy", progress.value || 0); });
window.spriteLab.onUpdateProgress((progress) => {
  const status = $("#updateStatus");
  status.className = progress.value >= 1 ? "update-status success" : "update-status busy";
  status.textContent = progress.message || "Проверяю обновления…";
});

$$("button.selected").forEach((button) => button.setAttribute("aria-pressed", "true"));
loadPreferences(); syncAutoSize(); updateMaskEditSummary(); renderAttachmentList(); updateActionState(); syncExportDependencies(""); setPreviewMode("after"); setStatus("Готов к работе");
window.spriteLab.getAppInfo().then((info) => {
  $("#versionBadge").textContent = info.version;
  $("#aboutVersion").textContent = info.version;
}).catch(() => {});
