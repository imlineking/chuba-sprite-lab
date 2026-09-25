const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  source: null, outputFolder: null, result: null, previewMode: "after", keyMode: "auto", anchor: "ground", auxMaskPath: null,
  busy: false, lastExportDir: null, lastRevealPath: null, framePreview: null, selectedFrameIndex: 0,
  excludedFrames: new Set(), quickTimer: null, quickToken: 0,
  zoom: 1, guides: false, backdrop: "checker", backdropBeforeGame: "checker", timelineValid: true, sourceRevision: 0, resultDirty: false,
  maskEdits: [], maskBrushMode: "smart", maskDrawing: false, maskStrokeId: 0,
  maskEditorSnapshot: [], maskEditorImage: null, maskEditorPixels: null,
  attachments: [], attachmentAsset: null, attachmentSourceImage: null, attachmentAssetImage: null,
  attachmentPoints: [], attachmentPointCount: 1, attachmentEditingId: null, attachmentReferenceFrame: 0,
  frameOverrides: {}, externalEdit: null, externalEditTimer: null,
  solidKeyMode: "black", projectPath: null, history: [], historyIndex: -1, historyTimer: null, historyApplying: false,
  warnings: [], warningIndex: 0, warningRefs: new Map(), batchItems: [], pendingSession: null, preferredEditor: "photopea",
  viewportPanX: 0, viewportPanY: 0, spaceHand: false, handToolLocked: false, viewportPanning: false, panPointerId: null,
  frameTransforms: {}, transformScope: "frame", transformPanelOpen: false, sheetDraftCells: [],
  timeline: null, selectedEntryId: null, processPreset: "character", imageAlign: "ground",
  animations: [], activeAnimationId: null, animationSwitching: false, fitScale: 1,
};
let posterTimer = null;
let aboutReturnFocus = null;
let pendingUpdate = null;
let modalReturnFocus = null;
let customExportProfiles = {};

const exportControls = { sheet: "#exportSheet", frames: "#exportFrames", metadata: "#exportMetadata", preview: "#exportPreview" };
const exportNames = { sheet: "спрайт-лист", frames: "кадры", metadata: "JSON", preview: "WebP" };
const exportPresets = {
  chuba: { sheet: true, frames: true, metadata: true, preview: true },
  sheet: { sheet: true, frames: false, metadata: false, preview: false },
  frames: { sheet: false, frames: true, metadata: false, preview: false },
  artist: { sheet: false, frames: true, metadata: false, preview: true },
  engine: { sheet: true, frames: false, metadata: true, preview: false },
};
const preferenceValueIds = ["fps", "columns", "cellWidth", "cellHeight", "padding", "maxFrames", "tolerance", "keyScope", "blackOutline", "blackFeather", "aiCutoff", "aiSoftness", "aiProvider", "aiQuality", "fringeStrength", "edgeRefineMode", "edgeRefineWidth", "edgeRefineDepth", "trimStart", "trimEnd", "pixelateSize", "pixelateColors", "pixelateShading", "pixelatePalette", "pixelateMode", "pixelateDither", "toningColor", "toningStrength", "locale"];
const preferenceCheckIds = ["autoSize", "autoColumns", "pixelPerfect", "removeDuplicates", "whiteOutput", "openAfterExport", "fringeCleanup", "edgeDecontaminate", "edgeRefineWhiteOnly", "aiAutoCutoff", "pixelateEnabled", "toningEnabled", "sheetFitEach", "auxRife", "auxEsrgan", "auxDepth"];

function sourceDescriptor(source = state.source) {
  if (!source) return null;
  return {
    kind: source.kind,
    paths: source.kind === "sheet" ? [source.sheetPath] : [...(source.paths || [])],
    sheetPath: source.sheetPath || null,
    sheetMode: source.sheetMode || null,
    sheetOptions: source.kind === "sheet" ? {
      mode: $("#sheetSliceMode button.selected")?.dataset.sheetMode || source.sheetMode || "objects",
      columns: Number($("#sheetColumns").value) || 4,
      rows: Number($("#sheetRows").value) || 4,
      cells: state.sheetDraftCells.map((cell) => ({ ...cell })),
    } : null,
  };
}

function captureControlState() {
  return {
    values: Object.fromEntries(preferenceValueIds.map((id) => [id, $(`#${id}`).value])),
    checks: Object.fromEntries(preferenceCheckIds.map((id) => [id, $(`#${id}`).checked])),
    exports: collectExports(),
    keyMode: state.keyMode,
    solidKeyMode: state.solidKeyMode,
    anchor: state.anchor,
    preset: state.processPreset,
    auxMaskPath: state.auxMaskPath,
    studio: captureStudioControls(),
  };
}

// Studio (1.7) controls that live outside the legacy value/check lists.
function captureStudioControls() {
  return {
    loopMode: $("#loopMode button.selected")?.dataset.loop || "loop",
    loopFrom: $("#loopFrom").value, loopTo: $("#loopTo").value,
    packing: $("#atlasPacking").value, exportFormat: $("#exportFormat").value,
    atlasMaxSize: $("#atlasMaxSize").value, atlasOverflow: $("#atlasOverflow").value, atlasPowerOfTwo: $("#atlasPowerOfTwo").checked,
    imageAlign: state.imageAlign,
  };
}

function applyStudioControls(studio = {}) {
  if (studio.imageAlign && typeof setImageAlign === "function") setImageAlign(studio.imageAlign, { silent: true });
  if (studio.packing) $("#atlasPacking").value = studio.packing;
  if (studio.exportFormat) $("#exportFormat").value = studio.exportFormat;
  if (studio.atlasMaxSize != null) $("#atlasMaxSize").value = String(studio.atlasMaxSize);
  if (studio.atlasOverflow) $("#atlasOverflow").value = studio.atlasOverflow;
  $("#atlasPowerOfTwo").checked = studio.atlasPowerOfTwo === true;
  $("#loopFrom").value = studio.loopFrom || "1";
  $("#loopTo").value = studio.loopTo || "";
  if (typeof setLoopMode === "function") setLoopMode(studio.loopMode || "loop", { silent: true });
}

function buildAnimationDocument() {
  return {
    format: "chuba-sprite-lab-project",
    version: 1,
    name: $("#spriteName").value || state.source?.title || "sprite-project",
    source: sourceDescriptor(),
    outputFolder: state.outputFolder,
    controls: captureControlState(),
    spriteName: $("#spriteName").value,
    excludedFrames: [...state.excludedFrames],
    maskEdits: state.maskEdits,
    attachments: state.attachments,
    frameOverrides: state.frameOverrides,
    frameTransforms: state.frameTransforms,
    timeline: state.timeline ? structuredClone(state.timeline) : null,
    preferredEditor: state.preferredEditor,
  };
}

// The top-level fields always describe the active animation, so older versions
// of Sprite Lab still open the file; extra animations live in "animations".
function buildProjectDocument() {
  const project = buildAnimationDocument();
  if (state.animations.length) {
    project.animations = state.animations.map((animation) => ({
      id: animation.id,
      name: animation.name,
      document: animation.id === state.activeAnimationId ? buildAnimationDocument() : animation.document,
    }));
    project.activeAnimationId = state.activeAnimationId;
  }
  return project;
}

function saveSessionSoon() {
  clearTimeout(state.sessionTimer);
  state.sessionTimer = setTimeout(() => {
    try {
      if (!state.source) localStorage.removeItem("spriteLab.session");
      else localStorage.setItem("spriteLab.session", JSON.stringify(buildProjectDocument()));
    } catch { /* Session recovery is optional. */ }
  }, 450);
}

function applyControlState(controls = {}) {
  state.historyApplying = true;
  Object.entries(controls.values || {}).forEach(([id, value]) => { if ($(`#${id}`)) $(`#${id}`).value = value; });
  Object.entries(controls.checks || {}).forEach(([id, value]) => { if ($(`#${id}`)) $(`#${id}`).checked = Boolean(value); });
  Object.entries(controls.exports || {}).forEach(([name, value]) => { const selector = exportControls[name]; if (selector) $(selector).checked = Boolean(value); });
  state.auxMaskPath = controls.auxMaskPath || null;
  $("#lamaMaskName").textContent = state.auxMaskPath ? `Маска: ${state.auxMaskPath.split(/[\\/]/).at(-1)}` : "Маска не выбрана";
  $("#clearLamaMask").classList.toggle("hidden", !state.auxMaskPath);
  state.solidKeyMode = controls.solidKeyMode || (controls.keyMode && !["auto", "alpha", "ai"].includes(controls.keyMode) ? controls.keyMode : "black");
  setKeyMode(controls.keyMode || "auto");
  setAnchor(controls.anchor || "ground");
  if (controls.preset) markProcessPreset(controls.preset);
  applyStudioControls(controls.studio || {});
  syncAutoSize();
  $("#toleranceValue").textContent = $("#tolerance").value;
  $("#blackOutlineValue").textContent = $("#blackOutline").value;
  $("#blackFeatherValue").textContent = `${$("#blackFeather").value} px`;
  $("#aiCutoffValue").textContent = $("#aiCutoff").value;
  $("#aiSoftnessValue").textContent = `${$("#aiSoftness").value} px`;
  $("#fringeStrengthValue").textContent = $("#fringeStrength").value;
  $("#fringeStrengthRow").classList.toggle("hidden", !$("#fringeCleanup").checked);
  state.historyApplying = false;
  if (state.source?.kind === "video") updateTimeline(false);
}

async function applyProjectDocument(project, source, projectPath = null, { keepAnimations = false } = {}) {
  setSource(source);
  state.projectPath = projectPath;
  state.timeline = Array.isArray(project.timeline) ? structuredClone(project.timeline) : null;
  if (!keepAnimations) {
    state.animations = Array.isArray(project.animations) ? project.animations.map((animation) => ({ id: animation.id, name: animation.name, document: animation.document || null })) : [];
    state.activeAnimationId = state.animations.length ? (project.activeAnimationId || state.animations[0].id) : null;
    if (typeof renderAnimationBar === "function") renderAnimationBar();
  }
  applyControlState(project.controls || {});
  state.excludedFrames = new Set(project.excludedFrames || []);
  state.maskEdits = structuredClone(project.maskEdits || []);
  state.attachments = structuredClone(project.attachments || []);
  state.frameOverrides = { ...(project.frameOverrides || {}) };
  state.frameTransforms = structuredClone(project.frameTransforms || {});
  state.outputFolder = project.outputFolder || null;
  state.preferredEditor = project.preferredEditor || "photopea";
  $("#preferredEditor").value = state.preferredEditor;
  if (project.source?.sheetOptions) {
    $("#sheetColumns").value = String(project.source.sheetOptions.columns || 4);
    $("#sheetRows").value = String(project.source.sheetOptions.rows || 4);
  }
  if (project.spriteName && state.source?.kind !== "video-batch") $("#spriteName").value = project.spriteName;
  $("#outputFolder").textContent = state.outputFolder || "Не выбрана";
  $("#outputFolder").title = state.outputFolder || "";
  updateMaskEditSummary(); renderAttachmentList(); updateActionState();
  if (typeof renderImageSheetControls === "function") renderImageSheetControls();
  initializeHistory("Проект открыт");
  setTab("process"); scheduleFramePreview(0); saveSessionSoon();
}

function captureHistoryState(label = "Изменение") {
  return {
    label,
    controls: captureControlState(),
    excludedFrames: [...state.excludedFrames],
    maskEdits: structuredClone(state.maskEdits),
    attachments: structuredClone(state.attachments),
    frameOverrides: { ...state.frameOverrides },
    frameTransforms: structuredClone(state.frameTransforms),
    timeline: state.timeline ? structuredClone(state.timeline) : null,
    sheetDraftCells: state.sheetDraftCells ? state.sheetDraftCells.map((cell) => ({ ...cell })) : [],
  };
}

function updateHistoryActions() {
  $("#undoAction").disabled = state.historyIndex <= 0;
  $("#redoAction").disabled = state.historyIndex < 0 || state.historyIndex >= state.history.length - 1;
  $("#undoAction").title = state.historyIndex > 0 ? `Отменить: ${state.history[state.historyIndex].label}` : "Нечего отменять";
  $("#redoAction").title = state.historyIndex < state.history.length - 1 ? `Повторить: ${state.history[state.historyIndex + 1].label}` : "Нечего повторять";
}

function initializeHistory(label = "Начальное состояние") {
  state.history = [captureHistoryState(label)]; state.historyIndex = 0; updateHistoryActions();
}

function pushHistory(label = "Изменение") {
  if (state.historyApplying || !state.source) return;
  const snapshot = captureHistoryState(label);
  const previous = state.history[state.historyIndex];
  if (previous && JSON.stringify({ ...previous, label: "" }) === JSON.stringify({ ...snapshot, label: "" })) return;
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push(snapshot);
  if (state.history.length > 60) state.history.shift();
  state.historyIndex = state.history.length - 1;
  updateHistoryActions(); saveSessionSoon();
}

function scheduleHistory(label) {
  if (state.historyApplying) return;
  clearTimeout(state.historyTimer);
  state.historyTimer = setTimeout(() => pushHistory(label), 360);
}

function applyHistorySnapshot(snapshot) {
  if (!snapshot) return;
  state.historyApplying = true;
  applyControlState(snapshot.controls);
  state.excludedFrames = new Set(snapshot.excludedFrames || []);
  state.maskEdits = structuredClone(snapshot.maskEdits || []);
  state.attachments = structuredClone(snapshot.attachments || []);
  state.frameOverrides = { ...(snapshot.frameOverrides || {}) };
  state.frameTransforms = structuredClone(snapshot.frameTransforms || {});
  state.timeline = snapshot.timeline ? structuredClone(snapshot.timeline) : null;
  state.sheetDraftCells = Array.isArray(snapshot.sheetDraftCells) ? snapshot.sheetDraftCells.map((cell) => ({ ...cell })) : [];
  state.historyApplying = false;
  if (typeof renderSheetCellList === "function") { renderSheetCellList(); drawSheetCells(); }
  updateMaskEditSummary(); renderAttachmentList();
  if (state.result) { buildFilmstrip(state.result); if (typeof refreshPlayer === "function") refreshPlayer(); }
  markPreviewDirty(); scheduleFramePreview(0); updateHistoryActions(); saveSessionSoon();
  setStatus(snapshot.label || "История применена", "done", 0);
}

function undoWorkspace() {
  if (state.historyIndex <= 0) return;
  state.historyIndex -= 1; applyHistorySnapshot(state.history[state.historyIndex]);
}

function redoWorkspace() {
  if (state.historyIndex >= state.history.length - 1) return;
  state.historyIndex += 1; applyHistorySnapshot(state.history[state.historyIndex]);
}

async function saveProjectFile(saveAs = false) {
  if (!state.source || state.busy) return;
  try {
    setStatus("Сохраняю проект…", "busy", 0.15);
    const result = await window.spriteLab.saveProject({
      projectPath: state.projectPath,
      saveAs,
      project: buildProjectDocument(),
    });
    if (!result) {
      setStatus("Сохранение отменено", "idle", 0);
      return;
    }
    state.projectPath = result.projectPath;
    state.frameOverrides = { ...(result.project.frameOverrides || {}) };
    state.attachments = structuredClone(result.project.attachments || state.attachments);
    renderAttachmentList();
    saveSessionSoon();
    setStatus(`Проект сохранён · ${baseName(result.projectPath)}`, "done", 0);
  } catch (error) {
    setStatus(error.message || "Не удалось сохранить проект", "error", 0);
    showError(error.message || "Не удалось сохранить проект.");
  }
}

async function openProjectFile() {
  if (state.busy) return;
  try {
    setStatus("Открываю проект…", "busy", 0.08);
    const loaded = await window.spriteLab.loadProject();
    if (!loaded) {
      setStatus(state.source ? "Проект не изменён" : "Готов к работе", state.source ? "done" : "idle", 0);
      return;
    }
    await applyProjectDocument(loaded.project, loaded.source, loaded.projectPath);
    setStatus(`Проект открыт · ${baseName(loaded.projectPath)}`, "done", 0);
  } catch (error) {
    setStatus(error.message || "Не удалось открыть проект", "error", 0);
    showError(error.message || "Не удалось открыть проект.");
  }
}

async function restoreSavedSession() {
  const project = state.pendingSession;
  if (!project) return;
  try {
    setStatus("Восстанавливаю сессию…", "busy", 0.08);
    const source = await window.spriteLab.restoreProject({ source: project.source });
    await applyProjectDocument(project, source, null);
    state.pendingSession = null;
    $("#sessionRestore").classList.add("hidden");
    setStatus("Сессия восстановлена", "done", 0);
  } catch (error) {
    localStorage.removeItem("spriteLab.session");
    state.pendingSession = null;
    $("#sessionRestore").classList.add("hidden");
    setStatus(error.message || "Сессию восстановить не удалось", "error", 0);
    showError(`${error.message || "Исходники сессии недоступны."} Выберите источник заново.`);
  }
}

function loadSessionOffer() {
  try {
    const project = JSON.parse(localStorage.getItem("spriteLab.session") || "null");
    if (!project?.source) return;
    state.pendingSession = project;
    $("#sessionRestoreHint").textContent = project.name ? `Продолжить «${project.name}» с прежними настройками.` : "Продолжить с прежними исходниками и настройками.";
    $("#sessionRestore").classList.remove("hidden");
  } catch { localStorage.removeItem("spriteLab.session"); }
}

function loadCustomExportProfiles() {
  try { customExportProfiles = JSON.parse(localStorage.getItem("spriteLab.exportProfiles") || "{}") || {}; }
  catch { customExportProfiles = {}; }
  const select = $("#exportPreset");
  select.querySelectorAll("option[data-custom-profile]").forEach((option) => option.remove());
  Object.entries(customExportProfiles).forEach(([key, profile]) => {
    const option = document.createElement("option");
    option.value = key; option.dataset.customProfile = "true"; option.textContent = profile.label;
    select.append(option);
  });
}

function saveCurrentExportProfile() {
  const input = $("#profileName");
  const label = input.value.trim();
  if (!label) { input.focus(); return; }
  const key = `user:${Date.now()}`;
  customExportProfiles[key] = { ...collectExports(), label };
  localStorage.setItem("spriteLab.exportProfiles", JSON.stringify(customExportProfiles));
  loadCustomExportProfiles();
  $("#exportPreset").value = key;
  $("#deleteExportProfile").classList.remove("hidden");
  $("#profileNameRow").classList.add("hidden");
  $("#saveExportProfile").classList.remove("hidden");
  input.value = "";
  setStatus(`Профиль «${label}» сохранён`, "done", 0);
}

function openCommandPalette() {
  setModalOpen($("#commandModal"), true, $("#commandSearch"), $("#openCommands"));
  $("#commandSearch").value = "";
  $$("#commandList button").forEach((button) => button.classList.remove("hidden"));
}

function closeCommandPalette() {
  setModalOpen($("#commandModal"), false, null, $("#openCommands"));
}

function runCommand(command) {
  closeCommandPalette();
  const commands = {
    source: () => chooseSource("chooseSource"),
    "open-project": openProjectFile,
    "save-project": () => saveProjectFile(false),
    undo: undoWorkspace,
    redo: redoWorkspace,
    build: () => { if (!$("#buildPreview").disabled) runBuild(true); else setStatus($("#buildPreview").title || "Сборка сейчас недоступна", "error", 0); },
    export: () => setTab("export"),
    play: () => typeof togglePlayback === "function" && togglePlayback(),
    onion: () => typeof toggleOnion === "function" && toggleOnion(),
    duplicate: () => typeof duplicateSelectedEntry === "function" && duplicateSelectedEntry(),
    game: () => { if (state.result) setPreviewMode("game"); },
    help: openAbout,
  };
  commands[command]?.();
}

function setTab(name) {
  $$(".tab").forEach((button) => {
    const selected = button.dataset.tab === name;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  $$(".panel").forEach((panel) => {
    const active = panel.dataset.panel === name;
    panel.classList.toggle("active", active);
    panel.setAttribute("aria-hidden", String(!active));
    panel.inert = !active;
  });
  if (name === "process") scheduleFramePreview(0);
  updateStepStates();
}

function setStatus(message, kind = "idle", value = 0) {
  $("#statusText").textContent = message;
  $("#statusLed").className = kind === "idle" ? "" : kind;
  const percent = Math.max(0, Math.min(100, Math.round(value * 100)));
  $("#progressBar").style.width = `${percent}%`;
  $("#statusPercent").textContent = `${percent}%`;
  const showProgress = kind === "busy";
  $("#progressTrack").classList.toggle("hidden", !showProgress);
  $("#statusPercent").classList.toggle("hidden", !showProgress);
  $("#cancelJob").classList.toggle("hidden", !state.busy);
}

function updateStepStates() {
  $("#sourceTab").classList.toggle("complete", Boolean(state.source));
  $("#processTab").classList.toggle("complete", Boolean(state.result) && !state.resultDirty);
  $("#exportTab").classList.toggle("complete", Boolean(state.lastExportDir));
  $("#saveProject").disabled = !state.source || state.busy;
}

function trapModalFocus(modal, event) {
  if (event.key !== "Tab") return;
  const focusable = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex]:not([tabindex="-1"])')]
    .filter((element) => !element.closest(".hidden"));
  if (!focusable.length) return;
  const first = focusable[0]; const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

function setModalOpen(modal, open, focusTarget, returnTarget) {
  if (open) {
    modalReturnFocus = returnTarget || document.activeElement;
    modal.classList.remove("hidden");
    $("#appShell").inert = true; $(".tabs").inert = true; $(".workspace-actions").inert = true;
    focusTarget?.focus?.();
  } else {
    modal.classList.add("hidden");
    if (!state.busy) { $("#appShell").inert = false; $(".tabs").inert = false; $(".workspace-actions").inert = false; }
    (returnTarget || modalReturnFocus)?.focus?.();
    modalReturnFocus = null;
  }
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
  setModalOpen($("#aboutModal"), true, $("#closeAbout"), aboutReturnFocus);
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
}

function closeAbout() {
  setModalOpen($("#aboutModal"), false, null, aboutReturnFocus);
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
  $("#appShell").setAttribute("aria-busy", String(state.busy));
  $(".control-deck").inert = state.busy;
  $(".tabs").inert = state.busy;
  $("#buildPreview").disabled = !hasSource || state.busy || !state.timelineValid;
  $("#buildPreview").title = !hasSource ? "Недоступно: сначала добавьте источник"
    : state.busy ? "Недоступно: обработка уже выполняется"
      : !state.timelineValid ? "Недоступно: конец диапазона видео должен быть позже начала" : "Собрать анимацию (Ctrl+Enter)";
  $("#chooseOutput").disabled = state.busy;
  $("#exportSprites").disabled = !hasSource || !state.outputFolder || state.busy || selectedNames.length === 0;
  $("#exportSprites").title = !hasSource ? "Недоступно: сначала выберите источник"
    : !state.outputFolder ? "Недоступно: выберите папку назначения"
      : selectedNames.length === 0 ? "Недоступно: выберите хотя бы один формат"
        : state.busy ? "Недоступно: обработка выполняется" : "Экспортировать набор";
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
  $("#transformTool").disabled = (!state.framePreview && !state.result) || state.busy || state.source?.kind === "video-batch";
  $("#processActionHint").textContent = !hasSource ? "Сначала добавьте источник"
    : state.busy ? "Обработка выполняется…"
      : !state.timelineValid ? "Исправьте диапазон видео: конец должен быть позже начала"
      : state.resultDirty ? "Настройки изменены — соберите анимацию заново"
        : state.result ? `Готово кадров: ${state.result.frameCount}` : "Первый кадр обновляется автоматически";
  $("#processActionHint").closest(".process-action-dock")?.classList.toggle("blocked", $("#buildPreview").disabled && !state.busy);
  $("#exportSprites").closest(".export-action-dock")?.classList.toggle("blocked", $("#exportSprites").disabled && !state.busy);
  if (typeof updateAnimationExportNote === "function") updateAnimationExportNote();
  updateStepStates();
}

function currentFramePath() {
  if (state.frameOverrides[state.selectedFrameIndex]) return state.frameOverrides[state.selectedFrameIndex];
  if (state.result?.allSourceFramePaths?.[state.selectedFrameIndex]) return state.result.allSourceFramePaths[state.selectedFrameIndex];
  if (state.source?.samplePaths?.[state.selectedFrameIndex]) return state.source.samplePaths[state.selectedFrameIndex];
  return state.source?.previewPath || state.source?.paths?.[0] || null;
}

function setSource(source) {
  resetFrameConsistency();
  $("#whiteRemainderHint").classList.add("hidden");
  if (source?.kind === "sheet" && source.sheetPath !== state.source?.sheetPath) $("#sheetFitEach").checked = false;
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
  state.frameTransforms = {};
  state.timeline = null;
  state.selectedEntryId = null;
  if (!state.animationSwitching) state.projectPath = null;
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
    $("#imageSheetControls").classList.add("hidden");
    $("#spriteName").disabled = false;
    $("#spriteNameLabel").textContent = "Имя набора";
    $("#sampleStrip").replaceChildren();
    $("#continueToProcess").classList.add("hidden");
    $("#batchQueue").classList.add("hidden");
    state.batchItems = [];
    updateMaskEditSummary();
    renderAttachmentList();
    resetPreview();
    $("#framePreviewTabs").classList.add("hidden");
    setStatus("Готов к работе");
    updateActionState();
    state.history = []; state.historyIndex = -1; updateHistoryActions(); saveSessionSoon(); updateStepStates();
    window.taskOnSource?.(null);
    return;
  }
  $("#sourceCard").classList.remove("hidden");
  state.pendingSession = null;
  $("#sessionRestore").classList.add("hidden");
  const isBatch = source.kind === "video-batch";
  const isSheet = source.kind === "sheet";
  $("#sourceBadge").textContent = isBatch ? "BATCH" : isSheet ? "SHEET" : source.kind === "video" ? "VIDEO" : "FRAMES";
  $("#sourceTitle").textContent = source.title;
  $("#sourceDetail").textContent = source.detail;
  $("#sourceRange").classList.toggle("hidden", source.kind !== "video");
  $("#sourcePreviewLabel").textContent = isBatch ? "ПЕРВОЕ ВИДЕО" : source.kind === "video" ? "НАЧАЛО ДИАПАЗОНА" : isSheet ? "ПЕРВЫЙ ОБЪЕКТ" : "ПЕРВЫЙ КАДР";
  $("#batchNote").classList.toggle("hidden", !isBatch);
  $("#continueToProcess").classList.remove("hidden");
  $("#sheetControls").classList.toggle("hidden", !isSheet);
  if (isSheet) {
    $("#sheetObjectCount").textContent = `${source.paths.length} объектов`;
    $$("#sheetSliceMode button").forEach((button) => button.classList.toggle("selected", button.dataset.sheetMode === source.sheetMode));
    $("#sheetGridFields").classList.toggle("hidden", source.sheetMode !== "grid");
  }
  renderSheetEditor(source);
  configureTimeline(source);
  if (source.previewUrl) {
    $("#sourcePreviewImage").src = source.previewUrl;
    $("#sourcePreview").classList.remove("hidden");
  }
  $("#spriteName").disabled = isBatch;
  $("#spriteNameLabel").textContent = isBatch ? "Имена наборов" : "Имя набора";
  // In a multi-animation project the set name is shared, so keep it.
  const keepSetName = state.animations.length > 1 && $("#spriteName").value && !isBatch;
  if (!keepSetName) $("#spriteName").value = isBatch ? "Автоматически — по именам видео" : sourceDefaultName(source);
  resetPreview();
  renderRecommendations(source);
  renderAttachmentList();
  if (isBatch) initializeBatchQueue(source.paths); else { state.batchItems = []; $("#batchQueue").classList.add("hidden"); }
  $("#framePreviewTabs").classList.remove("hidden");
  // A source that already has transparency does not need background removal.
  const alphaDetected = source.recommendations?.keyMode === "alpha" && !isBatch;
  if (alphaDetected) setKeyMode("alpha");
  // …and a source without transparency must not inherit the "Прозрачный" mode.
  else if (state.keyMode === "alpha" && source.recommendations?.keyMode && !isBatch) setKeyMode("auto");
  const opaqueNote = alphaDetected && source.opaqueImages ? ` · без прозрачности: ${source.opaqueImages} — их фон останется, пока не включено «Удалить фон»` : "";
  setStatus(alphaDetected ? `Источник загружен · найдена прозрачность — фон «Прозрачный» включён${opaqueNote} · ${source.detail}` : `Источник загружен · ${source.detail}`, "done", 0);
  updateActionState();
  savePreferences();
  initializeHistory("Источник добавлен"); saveSessionSoon(); updateStepStates();
  // Show the first frame immediately and bring the loaded source into view.
  state.previewMode = "after";
  setPreviewMode("after");
  scheduleFramePreview(0);
  requestAnimationFrame(() => {
    if ($("#sourcePanel").classList.contains("active")) (document.body.dataset.task ? $("#taskGuide") : $("#sourceCard")).scrollIntoView({ block: "start", behavior: "instant" });
  });
  if (typeof renderImageSheetControls === "function") renderImageSheetControls();
  if (typeof renderAnimationBar === "function") renderAnimationBar();
  window.taskOnSource?.(source);
}

function resetPreview() {
  state.viewportPanX = 0; state.viewportPanY = 0; state.viewportPanning = false; state.panPointerId = null;
  if (state.transformPanelOpen) setTransformPanel(false);
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
  $("#depthPreviewTab").classList.add("hidden");
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
  $("#recommendationConfidence").textContent = recommendation.keyMode === "ai"
    ? "сложный фон"
    : confidenceLabel(recommendation.confidence);
  const sizeText = recommendation.cellWidth && recommendation.cellHeight ? `ячейка около ${recommendation.cellWidth} × ${recommendation.cellHeight}` : "размер ячейки автоматически";
  const frameText = recommendation.estimatedFrames ? ` · примерно ${recommendation.estimatedFrames} кадров` : "";
  const anchorText = ({ ground: "ноги на месте", center: "центр на месте", body: "тело на месте", motion: "сохранить движение" })[recommendation.anchor] || "ноги на месте";
  const batchText = source.kind === "video-batch" ? " · по первому видео" : "";
  $("#recommendationSummary").textContent = `Фон: ${modeLabel(recommendation.keyMode)} · ${recommendation.fps} FPS · ${anchorText} · ${sizeText}${frameText}${batchText}${recommendation.keyMode === "ai" ? ". Края кадра неоднородны: проверьте результат локального ИИ в превью." : ""}`;
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
  const isVideo = state.source?.kind === "video";
  const valid = !isVideo || end > start;
  state.timelineValid = valid;
  $("#trimError").classList.toggle("hidden", valid);
  $("#trimError").textContent = valid ? "" : "Конец диапазона должен быть позже начала.";
  updateActionState();
  if (!valid || !isVideo) return;
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
    keyMode: state.keyMode, keyScope: $("#keyScope").value, anchor: state.anchor, autoSize: $("#autoSize").checked, autoColumns: $("#autoColumns").checked,
    pixelPerfect: $("#pixelPerfect").checked, removeDuplicates: $("#removeDuplicates").checked,
    outputBackground: $("#whiteOutput").checked ? "white" : "transparent",
    excludedFrames: [...state.excludedFrames], exports: collectExports(),
    aiCutoff: $("#aiAutoCutoff").checked ? "auto" : Number($("#aiCutoff").value), aiSoftness: Number($("#aiSoftness").value),
    aiQuality: $("#aiQuality").value,
    aiEdits: state.maskEdits, previewFrameIndex: state.result ? state.selectedFrameIndex : 0,
    fringeCleanup: $("#fringeCleanup").checked, fringeStrength: Number($("#fringeStrength").value),
    edgeDecontaminate: $("#edgeDecontaminate").checked,
    edgeRefine: { mode: $("#edgeRefineMode").value, width: Number($("#edgeRefineWidth").value), depth: Number($("#edgeRefineDepth").value), whiteOnly: $("#edgeRefineWhiteOnly").checked },
    aiProvider: $("#aiProvider").value, aiModel: $("#aiModel").value,
    auxAI: {
      interpolate: $("#auxRife").checked,
      upscale: $("#auxEsrgan").checked,
      depth: $("#auxDepth").checked,
      inpaintMaskPath: state.auxMaskPath || null,
    },
    keyColor: state.keyMode === "custom" ? hexToRgb(state.solidKeyMode) : undefined,
    attachments: state.attachments.filter((attachment) => attachment.enabled !== false), attachmentPlacements: state.resultDirty ? null : state.result?.attachmentPlacements || null,
    frameOverrides: state.frameOverrides,
    frameTransforms: state.frameTransforms,
    fitEachFrame: (state.source?.kind === "sheet" && $("#sheetFitEach").checked) || (state.source?.kind === "frames" && state.imageAlign === "fit"),
    timeline: timelineOption(state.timeline),
    ...loopOptions(),
    packing: $("#atlasPacking").value, exportFormat: $("#exportFormat").value,
    atlasMaxSize: Number($("#atlasMaxSize").value) || 0, atlasOverflow: $("#atlasOverflow").value, atlasPowerOfTwo: $("#atlasPowerOfTwo").checked,
    pixelate: $("#pixelateEnabled").checked ? {
      size: Number($("#pixelateSize").value),
      colors: Number($("#pixelateColors").value),
      palette: $("#pixelatePalette").value,
      mode: $("#pixelateMode").value,
      dither: $("#pixelateDither").value,
      shadingSteps: Number($("#pixelateShading").value),
    } : null,
    toning: $("#toningEnabled").checked ? { color: $("#toningColor").value, strength: Number($("#toningStrength").value) } : null,
  };
}

function timelineOption(timeline) {
  if (!Array.isArray(timeline) || !timeline.length) return undefined;
  return timeline.map((entry) => ({ src: entry.src, ...(Number(entry.d) > 0 ? { durationMs: Number(entry.d) } : {}) }));
}

function loopOptions(studio = null) {
  const mode = studio ? studio.loopMode || "loop" : $("#loopMode button.selected")?.dataset.loop || "loop";
  const fromValue = studio ? studio.loopFrom : $("#loopFrom").value;
  const toValue = studio ? studio.loopTo : $("#loopTo").value;
  const from = Math.max(0, (Number(fromValue) || 1) - 1);
  const to = toValue === "" || toValue == null ? null : Math.max(from, Number(toValue) - 1);
  return { loopMode: mode, loopRange: mode === "range" ? { from, to } : null };
}

function syncExportDependencies(changedName) {
  const sheet = $(exportControls.sheet);
  const metadata = $(exportControls.metadata);
  if (changedName === "metadata" && metadata.checked) sheet.checked = true;
  if (changedName === "sheet" && !sheet.checked) metadata.checked = false;
  sheet.disabled = metadata.checked;
  state.lastExportDir = null;
  if (changedName) { $("#exportPreset").value = "custom"; $("#deleteExportProfile").classList.add("hidden"); }
  updateActionState();
  savePreferences();
}

function applyExportPreset(name) {
  const preset = exportPresets[name] || customExportProfiles[name];
  if (!preset) return;
  Object.entries(exportControls).forEach(([key, selector]) => { $(selector).checked = Boolean(preset[key]); });
  $(exportControls.sheet).disabled = preset.metadata;
  state.lastExportDir = null;
  $("#deleteExportProfile").classList.toggle("hidden", !name.startsWith("user:"));
  updateActionState();
  savePreferences();
}

function hexToRgb(value) {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(value || ""));
  return match ? [1, 2, 3].map((index) => Number.parseInt(match[index], 16)) : null;
}

function setKeyMode(mode) {
  if (mode === "solid") state.keyMode = hexToRgb(state.solidKeyMode) ? "custom" : (state.solidKeyMode || "black");
  else if (["white", "black", "green", "blue"].includes(mode)) { state.solidKeyMode = mode; state.keyMode = mode; }
  else state.keyMode = mode;
  const displayMode = ["white", "black", "green", "blue", "custom"].includes(state.keyMode) ? "solid" : state.keyMode;
  $$("#keyMode button").forEach((item) => {
    const selected = item.dataset.value === displayMode;
    item.classList.toggle("selected", selected);
    item.setAttribute("aria-pressed", String(selected));
  });
  $$("#solidKeyColor button").forEach((item) => {
    const selected = item.dataset.keyColor === state.solidKeyMode;
    item.classList.toggle("selected", selected); item.setAttribute("aria-pressed", String(selected));
  });
  const customSwatch = $("#customKeyColor");
  if (customSwatch && hexToRgb(state.solidKeyMode)) customSwatch.value = state.solidKeyMode;
  $("#solidKeyPanel").classList.toggle("hidden", displayMode !== "solid");
  $("#keyScopeRow").classList.toggle("hidden", displayMode === "alpha" || displayMode === "ai");
  $("#blackKeyNote").classList.toggle("hidden", state.keyMode !== "black");
  $("#blackOutlineRow").classList.toggle("hidden", state.keyMode !== "black");
  $("#blackFeatherRow").classList.toggle("hidden", state.keyMode !== "black");
  $("#toleranceRow").classList.toggle("hidden", state.keyMode === "ai");
  $("#aiCleanupPanel").classList.toggle("hidden", state.keyMode !== "ai");
  const autoCutoff = $("#aiAutoCutoff");
  if (autoCutoff) $("#aiCutoff").disabled = autoCutoff.checked;
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

function markProcessPreset(name) {
  state.processPreset = name;
  $$("#processPresets button[data-preset]").forEach((button) => {
    const selected = button.dataset.preset === name;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function applyProcessPreset(name, { history = true } = {}) {
  markProcessPreset(name);
  if (name === "effect") {
    setAnchor("center"); $("#removeDuplicates").checked = false; $("#pixelPerfect").checked = false;
  } else if (name === "pixel") {
    setAnchor("ground"); $("#removeDuplicates").checked = true; $("#pixelPerfect").checked = true;
  } else {
    setAnchor("ground"); $("#removeDuplicates").checked = true; $("#pixelPerfect").checked = false;
  }
  markPreviewDirty();
  savePreferences();
  if (history) pushHistory(`Профиль «${({ character: "Персонаж", effect: "Эффект", pixel: "Пиксель-арт" })[name] || name}»`);
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
  syncAutoSize(); applyProcessPreset("character", { history: false }); scheduleFramePreview(); pushHistory("Рекомендуемые настройки");
}

function warningSourceIndex(warning) {
  // The processor reports the source index directly now; parsing the message is only a
  // fallback for a report written before that field existed.
  const explicit = state.warningRefs?.get(warning);
  if (explicit != null) return explicit;
  const match = String(warning || "").match(/Кадр\s+(\d+)/i);
  if (!match) return null;
  const outputIndex = Number(match[1]) - 1;
  return state.result?.sourceFrameIndexes?.[outputIndex] ?? outputIndex;
}

function selectWarning(delta = 0) {
  if (!state.warnings.length) return;
  state.warningIndex = (state.warningIndex + delta + state.warnings.length) % state.warnings.length;
  $("#warningPosition").textContent = `${state.warningIndex + 1} / ${state.warnings.length}`;
  const sourceIndex = warningSourceIndex(state.warnings[state.warningIndex]);
  if (sourceIndex != null) selectFrame(sourceIndex);
}

function showWarnings(warnings, frameIssues = []) {
  const list = $("#warningList");
  list.replaceChildren();
  state.warnings = warnings || []; state.warningIndex = 0;
  state.warningRefs = new Map((frameIssues || [])
    .filter((issue) => issue && issue.message && issue.frameIndex != null)
    .map((issue) => [issue.message, issue.frameIndex]));
  if (!state.warnings.length) { $("#warningBox").classList.add("hidden"); return; }
  const groups = new Map();
  state.warnings.forEach((warning) => {
    const key = warning.includes("Лист:") ? "Проверка атласа"
      : warning.includes("касается края") ? "Персонаж касается края"
        : warning.includes("ширина силуэта") ? "Скачок ширины силуэта"
          : warning.includes("высота силуэта") ? "Скачок высоты силуэта"
            : warning.includes("уверенность привязки") ? "Проверьте привязку PNG"
              : warning.includes("умная область") ? "Проверьте удаление объекта" : warning.replace(/Кадр\s+\d+:?\s*/i, "");
    if (!groups.has(key)) groups.set(key, []);
    // Groups carry source indexes, so a click needs no further mapping.
    const sourceIndex = warningSourceIndex(warning);
    if (sourceIndex != null) groups.get(key).push(sourceIndex);
  });
  [...groups.entries()].slice(0, 12).forEach(([label, frameIndexes]) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = frameIndexes.length ? `${label} · ${frameIndexes.length} кадр.` : label;
    const severe = label.includes("края") || label.includes("привязку") || label.includes("удаление") || label.includes("атласа");
    button.className = severe ? "severity-error" : "severity-info";
    button.title = frameIndexes.length ? "Перейти к первому проблемному кадру" : label;
    if (frameIndexes.length) button.addEventListener("click", () => selectFrame(frameIndexes[0]));
    item.append(button); list.append(item);
  });
  // Offer the fix next to the problem: the silhouette comparison used to be a separate
  // collapsed block that had to be remembered and opened by hand.
  if (state.warnings.some((warning) => warning.includes("ширина силуэта") || warning.includes("высота силуэта"))) {
    const item = document.createElement("li");
    const action = document.createElement("button");
    action.type = "button";
    action.textContent = "Согласовать размер кадров";
    action.className = "severity-info";
    action.title = "Открыть анализ силуэтов и предложенный масштаб";
    action.addEventListener("click", () => {
      const panel = $("#consistencyPanel");
      if (panel) panel.open = true;
      panel?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      $("#analyzeFrameSizes").click();
    });
    item.append(action); list.append(item);
  }
  $("#warningCount").textContent = String(state.warnings.length);
  $("#warningPosition").textContent = `1 / ${state.warnings.length}`;
  $("#warningBox").classList.remove("hidden");
}

function baseName(filePath) {
  return String(filePath || "").split(/[\\/]/).pop() || "video";
}

function renderBatchQueue() {
  const list = $("#batchQueueList"); list.replaceChildren();
  state.batchItems.forEach((item, index) => {
    const row = document.createElement("article"); row.className = `batch-item ${item.status || "pending"}`;
    const led = document.createElement("i");
    const title = document.createElement("strong"); title.textContent = item.name;
    const detail = document.createElement("small"); detail.textContent = item.detail || ({ pending: "Ожидает", processing: "Обработка…", done: "Готово", failed: "Ошибка" })[item.status] || "Ожидает";
    const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×"; remove.title = "Убрать из очереди"; remove.disabled = state.busy;
    remove.addEventListener("click", () => {
      if (state.busy || state.batchItems.length <= 1) return;
      state.batchItems.splice(index, 1); state.source.paths = state.batchItems.map((entry) => entry.path);
      state.source.batchCount = state.source.paths.length; renderBatchQueue(); updateActionState(); saveSessionSoon();
    });
    row.append(led, title, detail, remove); list.append(row);
  });
  const finished = state.batchItems.filter((item) => item.status === "done" || item.status === "failed").length;
  $("#batchQueueProgress").textContent = `${finished} / ${state.batchItems.length}`;
  $("#batchQueue").classList.toggle("hidden", !state.batchItems.length);
}

function initializeBatchQueue(paths = []) {
  state.batchItems = paths.map((filePath) => ({ path: filePath, name: baseName(filePath), status: "pending", detail: "Ожидает" }));
  $("#retryBatch").classList.add("hidden"); $("#stopAfterCurrent").classList.add("hidden"); renderBatchQueue();
}

function updateBatchProgress(progress) {
  if (!state.batchItems.length) return;
  const match = String(progress.message || "").match(/Видео\s+(\d+)\/(\d+)/i);
  if (!match) return;
  const index = Number(match[1]) - 1;
  const total = Math.max(1, Number(match[2]) || state.batchItems.length);
  const localProgress = Math.max(0, Math.min(1, (Number(progress.value) || 0) * total - index));
  state.batchItems.forEach((item, itemIndex) => {
    if (itemIndex < index && item.status === "processing") { item.status = "done"; item.detail = "Готово"; }
    if (itemIndex === index) { item.status = "processing"; item.detail = `${Math.round(localProgress * 100)}%`; }
  });
  renderBatchQueue();
}

function finishBatchQueue(result) {
  const failures = new Map((result.failures || []).map((item) => [item.path, item.error]));
  state.batchItems.forEach((item, index) => {
    if (failures.has(item.path)) { item.status = "failed"; item.detail = failures.get(item.path); }
    else if (index < result.completed + result.failed) { item.status = "done"; item.detail = "Готово"; }
    else { item.status = "pending"; item.detail = result.stopped ? "Остановлено" : "Ожидает"; }
  });
  $("#retryBatch").classList.toggle("hidden", !state.batchItems.some((item) => item.status === "failed"));
  $("#stopAfterCurrent").classList.add("hidden"); renderBatchQueue();
}

function timelineEntries(result = state.result) {
  const count = result?.allSourceFrameUrls?.length || 0;
  if (Array.isArray(state.timeline) && state.timeline.length) {
    const entries = state.timeline.filter((entry) => entry.src < count);
    const present = new Set(entries.map((entry) => entry.src));
    for (let index = 0; index < count; index += 1) if (!present.has(index)) entries.push({ id: `s${index}`, src: index, d: null });
    return entries;
  }
  return Array.from({ length: count }, (_value, index) => ({ id: `s${index}`, src: index, d: null }));
}

function buildFilmstrip(result) {
  const strip = $("#filmstrip"); strip.replaceChildren();
  const processedBySource = new Map((result.sourceFrameIndexes || []).map((sourceIndex, outputIndex) => [sourceIndex, result.frameUrls[outputIndex]]));
  const entries = timelineEntries(result);
  const useCounts = new Map();
  entries.forEach((entry) => useCounts.set(entry.src, (useCounts.get(entry.src) || 0) + 1));
  const baseMs = Math.round(1000 / Math.max(1, Number($("#fps").value) || 8));
  entries.forEach((entry, position) => {
    const sourceIndex = entry.src;
    const sourceUrl = result.allSourceFrameUrls[sourceIndex];
    const button = document.createElement("button");
    button.type = "button"; button.title = `Позиция ${position + 1} · исходный кадр ${sourceIndex + 1}`;
    button.dataset.sourceIndex = String(sourceIndex); button.dataset.entryId = entry.id; button.dataset.frameLabel = String(sourceIndex + 1);
    button.draggable = true;
    const img = document.createElement("img"); img.src = processedBySource.get(sourceIndex) || sourceUrl; img.alt = `Кадр ${sourceIndex + 1}`; img.draggable = false;
    button.classList.toggle("excluded", state.excludedFrames.has(sourceIndex));
    const isDuplicate = result.skipped?.duplicateIndexes?.includes(sourceIndex);
    const isEmpty = result.skipped?.emptyIndexes?.includes(sourceIndex);
    button.classList.toggle("skipped", isDuplicate || isEmpty);
    button.classList.toggle("edited", Boolean(state.frameOverrides[sourceIndex]));
    button.classList.toggle("warning", state.warnings.some((warning) => warningSourceIndex(warning) === sourceIndex));
    button.classList.toggle("has-attachment", state.attachments.some((attachment) => attachment.enabled !== false));
    button.classList.toggle("repeat", (useCounts.get(sourceIndex) || 0) > 1);
    if (isDuplicate) button.title += " · точный дубль";
    if (isEmpty) button.title += " · пустой после очистки";
    button.append(img);
    if (Number(entry.d) > 0) {
      const badge = document.createElement("span"); badge.className = "duration-badge"; badge.textContent = `${entry.d}мс`;
      button.title += ` · ${entry.d} мс`; button.append(badge);
    } else button.title += ` · ${baseMs} мс (по FPS)`;
    button.addEventListener("click", () => selectFrame(sourceIndex, true, entry.id));
    strip.append(button);
  });
  if (typeof bindTimelineDrag === "function") bindTimelineDrag(strip);
  $("#filmstripBar").classList.toggle("hidden", result.allSourceFrameUrls.length === 0);
  const truncated = result.allSourceFramePaths.length - result.allSourceFrameUrls.length;
  const repeats = entries.length - new Set(entries.map((entry) => entry.src)).size;
  const custom = entries.filter((entry) => Number(entry.d) > 0).length;
  $("#filmstripNote").textContent = truncated > 0
    ? `Показаны первые ${result.allSourceFrameUrls.length} кадров. Ещё кадров: ${truncated}.`
    : `${result.allSourceFramePaths.length} исходных кадров · исключено: ${state.excludedFrames.size}${repeats ? ` · повторов: ${repeats}` : ""}${custom ? ` · своя длительность: ${custom}` : ""} · перетаскивайте кадры, чтобы поменять порядок`;
  $("#filmstripNote").title = $("#filmstripNote").textContent;
  $("#filmstripNote").classList.remove("hidden");
  const selected = entries.find((entry) => entry.id === state.selectedEntryId) || entries.find((entry) => entry.src === state.selectedFrameIndex);
  if (selected) markSelectedEntry(selected.id);
}

function markSelectedEntry(entryId) {
  state.selectedEntryId = entryId;
  $$("#filmstrip button").forEach((button) => {
    const selected = button.dataset.entryId === entryId;
    button.classList.toggle("selected", selected);
    button.classList.toggle("excluded", state.excludedFrames.has(Number(button.dataset.sourceIndex)));
    if (selected) button.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
  const entry = timelineEntries().find((item) => item.id === entryId);
  if (typeof syncFrameDurationControl === "function") syncFrameDurationControl(entry);
}

function selectFrame(sourceIndex, activateFrameView = true, entryId = null) {
  if (!state.result?.allSourceFramePaths?.length) return;
  state.selectedFrameIndex = Math.max(0, Math.min(sourceIndex, state.result.allSourceFramePaths.length - 1));
  const entries = timelineEntries();
  const entry = entries.find((item) => item.id === entryId)
    || (entries.find((item) => item.id === state.selectedEntryId && item.src === state.selectedFrameIndex))
    || entries.find((item) => item.src === state.selectedFrameIndex);
  markSelectedEntry(entry?.id || null);
  const automaticallySkipped = state.result.skipped?.duplicateIndexes?.includes(state.selectedFrameIndex)
    || state.result.skipped?.emptyIndexes?.includes(state.selectedFrameIndex);
  const isBatch = state.source?.kind === "video-batch";
  $("#excludeFrame").disabled = automaticallySkipped || isBatch;
  $("#excludeFrame").title = isBatch ? "Недоступно в пакетном режиме" : automaticallySkipped ? "Кадр пропущен автоматически (дубль или пустой)" : "Del — исключить или вернуть кадр";
  $("#excludeFrame").textContent = isBatch
    ? "Только для одного видео"
    : automaticallySkipped
    ? "Пропущен автоматически"
    : state.excludedFrames.has(state.selectedFrameIndex) ? "Вернуть кадр" : "Исключить кадр";
  if (activateFrameView) setPreviewMode("after");
  requestFramePreview(currentFramePath());
  if (state.transformPanelOpen) syncTransformControls();
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
  objectSummary.textContent = regions + strokes ? `Удаление объектов: ${regions + strokes}` : "Удаление объектов: не применено";
  objectSummary.classList.toggle("active", regions + strokes > 0);
  edgeSummary.textContent = $("#fringeCleanup").checked ? "Очистка края: включена" : "Очистка края: выключена";
  edgeSummary.classList.toggle("active", $("#fringeCleanup").checked);
  const enabledAttachments = state.attachments.filter((attachment) => attachment.enabled !== false).length;
  overlaySummary.textContent = `Привязанные PNG: ${enabledAttachments}${enabledAttachments !== state.attachments.length ? `/${state.attachments.length}` : ""}`;
  overlaySummary.classList.toggle("active", enabledAttachments > 0);
  const enabledTools = Number(regions + strokes > 0) + Number($("#fringeCleanup").checked) + Number(enabledAttachments > 0);
  $("#finishingState").textContent = enabledTools ? `Активно: ${enabledTools}` : "Не применено";
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
  if (state.maskProposalOverlay) context.drawImage(state.maskProposalOverlay, 0, 0);
  if (typeof drawMaskOnion === "function") drawMaskOnion(context, canvas);
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

async function openMaskEditor({ review = false } = {}) {
  if (!state.source || state.busy) return;
  $("#aiMaskTitle").textContent = review ? "Проверьте предложенный контур" : "Уберите лишнее один раз";
  $("#maskModalIntro").textContent = review
    ? "Бирюзовая линия показывает будущую вырезку. Защитите белые буквы, молнии и цветы; удалите оставшийся фон кистью. Затем примените и проверьте результат."
    : "Выберите область — программа найдёт её в серии. Кисти оставлены для точной доводки.";
  setMaskTool(review ? "keep" : "smart");
  setStatus("Готовлю выбранный кадр…", "busy", 0.12);
  clearTimeout(state.quickTimer);
  let proposal = await requestFramePreview(currentFramePath());
  if (!proposal) proposal = await requestFramePreview(currentFramePath());
  if (review && !proposal?.afterUrl) throw new Error("Контур ещё не построен. Повторите просмотр кадра.");
  const imageUrl = proposal?.beforeUrl || state.source.previewUrl;
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
  state.maskProposalOverlay = null;
  if (proposal?.afterUrl) {
    const afterImage = await loadUiImage(proposal.afterUrl, "Не удалось загрузить предложенный контур.");
    const afterCanvas = document.createElement("canvas");
    afterCanvas.width = canvas.width; afterCanvas.height = canvas.height;
    const afterContext = afterCanvas.getContext("2d", { willReadFrequently: true });
    afterContext.drawImage(afterImage, 0, 0, canvas.width, canvas.height);
    const pixels = afterContext.getImageData(0, 0, canvas.width, canvas.height).data;
    const overlay = afterContext.createImageData(canvas.width, canvas.height);
    for (let y = 0; y < canvas.height; y += 1) for (let x = 0; x < canvas.width; x += 1) {
      const index = y * canvas.width + x;
      if (pixels[index * 4 + 3] < 16) {
        if (state.maskEditorPixels[index * 4 + 3] >= 8) overlay.data.set([42, 48, 55, 150], index * 4);
        continue;
      }
      const edge = x === 0 || y === 0 || x === canvas.width - 1 || y === canvas.height - 1
        || pixels[(index - 1) * 4 + 3] < 16 || pixels[(index + 1) * 4 + 3] < 16
        || pixels[(index - canvas.width) * 4 + 3] < 16 || pixels[(index + canvas.width) * 4 + 3] < 16;
      if (!edge) continue;
      overlay.data.set([0, 201, 205, 230], index * 4);
    }
    afterContext.clearRect(0, 0, canvas.width, canvas.height);
    afterContext.putImageData(overlay, 0, 0);
    state.maskProposalOverlay = afterCanvas;
  }
  redrawMaskCanvas();
  setModalOpen($("#aiMaskModal"), true, $("#applyMaskEditor"), $("#openMaskEditor"));
  setStatus("Редактор маски открыт", "done", 0);
}

function closeMaskEditor({ discard = false } = {}) {
  if (discard) state.maskEdits = state.maskEditorSnapshot.map((edit) => ({ ...edit }));
  state.maskDrawing = false;
  state.maskEditorImage = null;
  state.maskEditorPixels = null;
  state.maskProposalOverlay = null;
  setModalOpen($("#aiMaskModal"), false, null, $("#openMaskEditor"));
  updateMaskEditSummary();
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
      renderAttachmentList(); markPreviewDirty(); scheduleFramePreview(0); pushHistory("Видимость PNG изменена");
    });
    const edit = document.createElement("button"); edit.type = "button"; edit.textContent = "↗"; edit.title = "Изменить привязку";
    edit.addEventListener("click", async () => {
      try { await openAttachmentEditor(attachment); } catch (error) { setStatus(error.message || "Не удалось открыть привязку", "error", 0); showError(error.message); }
    });
    const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×"; remove.title = "Удалить PNG";
    remove.addEventListener("click", () => {
      state.attachments = state.attachments.filter((entry) => entry.id !== attachment.id);
      renderAttachmentList(); markPreviewDirty(); scheduleFramePreview(0); pushHistory("PNG удалён");
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
    context.fillStyle = "#11151a"; context.font = '700 12px "Bahnschrift"'; context.textAlign = "center"; context.textBaseline = "middle"; context.fillText(index ? "B" : "A", x, y + 0.5);
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
  setModalOpen($("#attachmentModal"), true, $("#saveAttachment"), $("#addAttachment"));
}

function closeAttachmentEditor() {
  state.attachmentAsset = null; state.attachmentSourceImage = null; state.attachmentAssetImage = null; state.attachmentPoints = []; state.attachmentEditingId = null; state.attachmentReferenceFrame = 0;
  setModalOpen($("#attachmentModal"), false, null, $("#addAttachment"));
}

function saveAttachment() {
  if (!state.attachmentAsset || state.attachmentPoints.length < state.attachmentPointCount) return;
  const isEditing = Boolean(state.attachmentEditingId);
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
  pushHistory(isEditing ? "Привязка PNG изменена" : "PNG привязан");
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
    const revision = await window.spriteLab.snapshotFrameEdit(state.externalEdit.path);
    state.frameOverrides[state.externalEdit.frameIndex] = revision.path;
    $("#frameEditorImage").src = `${revision.url}?v=${Math.round(revision.modifiedAt)}`;
    setFrameEditorStatus("Изменения найдены и подхвачены", "changed");
    markPreviewDirty();
    await requestFramePreview(state.externalEdit.path);
    pushHistory(`Кадр ${state.externalEdit.frameIndex + 1} изменён`);
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
  state.externalEdit = { ...edit, frameIndex };
  $("#frameEditorImage").src = `${edit.url}?v=${Math.round(edit.modifiedAt)}`;
  $("#frameEditorBadge").textContent = `КАДР ${frameIndex + 1}`;
  $("#frameEditorPath").textContent = edit.path;
  $("#frameEditorPath").title = edit.path;
  setFrameEditorStatus("Рабочая копия готова");
  setModalOpen($("#frameEditorModal"), true, $("#openDefaultEditor"), $("#editFrame"));
  clearInterval(state.externalEditTimer);
  state.externalEditTimer = setInterval(() => refreshExternalEdit(), 1200);
}

function closeFrameEditor() {
  clearInterval(state.externalEditTimer);
  state.externalEditTimer = null;
  state.externalEdit = null;
  setModalOpen($("#frameEditorModal"), false, null, $("#editFrame"));
}

async function replaceExternalEdit() {
  if (!state.externalEdit) return;
  const replaced = await window.spriteLab.replaceFrameEdit({ path: state.externalEdit.path });
  if (!replaced) return;
  state.externalEdit = { ...state.externalEdit, ...replaced, modifiedAt: 0 };
  await refreshExternalEdit({ force: true });
}

async function replaceExternalEditFromDrop(file) {
  if (!state.externalEdit || !file) return;
  const replaced = await window.spriteLab.replaceFrameEditDropped({ path: state.externalEdit.path, file });
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
  savePreferences(); pushHistory(state.excludedFrames.has(sourceIndex) ? "Кадр исключён" : "Кадр возвращён");
}

function updatePreview(result) {
  state.result = result;
  state.resultDirty = false;
  $("#previewFreshness").classList.add("hidden");
  $("#metaFrames").textContent = String(result.frameCount);
  $("#metaCell").textContent = `${result.cellWidth} × ${result.cellHeight}`;
  $("#metaGrid").textContent = `${result.columns} × ${result.rows}`;
  $("#metaAnchor").textContent = ({ ground: "Земля", center: "Центр", body: "Тело", motion: "Движение" })[state.anchor] || state.anchor;
  if (typeof renderAtlasStatus === "function") renderAtlasStatus(result);
  if (typeof renderAtlasInspection === "function") renderAtlasInspection(result);
  if (typeof loadPlayerFrames === "function") loadPlayerFrames(result);
  showWarnings(result.warnings, result.frameIssues); buildFilmstrip(result);
  renderAttachmentList();
  $("#resultPreviewTabs").classList.remove("hidden");
  $("#depthPreviewTab").classList.toggle("hidden", !result.depthUrls?.length);
  state.previewMode = result.frameUrls?.length || result.previewUrl ? "animation" : "sheet";
  setPreviewMode(state.previewMode);
  if (result.allSourceFramePaths?.length) selectFrame(result.sourceFrameIndexes?.[0] ?? 0, false);
}

function updateComparePosition() {
  const value = Number($("#compareSlider").value);
  $("#compareAfterWrap").style.clipPath = `inset(0 ${100 - value}% 0 0)`;
  $("#compareDivider").style.left = `${value}%`;
}

// Scale at which an image of natural size fits into a box (object-fit: contain).
function containScale(naturalWidth, naturalHeight, boxWidth, boxHeight) {
  if (!naturalWidth || !naturalHeight || !boxWidth || !boxHeight) return 1;
  return Math.min(boxWidth / naturalWidth, boxHeight / naturalHeight);
}

function currentFitScale() {
  const stage = $("#previewStage");
  if (["animation", "game"].includes(state.previewMode) && typeof playerFitScale === "function") return playerFitScale();
  const image = state.previewMode === "compare" ? $("#compareAfter") : $("#previewImage");
  if (!image?.naturalWidth) return 1;
  const style = getComputedStyle(image);
  const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const width = (image.clientWidth || stage.clientWidth) - (Number.isFinite(padX) ? padX : 0);
  const height = (image.clientHeight || stage.clientHeight) - (Number.isFinite(padY) ? padY : 0);
  return containScale(image.naturalWidth, image.naturalHeight, width, height);
}

function applyZoom() {
  const transform = `translate(${state.viewportPanX}px, ${state.viewportPanY}px) scale(${state.zoom})`;
  $("#previewImage").style.transform = transform;
  $("#compareBefore").style.transform = transform;
  $("#compareAfter").style.transform = transform;
  state.fitScale = currentFitScale();
  const realScale = state.previewMode === "game" && typeof studio !== "undefined" ? studio.gameScale : state.fitScale * state.zoom;
  $("#zoomValue").textContent = `${Math.round(realScale * 100)}%`;
  $("#zoomValue").title = state.previewMode === "game" ? "Масштаб в игре" : `Реальный масштаб: вписано ${Math.round(state.fitScale * 100)}% × зум ${Math.round(state.zoom * 100)}%`;
  if (typeof drawPlayer === "function") drawPlayer();
  updateGuideGrid();
}

function updateGuideGrid() {
  const layer = $("#guideLayer");
  const image = $("#previewImage");
  const shown = Boolean(state.guides && !image.classList.contains("hidden") && image.naturalWidth);
  layer.classList.toggle("hidden", !shown);
  $("#gridSpacingLabel").classList.toggle("hidden", !state.guides);
  if (!shown) return;
  const style = getComputedStyle(image);
  const padLeft = parseFloat(style.paddingLeft) || 0;
  const padRight = parseFloat(style.paddingRight) || 0;
  const padTop = parseFloat(style.paddingTop) || 0;
  const padBottom = parseFloat(style.paddingBottom) || 0;
  const spaceWidth = image.clientWidth - padLeft - padRight;
  const spaceHeight = image.clientHeight - padTop - padBottom;
  const fit = containScale(image.naturalWidth, image.naturalHeight, spaceWidth, spaceHeight);
  const renderedWidth = image.naturalWidth * fit;
  const renderedHeight = image.naturalHeight * fit;
  const imageRect = image.getBoundingClientRect();
  const stageRect = $("#previewStage").getBoundingClientRect();
  const zoom = state.zoom;
  layer.style.left = `${imageRect.left - stageRect.left + (padLeft + (spaceWidth - renderedWidth) / 2) * zoom}px`;
  layer.style.top = `${imageRect.top - stageRect.top + (padTop + (spaceHeight - renderedHeight) / 2) * zoom}px`;
  layer.style.width = `${renderedWidth * zoom}px`;
  layer.style.height = `${renderedHeight * zoom}px`;
  const spacing = Math.max(2, Number($("#gridSpacing").value) * fit * zoom);
  layer.style.backgroundSize = `${spacing}px ${spacing}px`;
}

function handToolActive() {
  return state.spaceHand || state.handToolLocked;
}

function updateHandTool() {
  const active = handToolActive();
  $("#previewStage").classList.toggle("hand-tool", active);
  $("#previewStage").classList.toggle("panning", active && state.viewportPanning);
  $("#handTool").classList.toggle("active", active);
  $("#handTool").setAttribute("aria-pressed", String(state.handToolLocked));
}

function stopViewportPan() {
  state.viewportPanning = false; state.panPointerId = null; updateHandTool();
}

function defaultFrameTransform() {
  return { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0, skewX: 0, skewY: 0, fill: null };
}

function activeTransformKey() {
  return state.transformScope === "all" ? "*" : String(state.selectedFrameIndex);
}

function activeFrameTransform() {
  const own = state.frameTransforms[activeTransformKey()];
  const inherited = state.transformScope === "frame" ? state.frameTransforms["*"] : null;
  return { ...defaultFrameTransform(), ...(own || inherited || {}) };
}

function syncTransformControls() {
  const transform = activeFrameTransform();
  const width = Math.round(transform.scaleX * 100); const height = Math.round(transform.scaleY * 100);
  $("#transformWidth").value = String(width); $("#transformWidthValue").textContent = `${width}%`;
  $("#transformHeight").value = String(height); $("#transformHeightValue").textContent = `${height}%`;
  $("#transformSkew").value = String(Math.round(transform.skewX)); $("#transformSkewValue").textContent = `${Math.round(transform.skewX)}°`;
  $("#transformSkewY").value = String(Math.round(transform.skewY)); $("#transformSkewYValue").textContent = `${Math.round(transform.skewY)}°`;
  $("#transformOffsetX").value = String(Math.round(transform.offsetX)); $("#transformOffsetY").value = String(Math.round(transform.offsetY));
  $("#transformFill").classList.toggle("active", transform.fill === "stretch");
  $("#transformFrameLabel").textContent = state.transformScope === "all" ? "вся анимация · выделено по прозрачности" : `кадр ${state.selectedFrameIndex + 1} · выделен по прозрачности`;
  $$("#transformScope button").forEach((button) => button.classList.toggle("selected", button.dataset.scope === state.transformScope));
}

function writeTransformFromControls(changedAxis = null) {
  let scaleX = Number($("#transformWidth").value) / 100;
  let scaleY = Number($("#transformHeight").value) / 100;
  if ($("#transformLock").checked && changedAxis === "x") { scaleY = scaleX; $("#transformHeight").value = String(Math.round(scaleY * 100)); }
  if ($("#transformLock").checked && changedAxis === "y") { scaleX = scaleY; $("#transformWidth").value = String(Math.round(scaleX * 100)); }
  const transform = {
    scaleX, scaleY,
    offsetX: Number($("#transformOffsetX").value) || 0,
    offsetY: Number($("#transformOffsetY").value) || 0,
    skewX: Number($("#transformSkew").value) || 0,
    skewY: Number($("#transformSkewY").value) || 0,
    fill: null,
  };
  state.frameTransforms[activeTransformKey()] = transform;
  syncTransformControls(); markPreviewDirty(); scheduleFramePreview(140); scheduleHistory("Трансформация объекта"); saveSessionSoon();
}

function setTransformPanel(open) {
  state.transformPanelOpen = Boolean(open);
  $("#transformPanel").classList.toggle("hidden", !state.transformPanelOpen);
  $("#transformTool").classList.toggle("active", state.transformPanelOpen);
  $("#transformTool").setAttribute("aria-pressed", String(state.transformPanelOpen));
  $("#previewImage").classList.toggle("transform-selected", state.transformPanelOpen);
  $("#compareView").classList.toggle("transform-selected", state.transformPanelOpen);
  $("#previewStage").classList.toggle("transform-open", state.transformPanelOpen);
  requestAnimationFrame(applyZoom);
  if (state.transformPanelOpen) { setPreviewMode("after"); syncTransformControls(); }
}

function changeZoom(delta) {
  state.zoom = Math.max(0.25, Math.min(4, Math.round((state.zoom + delta) * 4) / 4));
  applyZoom();
}

const previewBackdrops = ["checker", "white", "black", "green", "magenta", "scene"];

function closeBackdropMenu() {
  $("#backdropMenu").classList.add("hidden");
  $("#backdropToggle").setAttribute("aria-expanded", "false");
}

function setBackdrop(backdrop, persist = true) {
  if (!previewBackdrops.includes(backdrop)) return;
  const stage = $("#previewStage");
  previewBackdrops.forEach((name) => stage.classList.remove(`backdrop-${name}`));
  stage.classList.add(`backdrop-${backdrop}`);
  state.backdrop = backdrop;
  $("#backdropCurrentSwatch").className = `backdrop-swatch ${backdrop}`;
  $("#backdropToggle").title = `Подложка: ${$("#backdropMenu button[data-backdrop='" + backdrop + "']")?.textContent.trim() || backdrop} · только для просмотра`;
  $$("#backdropMenu button[data-backdrop]").forEach((button) => {
    const selected = button.dataset.backdrop === backdrop;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  if (typeof drawPlayer === "function") drawPlayer();
  if (persist && backdrop !== "scene") savePreferences();
}

function setPreviewMode(mode) {
  const wasGame = state.previewMode === "game";
  state.previewMode = mode;
  if (mode === "game" && !wasGame) {
    state.backdropBeforeGame = state.backdrop;
    setBackdrop("scene", false);
  } else if (mode !== "game" && wasGame && state.backdrop === "scene") {
    setBackdrop(state.backdropBeforeGame === "scene" ? "checker" : state.backdropBeforeGame, false);
  }
  $("#backdropMenu .scene-backdrop").classList.toggle("hidden", mode !== "game");
  closeBackdropMenu();
  $$(".preview-tabs button").forEach((button) => {
    const selected = button.dataset.preview === mode;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  $("#previewImage").classList.add("hidden"); $("#compareView").classList.add("hidden");
  $("#playerCanvas").classList.add("hidden"); $("#playerBar").classList.add("hidden");
  $("#previewStage").classList.toggle("game-mode", mode === "game");
  if ((mode === "animation" || mode === "game") && state.result && typeof showPlayer === "function" && showPlayer(mode)) {
    $("#previewEmpty").classList.add("hidden"); applyZoom(); return;
  }
  const inspection = state.framePreview;
  let url = null;
  if (mode === "before") url = inspection?.beforeUrl;
  if (mode === "after") url = inspection?.afterUrl;
  if (mode === "animation") url = state.result?.previewUrl;
  if (mode === "sheet") url = state.result?.sheetUrl;
  if (mode === "depth") url = state.result?.depthUrls?.[0];
  if (mode === "compare" && inspection) {
    $("#previewEmpty").classList.add("hidden");
    $("#compareBefore").src = inspection.beforeUrl; $("#compareAfter").src = inspection.afterUrl;
    $("#compareAfter").onload = () => applyZoom();
    $("#compareView").classList.remove("hidden"); updateComparePosition(); applyZoom(); return;
  }
  if (!url) { $("#previewEmpty").classList.remove("hidden"); return; }
  $("#previewEmpty").classList.add("hidden");
  $("#previewImage").onload = () => applyZoom();
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
    const remainderHint = $("#whiteRemainderHint");
    const count = result.whiteRemainders?.count || 0;
    remainderHint.classList.toggle("hidden", !count);
    if (count) remainderHint.textContent = "На прозрачном фоне видны замкнутые светлые области. Они могут быть деталями рисунка или остатками фона. Проверьте контур перед экспортом.";
    $("#framePreviewTabs").classList.remove("hidden");
    hideError();
    if (["before", "after", "compare"].includes(state.previewMode)) setPreviewMode(state.previewMode);
    else if (!state.result) setPreviewMode("after");
    if (!state.busy && state.keyMode === "ai") setStatus("Предпросмотр обработки обновлён", "done", 0);
    updateActionState();
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
  const batchExport = state.source.kind === "video-batch" && !previewOnly;
  if (batchExport) {
    state.batchItems.forEach((item) => { item.status = "pending"; item.detail = "Ожидает"; });
    $("#stopAfterCurrent").disabled = false;
    $("#stopAfterCurrent").textContent = "Остановить после текущего";
    $("#stopAfterCurrent").classList.remove("hidden");
    $("#retryBatch").classList.add("hidden");
    renderBatchQueue();
  }
  setStatus(previewOnly ? "Собираю предпросмотр…" : "Экспортирую набор…", "busy", 0.02);
  try {
    const request = {
      source: state.source, outputDir: previewOnly ? null : state.outputFolder,
      name: state.source.kind === "video-batch" ? null : $("#spriteName").value, options: collectOptions(), previewOnly,
    };
    if (!previewOnly && state.source.kind !== "video-batch" && typeof animationSetRequest === "function") {
      const animations = animationSetRequest(request.options);
      if (animations.length > 1) request.animations = animations;
    }
    const result = await window.spriteLab.build(request);
    if (result.batch) {
      finishBatchQueue(result);
      state.lastExportDir = result.outputDir;
      state.lastRevealPath = result.revealPath;
      const failureText = result.failed ? ` · с ошибкой: ${result.failed}` : "";
      const stoppedText = result.stopped ? " · очередь остановлена" : "";
      setStatus(`Готово · ${result.completed}/${result.total} видео${failureText}${stoppedText}`, result.failed ? "error" : "done", 1);
      $("#exportSummary").textContent = result.stopped
        ? `Готово наборов: ${result.completed}. Оставшиеся видео сохранены в очереди.`
        : result.failed
        ? `Готово наборов: ${result.completed} из ${result.total}. Не обработано: ${result.failures.map((item) => item.name).join(", ")}.`
        : `Готово: ${result.completed} наборов. Каждый ролик сохранён в отдельной папке с автоматическим именем.`;
      $("#exportSummary").classList.remove("hidden");
      $("#completionActions").classList.remove("hidden");
      if ($("#openAfterExport").checked && result.revealPath) window.spriteLab.revealOutput(result.revealPath);
      hideError();
      return;
    }
    if (result.multi && !previewOnly) {
      // The set export returns the atlas of all animations; keep the active preview intact.
      renderAtlasStatus?.(result);
    } else updatePreview(result);
    hideError();
    const reuseText = result.reusedRender ? " · использован готовый предпросмотр" : "";
    setStatus(`Готово · ${result.frameCount} кадров${reuseText}`, "done", 1);
    if (!previewOnly) {
      state.lastExportDir = result.outputDir;
      state.lastRevealPath = result.revealPath;
      const exported = collectExports();
      const details = [`${result.frameCount} кадров`];
      if (result.multi) details.push(`анимаций: ${result.animations.length} (${result.animations.map((item) => item.name).join(", ")})`);
      const pages = result.atlas?.pages?.length || 1;
      if (exported.sheet || exported.metadata) details.push(result.atlas ? `лист ${result.atlas.width} × ${result.atlas.height}${pages > 1 ? ` · листов: ${pages}` : ""}` : `лист ${result.cellWidth * result.columns} × ${result.cellHeight * result.rows}`);
      if (result.engineFiles?.length) details.push(`${({ phaser3: "Phaser 3", godot: "Godot 4", texturepacker: "TexturePacker JSON-hash" })[result.exportFormat] || result.exportFormat}: ${result.engineFiles.map(baseName).join(", ")}`);
      if (result.reusedRender) details.push("без повторной обработки кадров");
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
    if (batchExport) $("#stopAfterCurrent").classList.add("hidden");
  }
}

function savePreferences() {
  try {
    localStorage.setItem("spriteLab.preferences", JSON.stringify({
      schema: 4,
      keyMode: state.keyMode, solidKeyMode: state.solidKeyMode, anchor: state.anchor, outputFolder: state.outputFolder,
      preferredEditor: state.preferredEditor,
      backdrop: state.backdrop === "scene" ? state.backdropBeforeGame : state.backdrop,
      values: Object.fromEntries(preferenceValueIds.map((id) => [id, $(`#${id}`).value])),
      checks: Object.fromEntries(preferenceCheckIds.map((id) => [id, $(`#${id}`).checked])),
    }));
  } catch { /* Preferences are optional. */ }
}

function loadPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem("spriteLab.preferences") || "null");
    if (!saved) return;
    setBackdrop(previewBackdrops.includes(saved.backdrop) && saved.backdrop !== "scene" ? saved.backdrop : "checker", false);
    Object.entries(saved.values || {}).forEach(([id, value]) => { if ($(`#${id}`)) $(`#${id}`).value = value; });
    if (Number(saved.schema || 0) < 2) $("#aiSoftness").value = "0";
    $("#toleranceValue").textContent = $("#tolerance").value;
    $("#blackOutlineValue").textContent = $("#blackOutline").value;
    $("#blackFeatherValue").textContent = `${$("#blackFeather").value} px`;
    $("#aiCutoffValue").textContent = $("#aiCutoff").value;
    $("#aiSoftnessValue").textContent = `${$("#aiSoftness").value} px`;
    $("#fringeStrengthValue").textContent = $("#fringeStrength").value;
    $("#toningStrengthValue").textContent = `${$("#toningStrength").value}%`;
    Object.entries(saved.checks || {}).forEach(([id, value]) => { if ($(`#${id}`)) $(`#${id}`).checked = Boolean(value); });
    $("#fringeStrengthRow").classList.toggle("hidden", !$("#fringeCleanup").checked);
    state.solidKeyMode = saved.solidKeyMode || state.solidKeyMode;
    if (saved.keyMode) setKeyMode(saved.keyMode);
    if (saved.anchor) setAnchor(saved.anchor);
    state.preferredEditor = saved.preferredEditor || "photopea";
    $("#preferredEditor").value = state.preferredEditor;
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
$("#newProject").addEventListener("click", () => {
  localStorage.removeItem("spriteLab.session"); state.pendingSession = null; $("#sessionRestore").classList.add("hidden"); setSource(null); setTab("source");
});
$("#openProject").addEventListener("click", openProjectFile);
$("#openProjectImport").addEventListener("click", openProjectFile);
$("#saveProject").addEventListener("click", () => saveProjectFile(false));
$("#undoAction").addEventListener("click", undoWorkspace);
$("#redoAction").addEventListener("click", redoWorkspace);
$("#openCommands").addEventListener("click", openCommandPalette);
$("#continueToProcess").addEventListener("click", () => setTab("process"));
$("#restoreSession").addEventListener("click", restoreSavedSession);
$("#discardSession").addEventListener("click", () => {
  state.pendingSession = null; localStorage.removeItem("spriteLab.session"); $("#sessionRestore").classList.add("hidden");
});
$("#chooseSource").addEventListener("click", () => chooseSource("chooseSource"));
$("#chooseFolder").addEventListener("click", () => chooseSource("chooseFolder"));
$("#chooseSheet").addEventListener("click", () => chooseSource("chooseSheet"));
$("#sheetSliceMode").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-sheet-mode]");
  if (!button) return;
  $$("#sheetSliceMode button").forEach((item) => item.classList.toggle("selected", item === button));
  $("#sheetGridFields").classList.toggle("hidden", button.dataset.sheetMode !== "grid");
  $("#sheetManualEditor").classList.toggle("hidden", button.dataset.sheetMode !== "manual");
});
$("#resliceSheet").addEventListener("click", async () => {
  if (!state.source?.sheetPath || state.busy) return;
  const mode = $("#sheetSliceMode button.selected")?.dataset.sheetMode || "objects";
  try {
    setStatus("Ищу отдельные объекты на листе…", "busy", 0.1);
    const source = await window.spriteLab.resliceSheet({
      sheetPath: state.source.sheetPath,
      options: { mode, columns: Number($("#sheetColumns").value), rows: Number($("#sheetRows").value), cells: state.sheetDraftCells },
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
// The drop itself is handled for the whole window in studio.js (overlay).
for (const eventName of ["dragleave", "drop"]) $("#dropZone").addEventListener(eventName, () => { $("#dropZone").classList.remove("dragging"); });

$("#keyMode").addEventListener("click", (event) => { const button = event.target.closest("button[data-value]"); if (button) { setKeyMode(button.dataset.value); scheduleFramePreview(); pushHistory("Фон изменён"); } });
$("#solidKeyColor").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-key-color]");
  if (!button) return;
  state.solidKeyMode = button.dataset.keyColor; setKeyMode(state.solidKeyMode); scheduleFramePreview(); pushHistory("Цвет фона изменён");
});
// Any colour can be the key, not only the four common ones.
$("#customKeyColor").addEventListener("input", (event) => {
  const value = String(event.target.value || "").toLowerCase();
  if (!hexToRgb(value)) return;
  state.solidKeyMode = value;
  setKeyMode("custom");
  scheduleFramePreview(200);
});
$("#customKeyColor").addEventListener("change", () => { savePreferences(); scheduleHistory("Свой цвет фона"); });
$("#keyScope").addEventListener("change", () => { savePreferences(); markPreviewDirty(); scheduleFramePreview(0); pushHistory("Область удаления фона изменена"); });
$("#inspectContour").addEventListener("click", async () => {
  try { await openMaskEditor({ review: true }); } catch (error) { setStatus(error.message || "Не удалось открыть контур", "error", 0); showError(error.message); }
});
for (const id of ["edgeRefineMode", "edgeRefineWidth", "edgeRefineDepth", "edgeRefineWhiteOnly"]) {
  $(`#${id}`).addEventListener("change", () => { savePreferences(); markPreviewDirty(); scheduleFramePreview(0); scheduleHistory("Очистка кромки изменена"); });
}
$("#anchorMode").addEventListener("click", (event) => { const button = event.target.closest("button[data-value]"); if (button) { setAnchor(button.dataset.value); savePreferences(); pushHistory("Стабилизация изменена"); } });
$("#processPresets").addEventListener("click", (event) => { const button = event.target.closest("button[data-preset]"); if (button) applyProcessPreset(button.dataset.preset); });
$("#resetSettings").addEventListener("click", resetRecommended);
$("#tolerance").addEventListener("input", (event) => { $("#toleranceValue").textContent = event.target.value; markPreviewDirty(); scheduleFramePreview(); });
$("#blackOutline").addEventListener("input", (event) => { $("#blackOutlineValue").textContent = event.target.value; markPreviewDirty(); scheduleFramePreview(); });
$("#blackFeather").addEventListener("input", (event) => { $("#blackFeatherValue").textContent = `${event.target.value} px`; markPreviewDirty(); scheduleFramePreview(); });
$("#aiCutoff").addEventListener("input", (event) => { $("#aiCutoffValue").textContent = event.target.value; markPreviewDirty(); scheduleFramePreview(380); });
$("#aiSoftness").addEventListener("input", (event) => { $("#aiSoftnessValue").textContent = `${event.target.value} px`; markPreviewDirty(); scheduleFramePreview(380); });
$("#aiAutoCutoff").addEventListener("change", () => {
  $("#aiCutoff").disabled = $("#aiAutoCutoff").checked;
  savePreferences(); markPreviewDirty(); scheduleFramePreview(0); scheduleHistory("Порог ИИ изменён");
});
$("#aiQuality").addEventListener("change", () => {
  savePreferences(); markPreviewDirty(); scheduleFramePreview(0); scheduleHistory("Качество ИИ изменено");
});
$("#pixelateEnabled").addEventListener("change", () => {
  savePreferences(); markPreviewDirty(); scheduleFramePreview(0); pushHistory($("#pixelateEnabled").checked ? "Пиксель-арт включён" : "Пиксель-арт выключен");
});
for (const id of ["toningEnabled", "toningColor", "toningStrength"]) {
  $(`#${id}`).addEventListener(id === "toningStrength" ? "input" : "change", () => {
    $("#toningStrengthValue").textContent = `${$("#toningStrength").value}%`;
    savePreferences(); markPreviewDirty(); scheduleFramePreview(180); scheduleHistory("Тонировка изменена");
  });
}
for (const id of ["pixelateSize", "pixelateColors", "pixelateShading"]) {
  $(`#${id}`).addEventListener("change", () => { savePreferences(); markPreviewDirty(); scheduleFramePreview(0); scheduleHistory("Настройки пиксель-арта изменены"); });
}
for (const id of ["pixelatePalette", "pixelateMode", "pixelateDither"]) {
  $(`#${id}`).addEventListener("change", () => { savePreferences(); markPreviewDirty(); scheduleFramePreview(0); scheduleHistory("Стиль пиксель-арта изменён"); });
}
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
  state.maskEdits = []; updateMaskEditSummary(); markPreviewDirty(); scheduleFramePreview(0); pushHistory("Исправления маски очищены");
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
  closeMaskEditor(); markPreviewDirty(); pushHistory("Исправлена маска"); setStatus("Исправления маски применены · проверяю кадр", "busy", 0.1); scheduleFramePreview(0);
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
    state.preferredEditor = button.dataset.onlineEditor;
    $("#preferredEditor").value = state.preferredEditor;
    savePreferences();
    await window.spriteLab.openOnlineFrameEditor({ path: state.externalEdit.path, editor: button.dataset.onlineEditor });
    setFrameEditorStatus("Редактор открыт · путь к PNG скопирован", "busy");
  } catch (error) { setFrameEditorStatus(error.message || "Не удалось открыть онлайн-редактор", "error"); }
}));
$("#replaceEditedFrame").addEventListener("click", async () => {
  try { await replaceExternalEdit(); } catch (error) { setFrameEditorStatus(error.message || "Не удалось заменить кадр", "error"); }
});
$("#preferredEditor").addEventListener("change", (event) => { state.preferredEditor = event.target.value; savePreferences(); });
$("#openPreferredEditor").addEventListener("click", async () => {
  if (!state.externalEdit) return;
  try {
    await window.spriteLab.openOnlineFrameEditor({ path: state.externalEdit.path, editor: state.preferredEditor });
    setFrameEditorStatus("Редактор открыт · путь к PNG скопирован", "busy");
  } catch (error) { setFrameEditorStatus(error.message || "Не удалось открыть онлайн-редактор", "error"); }
});
for (const eventName of ["dragenter", "dragover"]) $("#editedFrameDrop").addEventListener(eventName, (event) => { event.preventDefault(); $("#editedFrameDrop").classList.add("dragging"); });
for (const eventName of ["dragleave", "drop"]) $("#editedFrameDrop").addEventListener(eventName, (event) => { event.preventDefault(); $("#editedFrameDrop").classList.remove("dragging"); });
$("#editedFrameDrop").addEventListener("drop", async (event) => {
  try { await replaceExternalEditFromDrop(event.dataTransfer.files?.[0]); }
  catch (error) { setFrameEditorStatus(error.message || "Не удалось принять файл", "error"); }
});
$("#editedFrameDrop").addEventListener("click", replaceExternalEdit);
$("#editedFrameDrop").addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") replaceExternalEdit(); });
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
  setTimeout(() => { $("#copyOutputPath").textContent = "Копировать путь"; }, 1400);
});
$("#exportPreset").addEventListener("change", (event) => applyExportPreset(event.target.value));
$("#saveExportProfile").addEventListener("click", () => { $("#saveExportProfile").classList.add("hidden"); $("#profileNameRow").classList.remove("hidden"); $("#profileName").focus(); });
// The recipe is the same file the command line reads, so a session built by hand here
// can be repeated without the interface.
$("#saveBuildRecipe").addEventListener("click", async () => {
  if (!state.source) { setStatus("Сначала выберите источник", "error", 0); return; }
  try {
    const profile = {
      format: "chuba-sprite-lab-profile",
      version: 1,
      name: $("#spriteName").value || "sprite-animation",
      ...(state.outputFolder ? { outputDir: state.outputFolder } : {}),
      source: sourceDescriptor(),
      options: collectOptions(),
    };
    const saved = await window.spriteLab.saveProfile({ profile });
    if (saved) setStatus(`Рецепт сборки сохранён: ${saved.path}`, "done", 0);
  } catch (error) {
    setStatus(error.message || "Не удалось сохранить рецепт сборки", "error", 0);
    showError(error.message || "Не удалось сохранить рецепт сборки.");
  }
});
$("#confirmProfile").addEventListener("click", saveCurrentExportProfile);
$("#deleteExportProfile").addEventListener("click", () => {
  const key = $("#exportPreset").value;
  if (!key.startsWith("user:")) return;
  delete customExportProfiles[key];
  localStorage.setItem("spriteLab.exportProfiles", JSON.stringify(customExportProfiles));
  loadCustomExportProfiles(); $("#exportPreset").value = "chuba"; applyExportPreset("chuba");
  setStatus("Пользовательский профиль удалён", "done", 0);
});
$("#cancelProfile").addEventListener("click", () => { $("#profileNameRow").classList.add("hidden"); $("#saveExportProfile").classList.remove("hidden"); });
$("#profileName").addEventListener("keydown", (event) => { if (event.key === "Enter") saveCurrentExportProfile(); });
Object.entries(exportControls).forEach(([name, selector]) => $(selector).addEventListener("change", () => syncExportDependencies(name)));
$("#spriteName").addEventListener("input", () => {
  state.lastExportDir = null; state.lastRevealPath = null;
  $("#completionActions").classList.add("hidden"); $("#exportSummary").classList.add("hidden");
  updateActionState();
});

$$(".preview-tabs button").forEach((button) => button.addEventListener("click", () => setPreviewMode(button.dataset.preview)));
$("#cancelJob").addEventListener("click", () => window.spriteLab.cancelBuild());
$("#stopAfterCurrent").addEventListener("click", async () => {
  if (await window.spriteLab.stopBatchAfterCurrent()) {
    $("#stopAfterCurrent").disabled = true; $("#stopAfterCurrent").textContent = "Остановится после текущего";
  }
});
$("#retryBatch").addEventListener("click", () => {
  const failed = state.batchItems.filter((item) => item.status === "failed");
  if (!failed.length || state.busy) return;
  state.source.paths = failed.map((item) => item.path); state.source.batchCount = failed.length;
  initializeBatchQueue(state.source.paths); updateActionState(); runBuild(false);
});
$("#previousWarning").addEventListener("click", () => selectWarning(-1));
$("#nextWarning").addEventListener("click", () => selectWarning(1));
$("#handTool").addEventListener("click", () => {
  state.handToolLocked = !state.handToolLocked; updateHandTool();
});
$("#transformTool").addEventListener("click", () => setTransformPanel(!state.transformPanelOpen));
$("#closeTransform").addEventListener("click", () => setTransformPanel(false));
$("#transformScope").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-scope]");
  if (!button) return;
  state.transformScope = button.dataset.scope; syncTransformControls();
});
$("#transformWidth").addEventListener("input", () => writeTransformFromControls("x"));
$("#transformHeight").addEventListener("input", () => writeTransformFromControls("y"));
$("#transformSkew").addEventListener("input", () => writeTransformFromControls("skew"));
$("#transformSkewY").addEventListener("input", () => writeTransformFromControls("skew"));
$("#transformOffsetX").addEventListener("change", () => writeTransformFromControls("offset"));
$("#transformOffsetY").addEventListener("change", () => writeTransformFromControls("offset"));
let transformDrag = null;
$("#previewImage").addEventListener("pointerdown", (event) => {
  if (!state.transformPanelOpen || handToolActive() || event.button !== 0 || !state.result) return;
  event.preventDefault();
  transformDrag = { x: event.clientX, y: event.clientY, offsetX: Number($("#transformOffsetX").value) || 0, offsetY: Number($("#transformOffsetY").value) || 0 };
  event.currentTarget.setPointerCapture(event.pointerId);
});
$("#previewImage").addEventListener("pointermove", (event) => {
  if (!transformDrag) return;
  const width = Math.max(1, state.result.cellWidth * state.fitScale * state.zoom);
  const height = Math.max(1, state.result.cellHeight * state.fitScale * state.zoom);
  $("#transformOffsetX").value = String(Math.round(Math.max(-100, Math.min(100, transformDrag.offsetX + (event.clientX - transformDrag.x) / width * 100))));
  $("#transformOffsetY").value = String(Math.round(Math.max(-100, Math.min(100, transformDrag.offsetY + (event.clientY - transformDrag.y) / height * 100))));
  writeTransformFromControls("offset");
});
for (const name of ["pointerup", "pointercancel"]) $("#previewImage").addEventListener(name, () => { transformDrag = null; });
$("#transformFill").addEventListener("click", () => {
  state.frameTransforms[activeTransformKey()] = { ...activeFrameTransform(), fill: "stretch", scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0, skewX: 0, skewY: 0 };
  syncTransformControls(); markPreviewDirty(); scheduleFramePreview(0); pushHistory("Объект растянут до краёв");
});
$("#transformShrink").addEventListener("click", () => {
  const transform = activeFrameTransform();
  transform.fill = null; transform.scaleX = Math.max(.25, transform.scaleX * .85); transform.scaleY = Math.max(.25, transform.scaleY * .85);
  state.frameTransforms[activeTransformKey()] = transform;
  syncTransformControls(); markPreviewDirty(); scheduleFramePreview(0); pushHistory("Объект уменьшен");
});
$("#transformReset").addEventListener("click", () => {
  delete state.frameTransforms[activeTransformKey()];
  syncTransformControls(); markPreviewDirty(); scheduleFramePreview(0); pushHistory("Трансформация объекта сброшена");
});
$("#previewStage").addEventListener("pointerdown", (event) => {
  if (!handToolActive() || event.button !== 0 || event.target.closest(".stage-tools, .transform-panel, .error-card, .player-bar") || (!state.framePreview && !state.result)) return;
  event.preventDefault();
  state.viewportPanning = true; state.panPointerId = event.pointerId;
  state.panStartClientX = event.clientX; state.panStartClientY = event.clientY;
  state.panStartX = state.viewportPanX; state.panStartY = state.viewportPanY;
  event.currentTarget.setPointerCapture(event.pointerId); updateHandTool();
});
$("#previewStage").addEventListener("pointermove", (event) => {
  if (!state.viewportPanning || event.pointerId !== state.panPointerId) return;
  state.viewportPanX = state.panStartX + event.clientX - state.panStartClientX;
  state.viewportPanY = state.panStartY + event.clientY - state.panStartClientY;
  applyZoom();
});
for (const eventName of ["pointerup", "pointercancel", "lostpointercapture"]) {
  $("#previewStage").addEventListener(eventName, stopViewportPan);
}
$("#zoomOut").addEventListener("click", () => changeZoom(-0.25));
$("#zoomIn").addEventListener("click", () => changeZoom(0.25));
$("#zoomFit").addEventListener("click", () => { state.zoom = 1; state.viewportPanX = 0; state.viewportPanY = 0; applyZoom(); });
new ResizeObserver(() => applyZoom()).observe($("#previewStage"));
$("#toggleGuides").addEventListener("click", () => {
  state.guides = !state.guides;
  $("#toggleGuides").classList.toggle("active", state.guides);
  $("#toggleGuides").setAttribute("aria-pressed", String(state.guides));
  updateGuideGrid();
});
$("#gridSpacing").addEventListener("change", updateGuideGrid);
$("#backdropToggle").addEventListener("click", () => {
  const open = $("#backdropMenu").classList.toggle("hidden") === false;
  $("#backdropToggle").setAttribute("aria-expanded", String(open));
});
$("#backdropMenu").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-backdrop]");
  if (!button) return;
  setBackdrop(button.dataset.backdrop);
  closeBackdropMenu();
  $("#backdropToggle").focus();
});
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".backdrop-control")) closeBackdropMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#backdropMenu").classList.contains("hidden")) {
    closeBackdropMenu();
    $("#backdropToggle").focus();
  }
});
$("#closeError").addEventListener("click", hideError);
$("#safeSettings").addEventListener("click", () => { resetRecommended(); hideError(); });
$("#showErrorFrame").addEventListener("click", () => { hideError(); if (state.result) selectFrame(state.selectedFrameIndex); });
$("#minimizeWindow").addEventListener("click", () => window.spriteLab.minimize());
$("#maximizeWindow").addEventListener("click", () => window.spriteLab.maximize());
$("#closeWindow").addEventListener("click", () => window.spriteLab.close());
$("#aboutApp").addEventListener("click", openAbout);
$("#closeAbout").addEventListener("click", closeAbout);
$("#aboutModal").addEventListener("click", (event) => { if (event.target === $("#aboutModal")) closeAbout(); });
$("#closeCommands").addEventListener("click", closeCommandPalette);
$("#commandModal").addEventListener("click", (event) => { if (event.target === $("#commandModal")) closeCommandPalette(); });
$("#commandSearch").addEventListener("input", (event) => {
  const query = event.target.value.trim().toLocaleLowerCase("ru");
  $$("#commandList button").forEach((button) => button.classList.toggle("hidden", query && !button.textContent.toLocaleLowerCase("ru").includes(query)));
});
$("#commandList").addEventListener("click", (event) => { const button = event.target.closest("button[data-command]"); if (button) runCommand(button.dataset.command); });
$("#checkUpdates").addEventListener("click", checkForUpdates);
$("#openRepository").addEventListener("click", () => window.spriteLab.openRepository());
for (const id of ["fps", "columns", "cellWidth", "cellHeight", "padding", "maxFrames", "pixelPerfect", "removeDuplicates", "whiteOutput", "trimStart", "trimEnd"]) {
  $(`#${id}`).addEventListener("change", () => { markPreviewDirty(); savePreferences(); scheduleHistory("Настройки обработки изменены"); });
}
$("#openAfterExport").addEventListener("change", savePreferences);

for (const id of ["tolerance", "blackOutline", "blackFeather", "aiCutoff", "aiSoftness", "fringeStrength"]) {
  $(`#${id}`).addEventListener("change", () => scheduleHistory("Настройки обработки изменены"));
}

document.addEventListener("keydown", (event) => {
  const editingText = ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName) || event.target.isContentEditable;
  const modalOpen = Boolean($(".modal-backdrop:not(.hidden)"));
  if (event.code !== "Space" || event.repeat || editingText || modalOpen) return;
  event.preventDefault(); state.spaceHand = true; updateHandTool();
});
document.addEventListener("keyup", (event) => {
  if (event.code !== "Space") return;
  event.preventDefault(); state.spaceHand = false; stopViewportPan(); updateHandTool();
});
window.addEventListener("blur", () => { state.spaceHand = false; stopViewportPan(); updateHandTool(); });

document.addEventListener("keydown", (event) => {
  const openModal = $$(".modal-backdrop:not(.hidden)")[0];
  if (openModal) trapModalFocus(openModal, event);
  if (event.key === "Escape" && state.transformPanelOpen) { setTransformPanel(false); return; }
  if (event.key === "Escape" && !$("#commandModal").classList.contains("hidden")) { closeCommandPalette(); return; }
  if (event.key === "Escape" && !$("#frameEditorModal").classList.contains("hidden")) { closeFrameEditor(); return; }
  if (event.key === "Escape" && !$("#attachmentModal").classList.contains("hidden")) { closeAttachmentEditor(); return; }
  if (event.key === "Escape" && !$("#aiMaskModal").classList.contains("hidden")) { closeMaskEditor({ discard: true }); return; }
  if (event.key === "Escape" && !$("#aboutModal").classList.contains("hidden")) { closeAbout(); return; }
  if (event.key === "Escape" && state.busy) window.spriteLab.cancelBuild();
  if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === "k") { event.preventDefault(); openCommandPalette(); return; }
  if (event.ctrlKey && event.key === "Enter") {
    event.preventDefault();
    if (!$("#buildPreview").disabled) runBuild(true);
    else if (!state.busy) setStatus($("#buildPreview").title || "Сборка сейчас недоступна", "error", 0);
    return;
  }
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "o") { event.preventDefault(); openProjectFile(); return; }
  if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === "o") { event.preventDefault(); chooseSource("chooseSource"); return; }
  if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === "s") { event.preventDefault(); saveProjectFile(false); return; }
  const editingText = ["INPUT", "TEXTAREA"].includes(event.target.tagName) || event.target.isContentEditable;
  if (!editingText && event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === "z") { event.preventDefault(); undoWorkspace(); return; }
  if (!editingText && event.ctrlKey && (event.key.toLowerCase() === "y" || (event.shiftKey && event.key.toLowerCase() === "z"))) { event.preventDefault(); redoWorkspace(); return; }
  if (event.ctrlKey && ["1", "2", "3"].includes(event.key)) { event.preventDefault(); setTab(({ 1: "source", 2: "process", 3: "export" })[event.key]); }
});

window.spriteLab.onProgress((progress) => {
  if (!state.busy) return;
  updateBatchProgress(progress);
  setStatus(progress.message || "Обработка…", "busy", progress.value || 0);
});
window.spriteLab.onUpdateProgress((progress) => {
  const status = $("#updateStatus");
  status.className = progress.value >= 1 ? "update-status success" : "update-status busy";
  status.textContent = progress.message || "Проверяю обновления…";
});

$$("button.selected").forEach((button) => button.setAttribute("aria-pressed", "true"));
loadCustomExportProfiles(); setBackdrop("checker", false); loadPreferences(); syncAutoSize(); updateMaskEditSummary(); renderAttachmentList(); updateActionState(); syncExportDependencies(""); setPreviewMode("after"); setStatus("Готов к работе"); loadSessionOffer();
window.spriteLab.getAppInfo().then((info) => {
  $("#versionBadge").textContent = info.version;
  $("#aboutVersion").textContent = info.version;
}).catch(() => {});
