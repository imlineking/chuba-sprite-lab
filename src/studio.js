/* Chuba Sprite Lab 1.7 — studio features.
 * Loaded after renderer.js as a classic script, so it shares its globals
 * ($, $$, state, setStatus, runBuild…). Everything here is additive:
 * timeline, canvas player with onion skin and loop modes, game-scale preview,
 * atlas status, named animations, hotkeys and whole-window drag & drop. */

const studio = {
  images: [], preparedBySource: new Map(), cellWidth: 0, cellHeight: 0, pivot: { x: 0.5, y: 1 },
  playing: true, position: 0, elapsed: 0, lastTime: 0, raf: 0,
  onion: false, onionOpacity: 0.35, gameScale: 1, hitbox: true,
  bounds: new Map(), maskOnionImages: new Map(), dragId: null, entrySeed: 0,
};

/* ---------------------------------------------------------------- helpers */

function studioModalOpen() {
  return Boolean($(".modal-backdrop:not(.hidden)"));
}

function isEditingTarget(target) {
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName) || target?.isContentEditable;
}

function baseDurationMs() {
  return Math.round(1000 / Math.max(1, Math.min(60, Number($("#fps").value) || 8)));
}

function saveStudioPreferences() {
  try {
    localStorage.setItem("spriteLab.studio", JSON.stringify({
      packing: $("#atlasPacking").value, exportFormat: $("#exportFormat").value,
      atlasMaxSize: $("#atlasMaxSize").value, atlasOverflow: $("#atlasOverflow").value,
      onionOpacity: studio.onionOpacity, gameScale: studio.gameScale, hitbox: studio.hitbox,
    }));
  } catch { /* optional */ }
}

function loadStudioPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem("spriteLab.studio") || "null");
    if (!saved) return;
    if (saved.packing) $("#atlasPacking").value = saved.packing;
    if (saved.exportFormat) $("#exportFormat").value = saved.exportFormat;
    if (saved.atlasMaxSize != null) $("#atlasMaxSize").value = String(saved.atlasMaxSize);
    if (saved.atlasOverflow) $("#atlasOverflow").value = saved.atlasOverflow;
    if (saved.onionOpacity) { studio.onionOpacity = Number(saved.onionOpacity) || 0.35; $("#onionOpacity").value = String(Math.round(studio.onionOpacity * 100)); }
    if (saved.gameScale) studio.gameScale = Number(saved.gameScale) || 1;
    if (saved.hitbox === false) studio.hitbox = false;
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------ loop modes */

function setLoopMode(mode, { silent = false } = {}) {
  const value = ["loop", "pingpong", "range"].includes(mode) ? mode : "loop";
  $$("#loopMode button").forEach((button) => {
    const selected = button.dataset.loop === value;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  $("#loopRangeFields").classList.toggle("hidden", value !== "range");
  $("#loopHint").textContent = ({ loop: "по кругу", pingpong: "вперёд и назад", range: "только выбранные кадры" })[value];
  if (!silent) loopChanged("Режим цикла изменён");
}

function loopChanged(label) {
  studio.position = 0; studio.elapsed = 0;
  refreshPlayer();
  state.lastExportDir = null;
  if (!state.historyApplying) scheduleHistory(label);
  saveSessionSoon();
}

// Mirrors resolveLoop()/playbackOrder() from processor.mjs.
function playerOrder(length) {
  const { loopMode, loopRange } = loopOptions();
  const last = Math.max(0, length - 1);
  let from = 0; let to = last;
  if (loopMode === "range") {
    from = Math.max(0, Math.min(last, Math.round(Number(loopRange?.from) || 0)));
    to = loopRange?.to == null ? last : Math.max(from, Math.min(last, Math.round(Number(loopRange.to))));
  }
  const range = [];
  for (let index = from; index <= to && index < length; index += 1) range.push(index);
  if (loopMode === "pingpong" && range.length > 2) return [...range, ...range.slice(1, -1).reverse()];
  return range;
}

/* -------------------------------------------------------------- timeline */

function newEntryId() {
  studio.entrySeed += 1;
  return `d${Date.now().toString(36)}${studio.entrySeed}`;
}

function ensureEditableTimeline() {
  if (!state.result) return null;
  if (!Array.isArray(state.timeline) || !state.timeline.length) state.timeline = timelineEntries().map((entry) => ({ ...entry }));
  else state.timeline = timelineEntries().map((entry) => ({ ...entry }));
  return state.timeline;
}

function timelineChanged(label) {
  buildFilmstrip(state.result);
  refreshPlayer();
  state.lastExportDir = null;
  pushHistory(label);
  saveSessionSoon();
  updateActionState();
}

function selectedEntry() {
  return timelineEntries().find((entry) => entry.id === state.selectedEntryId) || null;
}

function moveEntry(entryId, targetId, after = false) {
  const timeline = ensureEditableTimeline();
  if (!timeline || entryId === targetId) return;
  const from = timeline.findIndex((entry) => entry.id === entryId);
  if (from < 0) return;
  const [entry] = timeline.splice(from, 1);
  let to = timeline.findIndex((item) => item.id === targetId);
  if (to < 0) to = timeline.length; else if (after) to += 1;
  timeline.splice(to, 0, entry);
  state.selectedEntryId = entry.id;
  timelineChanged("Порядок кадров изменён");
  setStatus(`Кадр ${entry.src + 1} перемещён на позицию ${to + 1}`, "done", 0);
}

function moveSelectedEntry(delta) {
  const entries = timelineEntries();
  const index = entries.findIndex((entry) => entry.id === state.selectedEntryId);
  const target = entries[index + delta];
  if (index < 0 || !target) return;
  moveEntry(entries[index].id, target.id, delta > 0);
}

function duplicateSelectedEntry() {
  if (!state.result || state.source?.kind === "video-batch") return;
  const timeline = ensureEditableTimeline();
  const index = timeline.findIndex((entry) => entry.id === state.selectedEntryId);
  if (index < 0) return;
  const copy = { ...timeline[index], id: newEntryId() };
  timeline.splice(index + 1, 0, copy);
  state.selectedEntryId = copy.id;
  timelineChanged("Кадр продублирован");
  setStatus(`Кадр ${copy.src + 1} повторён в таймлайне`, "done", 0);
}

// Del: a repeated entry is removed from the timeline; a unique one is excluded.
function removeOrExcludeSelected() {
  if (!state.result || state.source?.kind === "video-batch") return;
  const entries = timelineEntries();
  const entry = entries.find((item) => item.id === state.selectedEntryId);
  if (!entry) return;
  const repeats = entries.filter((item) => item.src === entry.src).length;
  if (repeats > 1) {
    const timeline = ensureEditableTimeline();
    const index = timeline.findIndex((item) => item.id === entry.id);
    timeline.splice(index, 1);
    const next = timeline[Math.min(index, timeline.length - 1)];
    state.selectedEntryId = next?.id || null;
    timelineChanged("Повтор кадра удалён");
    if (next) selectFrame(next.src, false, next.id);
    return;
  }
  toggleSelectedFrame();
  buildFilmstrip(state.result); refreshPlayer();
}

function stepSelection(delta) {
  const entries = timelineEntries();
  if (!entries.length) return;
  const index = entries.findIndex((entry) => entry.id === state.selectedEntryId);
  const next = entries[Math.max(0, Math.min(entries.length - 1, (index < 0 ? 0 : index + delta)))];
  selectFrame(next.src, state.previewMode !== "animation" && state.previewMode !== "game", next.id);
}

function syncFrameDurationControl(entry) {
  const input = $("#frameDuration");
  input.placeholder = String(baseDurationMs());
  input.title = `Пусто — по FPS (${baseDurationMs()} мс)`;
  input.value = entry && Number(entry.d) > 0 ? String(entry.d) : "";
  input.disabled = !entry || state.source?.kind === "video-batch";
  $("#duplicateFrame").disabled = !entry || state.source?.kind === "video-batch";
}

function setSelectedDuration(value) {
  const timeline = ensureEditableTimeline();
  const entry = timeline?.find((item) => item.id === state.selectedEntryId);
  if (!entry) return;
  const ms = Number(value);
  entry.d = Number.isFinite(ms) && ms > 0 ? Math.max(10, Math.min(10000, Math.round(ms))) : null;
  timelineChanged("Длительность кадра");
  setStatus(entry.d ? `Кадр ${entry.src + 1}: ${entry.d} мс (попадёт в JSON durationMs)` : `Кадр ${entry.src + 1}: длительность по FPS`, "done", 0);
}

function bindTimelineDrag(strip) {
  if (strip.dataset.dragBound) return;
  strip.dataset.dragBound = "true";
  const clearMarks = () => $$("#filmstrip button").forEach((button) => button.classList.remove("drop-before", "drop-after", "dragging"));
  strip.addEventListener("dragstart", (event) => {
    const button = event.target.closest("button[data-entry-id]");
    if (!button) return;
    studio.dragId = button.dataset.entryId;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", studio.dragId);
    button.classList.add("dragging");
  });
  strip.addEventListener("dragover", (event) => {
    if (!studio.dragId) return;
    const button = event.target.closest("button[data-entry-id]");
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    $$("#filmstrip button").forEach((item) => item.classList.remove("drop-before", "drop-after"));
    if (!button) return;
    const rect = button.getBoundingClientRect();
    button.classList.add(event.clientX > rect.left + rect.width / 2 ? "drop-after" : "drop-before");
  });
  strip.addEventListener("drop", (event) => {
    if (!studio.dragId) return;
    event.preventDefault();
    event.stopPropagation();
    const button = event.target.closest("button[data-entry-id]");
    const dragId = studio.dragId;
    studio.dragId = null;
    clearMarks();
    if (!button) return;
    const rect = button.getBoundingClientRect();
    moveEntry(dragId, button.dataset.entryId, event.clientX > rect.left + rect.width / 2);
  });
  strip.addEventListener("dragend", () => { studio.dragId = null; clearMarks(); });
}

/* ---------------------------------------------------------------- player */

function loadPlayerFrames(result) {
  studio.bounds.clear();
  studio.preparedBySource = new Map((result.sourceFrameIndexes || []).map((sourceIndex, index) => [sourceIndex, index]));
  studio.cellWidth = result.cellWidth; studio.cellHeight = result.cellHeight;
  studio.pivot = result.pivot || { x: 0.5, y: 1 };
  studio.position = 0; studio.elapsed = 0;
  studio.images = (result.frameUrls || []).map((url) => {
    const image = new Image();
    image.onload = () => drawPlayer();
    image.src = url;
    return image;
  });
}

// Live playback sequence: the current timeline (order, repeats, durations),
// minus frames excluded after the last build. Mirrors buildSequence().
function playerSequence() {
  const base = baseDurationMs();
  const sequence = [];
  const used = new Set();
  for (const entry of timelineEntries()) {
    if (state.excludedFrames.has(entry.src)) continue;
    const image = studio.preparedBySource.get(entry.src);
    if (image == null) continue;
    used.add(image);
    sequence.push({ image, src: entry.src, id: entry.id, durationMs: Number(entry.d) > 0 ? Number(entry.d) : base });
  }
  studio.images.forEach((_image, index) => {
    const src = state.result?.sourceFrameIndexes?.[index];
    if (!used.has(index) && !state.excludedFrames.has(src)) sequence.push({ image: index, src, id: null, durationMs: base });
  });
  return sequence;
}

function playerState() {
  const sequence = playerSequence();
  const order = playerOrder(sequence.length);
  const position = order.length ? ((studio.position % order.length) + order.length) % order.length : 0;
  return { sequence, order, position, current: sequence[order[position]] };
}

function refreshPlayer() {
  if (!state.result) return;
  const { sequence } = playerState();
  if (!state.result.multi) {
    $("#metaFrames").textContent = String(sequence.length);
    if (!state.resultDirty && state.source?.kind !== "video-batch" && state.animations.length <= 1) {
      $("#exportButtonTitle").textContent = `ЭКСПОРТИРОВАТЬ ${sequence.length} КАДРОВ`;
    }
  }
  drawPlayer();
}

function playerVisible() {
  return !$("#playerCanvas").classList.contains("hidden");
}

function showPlayer(mode) {
  if (!studio.images.length) return false;
  $("#playerCanvas").classList.remove("hidden");
  $("#playerBar").classList.remove("hidden");
  const game = mode === "game";
  $("#gameScaleGroup").classList.toggle("hidden", !game);
  $("#hitboxToggle").classList.toggle("hidden", !game);
  syncPlayerControls();
  startPlayerLoop();
  requestAnimationFrame(() => drawPlayer());
  return true;
}

function syncPlayerControls() {
  $("#playerPlay").textContent = studio.playing ? "❚❚" : "▶";
  $("#playerPlay").setAttribute("aria-label", studio.playing ? "Пауза" : "Воспроизвести");
  $("#onionToggle").classList.toggle("active", studio.onion);
  $("#onionToggle").setAttribute("aria-pressed", String(studio.onion));
  $("#onionOpacity").disabled = !studio.onion;
  $("#hitboxToggle").classList.toggle("active", studio.hitbox);
  $("#hitboxToggle").setAttribute("aria-pressed", String(studio.hitbox));
  $$("#gameScaleGroup button").forEach((button) => button.classList.toggle("selected", Number(button.dataset.gameScale) === studio.gameScale));
}

function startPlayerLoop() {
  if (studio.raf) return;
  studio.lastTime = performance.now();
  const tick = (now) => {
    if (!playerVisible()) { studio.raf = 0; return; }
    const delta = Math.min(250, now - studio.lastTime);
    studio.lastTime = now;
    if (studio.playing) {
      const { order, current } = playerState();
      if (order.length > 1 && current) {
        studio.elapsed += delta;
        let guard = 0;
        let frame = current;
        while (frame && studio.elapsed >= frame.durationMs && guard < 8) {
          studio.elapsed -= frame.durationMs;
          studio.position = (studio.position + 1) % order.length;
          frame = playerState().current;
          guard += 1;
        }
      }
    }
    drawPlayer();
    studio.raf = requestAnimationFrame(tick);
  };
  studio.raf = requestAnimationFrame(tick);
}

function togglePlayback() {
  if (!state.result) return;
  studio.playing = !studio.playing;
  if (!["animation", "game"].includes(state.previewMode)) setPreviewMode("animation");
  syncPlayerControls();
  setStatus(studio.playing ? "Воспроизведение" : "Пауза · шаг кадра клавишами , и .", "done", 0);
}

function stepPlayer(delta) {
  if (!state.result) return;
  if (!["animation", "game"].includes(state.previewMode)) setPreviewMode("animation");
  studio.playing = false; studio.elapsed = 0;
  const { order } = playerState();
  if (order.length) studio.position = ((studio.position + delta) % order.length + order.length) % order.length;
  syncPlayerControls(); drawPlayer();
}

function toggleOnion() {
  studio.onion = !studio.onion;
  syncPlayerControls(); drawPlayer();
  if (!$("#aiMaskModal").classList.contains("hidden")) {
    $("#maskOnion").checked = !$("#maskOnion").checked; syncMaskOnion();
  }
  setStatus(studio.onion ? "Калька включена · соседние кадры видны полупрозрачно" : "Калька выключена", "done", 0);
}

function playerFitScale() {
  if (state.previewMode === "game") return studio.gameScale;
  const stage = $("#previewStage");
  const reserve = state.transformPanelOpen ? 316 : 0;
  return containScale(studio.cellWidth, studio.cellHeight, stage.clientWidth - 48 - reserve, stage.clientHeight - 48);
}

function frameBounds(index) {
  if (studio.bounds.has(index)) return studio.bounds.get(index);
  const image = studio.images[index];
  if (!image?.naturalWidth) return null;
  let bounds = null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
    let minX = width; let minY = height; let maxX = -1; let maxY = -1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (data[(y * width + x) * 4 + 3] > 16) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    bounds = maxX >= 0 ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null;
  } catch { bounds = null; }
  studio.bounds.set(index, bounds);
  return bounds;
}

function drawGameBackdrop(context, width, height, groundY, scale) {
  const sky = context.createLinearGradient(0, 0, 0, groundY);
  sky.addColorStop(0, "#172131"); sky.addColorStop(0.65, "#3b2d33"); sky.addColorStop(1, "#6b3b24");
  context.fillStyle = sky; context.fillRect(0, 0, width, groundY);
  context.fillStyle = "rgba(255,118,23,.55)";
  context.beginPath(); context.arc(width * 0.78, groundY * 0.55, Math.max(18, Math.min(width, height) * 0.07), 0, Math.PI * 2); context.fill();
  const hills = (color, amplitude, offset, period) => {
    context.fillStyle = color; context.beginPath(); context.moveTo(0, groundY);
    for (let x = 0; x <= width + 20; x += 20) context.lineTo(x, groundY - amplitude - Math.sin((x + offset) / period) * amplitude * 0.6);
    context.lineTo(width, groundY); context.closePath(); context.fill();
  };
  hills("#2a2630", Math.max(30, height * 0.12), 40, 120);
  hills("#1d2027", Math.max(18, height * 0.07), 190, 70);
  context.fillStyle = "#262b1f"; context.fillRect(0, groundY, width, height - groundY);
  const tile = Math.max(8, 32 * scale);
  for (let x = 0, index = 0; x < width; x += tile, index += 1) {
    context.fillStyle = index % 2 ? "#2d3324" : "#303826";
    context.fillRect(x, groundY + 4, tile, Math.max(6, tile * 0.5));
  }
  context.fillStyle = "#c8df6f"; context.fillRect(0, groundY - 1, width, 2);
}

function drawSprite(context, index, x, y, scale, alpha = 1) {
  const image = studio.images[index];
  if (!image?.naturalWidth) return;
  context.globalAlpha = alpha;
  context.drawImage(image, x, y, image.naturalWidth * scale, image.naturalHeight * scale);
  context.globalAlpha = 1;
}

function drawPlayer() {
  const canvas = $("#playerCanvas");
  if (!canvas || canvas.classList.contains("hidden") || !studio.images.length) return;
  const stage = $("#previewStage");
  const dpr = window.devicePixelRatio || 1;
  const width = stage.clientWidth; const height = stage.clientHeight;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
  }
  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  context.imageSmoothingEnabled = !$("#pixelPerfect").checked;
  const { sequence, order, position, current } = playerState();
  if (!current) return;
  const cellWidth = studio.cellWidth || studio.images[current.image]?.naturalWidth || 1;
  const cellHeight = studio.cellHeight || studio.images[current.image]?.naturalHeight || 1;
  const game = state.previewMode === "game";
  let scale; let left; let top;
  const reserve = state.transformPanelOpen ? 316 : 0;
  if (game) {
    scale = studio.gameScale;
    const groundY = Math.round(height * 0.8);
    drawGameBackdrop(context, width, height, groundY, scale);
    const pivotX = studio.pivot.x * cellWidth; const pivotY = studio.pivot.y * cellHeight;
    left = Math.round(width / 2 - pivotX * scale + state.viewportPanX);
    top = Math.round(groundY - pivotY * scale + state.viewportPanY);
  } else {
    scale = playerFitScale() * state.zoom;
    left = (width - reserve - cellWidth * scale) / 2 + state.viewportPanX;
    top = (height - cellHeight * scale) / 2 + state.viewportPanY;
  }
  if (studio.onion && order.length > 1) {
    const previous = sequence[order[(position - 1 + order.length) % order.length]];
    const next = sequence[order[(position + 1) % order.length]];
    if (next && next !== current) drawSprite(context, next.image, left, top, scale, studio.onionOpacity * 0.55);
    if (previous && previous !== current) drawSprite(context, previous.image, left, top, scale, studio.onionOpacity);
  }
  drawSprite(context, current.image, left, top, scale, 1);
  if (game && studio.hitbox) {
    const bounds = frameBounds(current.image);
    context.lineWidth = 1;
    if (bounds) {
      context.strokeStyle = "rgba(200,223,111,.95)"; context.setLineDash([5, 4]);
      context.strokeRect(Math.round(left + bounds.x * scale) + 0.5, Math.round(top + bounds.y * scale) + 0.5, Math.round(bounds.width * scale), Math.round(bounds.height * scale));
      context.setLineDash([]);
      context.fillStyle = "rgba(200,223,111,.95)"; context.font = '600 12px "Bahnschrift", sans-serif';
      context.fillText(`хитбокс ${bounds.width}×${bounds.height}`, Math.round(left + bounds.x * scale), Math.max(14, Math.round(top + bounds.y * scale) - 6));
    }
    const pivotX = left + studio.pivot.x * cellWidth * scale; const pivotY = top + studio.pivot.y * cellHeight * scale;
    context.strokeStyle = "#ff7617"; context.lineWidth = 2;
    context.beginPath(); context.moveTo(pivotX - 7, pivotY); context.lineTo(pivotX + 7, pivotY); context.moveTo(pivotX, pivotY - 7); context.lineTo(pivotX, pivotY + 7); context.stroke();
  }
  if (game) {
    context.fillStyle = "rgba(242,240,233,.82)"; context.font = '600 12px "Bahnschrift", sans-serif';
    context.fillText(`${String(studio.gameScale).replace(".", ",")}× · ${Math.round(cellWidth * studio.gameScale)}×${Math.round(cellHeight * studio.gameScale)} px на экране`, 14, height - 16);
  }
  const loopLabel = ({ loop: "повтор", pingpong: "туда-обратно", range: "диапазон" })[loopOptions().loopMode];
  const wide = width > 720 && !game;
  $("#playerCounter").textContent = `${order[position] + 1} / ${sequence.length} · ${current.durationMs} мс${wide ? ` · ${loopLabel}` : ""}`;
  $("#playerCounter").title = `Позиция ${position + 1} из ${order.length} в цикле · режим: ${loopLabel}`;
}

/* ------------------------------------------------------------ mask onion */

function syncMaskOnion() {
  $("#maskOnionOpacityRow").classList.toggle("hidden", !$("#maskOnion").checked);
  $("#maskOnionOpacityValue").textContent = `${$("#maskOnionOpacity").value}%`;
  redrawMaskCanvas();
}

function maskOnionUrls() {
  const index = activeMaskFrameIndex();
  const urls = state.result?.allSourceFrameUrls || state.source?.sampleUrls || [];
  return [urls[index - 1], urls[index + 1]].map((url) => url || null);
}

function drawMaskOnion(context, canvas) {
  if (!$("#maskOnion")?.checked) return;
  const opacity = Number($("#maskOnionOpacity").value) / 100;
  maskOnionUrls().forEach((url, order) => {
    if (!url) return;
    let image = studio.maskOnionImages.get(url);
    if (!image) {
      image = new Image();
      image.onload = () => { if (!$("#aiMaskModal").classList.contains("hidden")) redrawMaskCanvas(); };
      image.src = url;
      studio.maskOnionImages.set(url, image);
    }
    if (!image.complete || !image.naturalWidth) return;
    context.save();
    context.globalAlpha = order === 0 ? opacity : opacity * 0.6;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    context.restore();
  });
}

/* ----------------------------------------------------------- atlas status */

function renderAtlasStatus(result) {
  const atlas = result?.atlas;
  const cell = $("#metaAtlasCell");
  if (!atlas) { $("#metaAtlas").textContent = "—"; $("#atlasWarning").classList.add("hidden"); return; }
  const pages = atlas.pages?.length || 1;
  $("#metaAtlas").textContent = `${atlas.width}×${atlas.height}${pages > 1 ? ` · ${pages} л.` : ""}`;
  cell.classList.toggle("warn", atlas.exceeds && atlas.applied === "warn");
  cell.title = atlas.exceeds ? (atlas.applied === "warn" ? `Больше лимита ${atlas.limit} px — откройте «Экспорт»` : atlas.note || "") : "Размер спрайт-листа";
  const card = $("#atlasWarning");
  if (!atlas.exceeds) { card.classList.add("hidden"); return; }
  const unresolved = atlas.applied === "warn";
  card.classList.toggle("resolved", !unresolved);
  $("#atlasWarningTitle").textContent = unresolved ? "ЛИСТ БОЛЬШЕ ЛИМИТА" : "ЛИМИТ СОБЛЮДЁН";
  $("#atlasWarningText").textContent = unresolved
    ? `Лист ${atlas.naturalWidth} × ${atlas.naturalHeight} px больше лимита ${atlas.limit} px. Многие видеокарты и движки такой лист не загрузят. Выберите решение — предпросмотр пересоберётся без повторной обработки кадров.`
    : `${atlas.note || "Лист подогнан под лимит"} · было ${atlas.naturalWidth} × ${atlas.naturalHeight} px, лимит ${atlas.limit} px.`;
  $$("#atlasWarningActions button").forEach((button) => button.classList.toggle("selected", button.dataset.overflow === atlas.applied));
  card.classList.remove("hidden");
}

function updateExportFormatHint() {
  const format = $("#exportFormat").value;
  const hints = {
    chuba: "Chuba JSON: лист, кадры, durationMs, теги анимаций.",
    phaser3: "Phaser 3: NAME.phaser.json (multiatlas) + NAME.phaser-anims.json.",
    godot: "Godot 4: NAME.tres (SpriteFrames) — положите рядом с листом в res://.",
    texturepacker: "TexturePacker JSON-hash: NAME.texturepacker.json (на каждый лист).",
  };
  const metadataOff = !$("#exportMetadata").checked;
  $("#exportFormatHint").textContent = `${hints[format] || ""}${format !== "chuba" && metadataOff ? " Включите «Manifest + отчёт», чтобы файл движка был создан." : ""}${$("#atlasPacking").value === "tight" ? " Плотная упаковка обрезает пустые поля и хранит смещения в JSON." : ""}`;
}

/* ------------------------------------------------------- named animations */

const animationNameSuggestions = ["idle", "run", "jump", "attack", "hurt", "death", "walk", "shoot"];

function newAnimationId() {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function activeAnimation() {
  return state.animations.find((animation) => animation.id === state.activeAnimationId) || null;
}

function cleanAnimationName(value) {
  return String(value || "").trim().replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 32);
}

function snapshotActiveAnimation() {
  const animation = activeAnimation();
  if (animation && state.source && state.source.kind !== "video-batch") animation.document = buildAnimationDocument();
}

function renderAnimationBar() {
  const chips = $("#animationChips");
  if (!chips) return;
  chips.replaceChildren();
  const list = state.animations.length ? state.animations : [{ id: null, name: "основная", document: null, virtual: true }];
  list.forEach((animation) => {
    const active = animation.virtual || animation.id === state.activeAnimationId;
    const chip = document.createElement("div");
    chip.className = `animation-chip${active ? " active" : ""}`;
    const select = document.createElement("button");
    select.type = "button";
    const hasSource = active ? Boolean(state.source) : Boolean(animation.document?.source);
    select.innerHTML = "";
    const dot = document.createElement("i"); dot.className = hasSource ? "ready" : "empty";
    const label = document.createElement("span"); label.textContent = animation.name;
    select.append(dot, label);
    select.title = animation.virtual ? "Текущая анимация. Добавьте ещё, чтобы собрать их в один атлас" : active ? "Активная анимация · двойной щелчок — переименовать" : hasSource ? `Переключиться на «${animation.name}»` : `«${animation.name}»: источник ещё не добавлен`;
    select.setAttribute("aria-pressed", String(active));
    if (!animation.virtual) {
      select.addEventListener("click", () => activateAnimation(animation.id));
      select.addEventListener("dblclick", () => startAnimationName("rename", animation.id));
    }
    chip.append(select);
    if (!animation.virtual && state.animations.length > 1) {
      const remove = document.createElement("button");
      remove.type = "button"; remove.className = "remove"; remove.textContent = "×";
      remove.title = `Убрать «${animation.name}» из проекта`; remove.setAttribute("aria-label", remove.title);
      remove.addEventListener("click", () => removeAnimation(animation.id));
      chip.append(remove);
    }
    chips.append(chip);
  });
  const add = document.createElement("button");
  add.type = "button"; add.className = "animation-add"; add.textContent = "+ Анимация";
  add.title = "Добавить анимацию (idle, run, jump…) в этот проект";
  add.disabled = state.busy || state.source?.kind === "video-batch";
  add.addEventListener("click", () => startAnimationName("add"));
  chips.append(add);
  const count = state.animations.length;
  $("#animationBarHint").textContent = count > 1 ? `${count} · экспорт в один атлас с тегами` : "idle · run · jump — в один атлас";
  updateAnimationExportNote();
}

function startAnimationName(mode, id = null) {
  if (state.busy) return;
  const row = $("#animationNameRow");
  row.dataset.mode = mode; row.dataset.id = id || "";
  const input = $("#animationNameInput");
  if (mode === "rename") {
    input.value = state.animations.find((animation) => animation.id === id)?.name || "";
    $("#confirmAnimationName").textContent = "Переименовать";
  } else {
    const used = new Set(state.animations.map((animation) => animation.name));
    if (!state.animations.length) used.add("idle");
    input.value = animationNameSuggestions.find((name) => !used.has(name)) || `anim-${state.animations.length + 1}`;
    $("#confirmAnimationName").textContent = "Добавить";
  }
  row.classList.remove("hidden");
  input.focus(); input.select();
}

function closeAnimationName() {
  $("#animationNameRow").classList.add("hidden");
}

async function confirmAnimationName() {
  const row = $("#animationNameRow");
  const name = cleanAnimationName($("#animationNameInput").value);
  if (!name) { $("#animationNameInput").focus(); return; }
  if (state.animations.some((animation) => animation.name === name && animation.id !== row.dataset.id)) {
    setStatus(`Анимация «${name}» уже есть`, "error", 0); $("#animationNameInput").focus(); return;
  }
  if (row.dataset.mode === "rename") {
    const animation = state.animations.find((item) => item.id === row.dataset.id);
    if (animation) animation.name = name;
    closeAnimationName(); renderAnimationBar(); saveSessionSoon();
    setStatus(`Анимация переименована в «${name}»`, "done", 0);
    return;
  }
  closeAnimationName();
  if (!state.animations.length) {
    const first = { id: newAnimationId(), name: name === "idle" ? "anim-1" : "idle", document: null };
    state.animations.push(first);
    state.activeAnimationId = first.id;
  }
  snapshotActiveAnimation();
  const animation = { id: newAnimationId(), name, document: null };
  state.animations.push(animation);
  await activateAnimation(animation.id, { force: true });
}

async function activateAnimation(id, { force = false } = {}) {
  if (state.busy || (!force && id === state.activeAnimationId)) return;
  const target = state.animations.find((animation) => animation.id === id);
  if (!target) return;
  snapshotActiveAnimation();
  const projectPath = state.projectPath;
  const setName = $("#spriteName").value;
  state.activeAnimationId = id;
  state.animationSwitching = true;
  try {
    if (target.document?.source) {
      setStatus(`Открываю анимацию «${target.name}»…`, "busy", 0.1);
      const source = await window.spriteLab.restoreProject({ source: target.document.source });
      await applyProjectDocument(target.document, source, projectPath, { keepAnimations: true });
      setStatus(`Анимация «${target.name}»`, "done", 0);
    } else {
      setSource(null);
      state.projectPath = projectPath;
      setTab("source");
      setStatus(`Анимация «${target.name}»: добавьте видео или кадры`, "idle", 0);
    }
  } catch (error) {
    setStatus(error.message || "Не удалось открыть анимацию", "error", 0);
    showError(`${error.message || "Исходники анимации недоступны."}`);
  } finally {
    state.animationSwitching = false;
    if (setName && state.source?.kind !== "video-batch") $("#spriteName").value = setName;
    renderAnimationBar(); updateActionState(); saveSessionSoon();
  }
}

async function removeAnimation(id) {
  if (state.busy || state.animations.length <= 1) return;
  const index = state.animations.findIndex((animation) => animation.id === id);
  if (index < 0) return;
  const [removed] = state.animations.splice(index, 1);
  if (id === state.activeAnimationId) {
    state.activeAnimationId = null;
    await activateAnimation(state.animations[Math.max(0, index - 1)].id, { force: true });
  } else renderAnimationBar();
  saveSessionSoon();
  setStatus(`Анимация «${removed.name}» убрана из проекта`, "done", 0);
}

// Options for a stored animation document; mirrors collectOptions().
function optionsFromDocument(doc, base = {}) {
  const controls = doc.controls || {};
  const values = controls.values || {};
  const checks = controls.checks || {};
  const number = (id, fallback) => (values[id] === undefined || values[id] === "" ? fallback : Number(values[id]));
  return {
    ...base,
    fps: number("fps", 8), columns: number("columns", 8), cellWidth: number("cellWidth", 600), cellHeight: number("cellHeight", 400),
    padding: number("padding", 20), maxFrames: number("maxFrames", 192), tolerance: number("tolerance", 28),
    blackOutline: number("blackOutline", 3), blackFeather: number("blackFeather", 0),
    trimStart: doc.source?.kind === "video" ? number("trimStart", 0) : 0, trimEnd: doc.source?.kind === "video" ? number("trimEnd", 0) : 0,
    keyMode: controls.keyMode || "auto", anchor: controls.anchor || "ground",
    autoSize: checks.autoSize !== false, autoColumns: checks.autoColumns !== false,
    pixelPerfect: Boolean(checks.pixelPerfect), removeDuplicates: checks.removeDuplicates !== false,
    outputBackground: base.outputBackground || (checks.whiteOutput ? "white" : "transparent"),
    excludedFrames: doc.excludedFrames || [],
    aiCutoff: number("aiCutoff", 50), aiSoftness: number("aiSoftness", 0), aiEdits: doc.maskEdits || [], previewFrameIndex: 0,
    fringeCleanup: Boolean(checks.fringeCleanup), fringeStrength: number("fringeStrength", 55),
    attachments: (doc.attachments || []).filter((attachment) => attachment.enabled !== false), attachmentPlacements: null,
    frameOverrides: doc.frameOverrides || {}, frameTransforms: doc.frameTransforms || {},
    fitEachFrame: (doc.source?.kind === "sheet" && checks.sheetFitEach !== false) || (doc.source?.kind === "frames" && controls.studio?.imageAlign === "fit"),
    timeline: timelineOption(doc.timeline),
    ...loopOptions(controls.studio || { loopMode: "loop" }),
  };
}

function animationSetRequest(activeOptions) {
  if (state.animations.length <= 1) return [];
  snapshotActiveAnimation();
  const ready = [];
  const missing = [];
  for (const animation of state.animations) {
    if (animation.id === state.activeAnimationId) ready.push({ name: animation.name, active: true, options: activeOptions });
    else if (animation.document?.source) ready.push({ name: animation.name, source: animation.document.source, options: optionsFromDocument(animation.document, activeOptions) });
    else missing.push(animation.name);
  }
  if (missing.length) setStatus(`Без источника, пропущены: ${missing.join(", ")}`, "busy", 0.02);
  return ready;
}

function updateAnimationExportNote() {
  const note = $("#animationExportNote");
  if (!note) return;
  if (state.animations.length <= 1) { note.classList.add("hidden"); return; }
  const ready = state.animations.filter((animation) => animation.id === state.activeAnimationId ? state.source : animation.document?.source);
  const missing = state.animations.filter((animation) => !ready.includes(animation));
  note.textContent = `В один атлас войдут анимации: ${ready.map((animation) => animation.name).join(", ")}. В JSON каждая получит тег.${missing.length ? ` Без источника (пропустим): ${missing.map((animation) => animation.name).join(", ")}.` : ""}`;
  note.classList.remove("hidden");
  if (!state.busy && state.source && state.source.kind !== "video-batch") $("#exportButtonTitle").textContent = `ЭКСПОРТИРОВАТЬ ${ready.length} АНИМАЦ${ready.length >= 5 ? "ИЙ" : "ИИ"}`;
}

/* ------------------------------------------------------ window drag & drop */

let windowDragDepth = 0;

function dragHasFiles(event) {
  return [...(event.dataTransfer?.types || [])].includes("Files");
}

function setDropOverlay(visible) {
  $("#windowDropOverlay").classList.toggle("hidden", !visible);
  $("#dropZone").classList.toggle("dragging", visible);
}

document.addEventListener("dragenter", (event) => {
  if (!dragHasFiles(event) || studioModalOpen()) return;
  event.preventDefault();
  windowDragDepth += 1;
  setDropOverlay(true);
});
document.addEventListener("dragover", (event) => {
  if (!dragHasFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = studioModalOpen() || state.busy ? "none" : "copy";
});
document.addEventListener("dragleave", (event) => {
  if (!dragHasFiles(event)) return;
  windowDragDepth = Math.max(0, windowDragDepth - 1);
  if (!windowDragDepth) setDropOverlay(false);
});
document.addEventListener("drop", async (event) => {
  if (!dragHasFiles(event)) return;
  event.preventDefault();
  windowDragDepth = 0;
  setDropOverlay(false);
  if (studioModalOpen()) return; // the frame editor has its own drop target
  if (state.busy) { setStatus("Дождитесь окончания обработки", "error", 0); return; }
  try {
    setStatus("Проверяю перетащённые файлы…", "busy", 0.02);
    const source = await window.spriteLab.inspectDropped(event.dataTransfer.files);
    if (source) { setSource(source); setTab("source"); }
    else setStatus(state.source ? `Источник загружен · ${state.source.detail}` : "Готов к работе", state.source ? "done" : "idle", 0);
  } catch (error) { setStatus(error.message || "Формат не поддерживается", "error", 0); showError(error.message || "Формат не поддерживается."); }
});
window.addEventListener("blur", () => { windowDragDepth = 0; setDropOverlay(false); });

/* ------------------------------------------- sprite sheet from images */

function setImageAlign(mode, { silent = false } = {}) {
  const value = ["ground", "center", "fit"].includes(mode) ? mode : "ground";
  state.imageAlign = value;
  $$("#imageAlignMode button").forEach((button) => {
    const selected = button.dataset.imageAlign === value;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  if (silent) return;
  // Bottom/center alignment maps onto the stabilization anchor; "fit" scales each image into the cell.
  setAnchor(value === "ground" ? "ground" : "center");
  markPreviewDirty(); scheduleFramePreview(0); pushHistory("Выравнивание картинок"); saveSessionSoon();
}

function renderImageSheetControls() {
  const card = $("#imageSheetControls");
  const source = state.source;
  const show = source?.kind === "frames" && Array.isArray(source.images) && source.images.length > 0;
  card.classList.toggle("hidden", !show);
  if (!show) return;
  const images = source.images;
  $("#imageSheetCount").textContent = `${images.length} файлов`;
  const opaque = images.filter((image) => !image.hasAlpha).length;
  $("#imageSheetSummary").textContent = `${source.detail}.${source.mixedSizes ? " Ячейка подбирается по самой большой картинке." : ""}${opaque ? ` Без прозрачности: ${opaque} (JPG или непрозрачный PNG/WEBP).` : " У всех картинок есть прозрачность."}`;
  const list = $("#imageSheetList"); list.replaceChildren();
  images.slice(0, 60).forEach((image) => {
    const item = document.createElement("li");
    const name = document.createElement("span"); name.textContent = image.name;
    const meta = document.createElement("small"); meta.textContent = `${image.format === "jpeg" ? "JPG" : image.format.toUpperCase()} · ${image.width}×${image.height}${image.hasAlpha ? " · α" : ""}`;
    item.append(name, meta); list.append(item);
  });
  if (images.length > 60) { const more = document.createElement("li"); more.textContent = `…и ещё ${images.length - 60}`; list.append(more); }
  $("#imageRemoveBackground").checked = state.keyMode !== "alpha";
  $("#imageBackgroundHint").textContent = opaque
    ? "у JPG нет прозрачности — без удаления фон останется в кадре"
    : "картинки уже прозрачные — удалять фон не нужно";
  setImageAlign(state.anchor === "center" ? (state.imageAlign === "fit" ? "fit" : "center") : "ground", { silent: true });
}

/* ---------------------------------------------------------------- hotkeys */

document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented) return;
  const maskOpen = !$("#aiMaskModal").classList.contains("hidden");
  if (maskOpen && !isEditingTarget(event.target) && (event.code === "BracketLeft" || event.code === "BracketRight")) {
    event.preventDefault();
    const smart = state.maskBrushMode === "smart";
    const input = smart ? $("#smartRegionTolerance") : $("#maskBrushSize");
    const step = smart ? 4 : 4;
    input.value = String(Math.max(Number(input.min), Math.min(Number(input.max), Number(input.value) + (event.code === "BracketRight" ? step : -step))));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  if (maskOpen && !isEditingTarget(event.target) && event.code === "KeyO" && !event.ctrlKey) {
    event.preventDefault(); $("#maskOnion").checked = !$("#maskOnion").checked; syncMaskOnion(); return;
  }
  if (event.key === "F1") { event.preventDefault(); if (!studioModalOpen()) openAbout(); return; }
  if (studioModalOpen() || isEditingTarget(event.target) || event.target.closest?.(".tabs")) return;
  if (event.ctrlKey && !event.shiftKey && event.code === "KeyD") { event.preventDefault(); duplicateSelectedEntry(); return; }
  if (event.ctrlKey || event.metaKey) return;
  const hasResult = Boolean(state.result?.allSourceFrameUrls?.length) && state.source?.kind !== "video-batch";
  if (hasResult && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 1 : -1;
    if (event.altKey) moveSelectedEntry(delta); else stepSelection(delta);
    return;
  }
  if (hasResult && event.key === "Delete") { event.preventDefault(); removeOrExcludeSelected(); return; }
  if (event.altKey) return;
  if (state.result && event.code === "Comma") { event.preventDefault(); stepPlayer(-1); return; }
  if (state.result && event.code === "Period") { event.preventDefault(); stepPlayer(1); return; }
  if (state.result && event.code === "KeyP") { event.preventDefault(); togglePlayback(); return; }
  if (event.code === "KeyO") { event.preventDefault(); toggleOnion(); return; }
  if (state.result && event.code === "KeyG") { event.preventDefault(); setPreviewMode(state.previewMode === "game" ? "animation" : "game"); }
});

/* --------------------------------------------------------------- bindings */

$("#loopMode").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-loop]");
  if (button) setLoopMode(button.dataset.loop);
});
for (const id of ["loopFrom", "loopTo"]) $(`#${id}`).addEventListener("change", () => loopChanged("Диапазон цикла изменён"));

$("#playerPlay").addEventListener("click", togglePlayback);
$("#playerPrev").addEventListener("click", () => stepPlayer(-1));
$("#playerNext").addEventListener("click", () => stepPlayer(1));
$("#onionToggle").addEventListener("click", () => { studio.onion = !studio.onion; syncPlayerControls(); drawPlayer(); });
$("#onionOpacity").addEventListener("input", (event) => { studio.onionOpacity = Number(event.target.value) / 100; drawPlayer(); saveStudioPreferences(); });
$("#gameScaleGroup").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-game-scale]");
  if (!button) return;
  studio.gameScale = Number(button.dataset.gameScale) || 1;
  state.viewportPanX = 0; state.viewportPanY = 0;
  syncPlayerControls(); applyZoom(); saveStudioPreferences();
});
$("#hitboxToggle").addEventListener("click", () => { studio.hitbox = !studio.hitbox; syncPlayerControls(); drawPlayer(); saveStudioPreferences(); });

$("#duplicateFrame").addEventListener("click", duplicateSelectedEntry);
$("#frameDuration").addEventListener("change", (event) => setSelectedDuration(event.target.value));
$("#frameDuration").addEventListener("keydown", (event) => { if (event.key === "Enter") event.target.blur(); });
$("#fps").addEventListener("input", () => { syncFrameDurationControl(selectedEntry()); refreshPlayer(); });

$("#maskOnion").addEventListener("change", syncMaskOnion);
$("#maskOnionOpacity").addEventListener("input", syncMaskOnion);

for (const id of ["atlasPacking", "exportFormat", "atlasMaxSize", "atlasOverflow"]) {
  $(`#${id}`).addEventListener("change", () => {
    state.lastExportDir = null; updateExportFormatHint(); saveStudioPreferences(); updateActionState();
    if (id !== "exportFormat") markPreviewDirty();
    scheduleHistory("Настройки атласа изменены");
  });
}
$("#exportMetadata").addEventListener("change", updateExportFormatHint);
$("#exportPreset").addEventListener("change", updateExportFormatHint);
$("#atlasWarningActions").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-overflow]");
  if (!button || state.busy || !state.source) return;
  $("#atlasOverflow").value = button.dataset.overflow;
  saveStudioPreferences(); updateExportFormatHint();
  runBuild(true);
});
$("#metaAtlasCell").addEventListener("click", () => { if (state.result?.atlas?.exceeds) setTab("export"); });

$("#confirmAnimationName").addEventListener("click", confirmAnimationName);
$("#cancelAnimationName").addEventListener("click", closeAnimationName);
$("#animationNameInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); confirmAnimationName(); }
  if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeAnimationName(); }
});
$("#newProject").addEventListener("click", () => { state.animations = []; state.activeAnimationId = null; renderAnimationBar(); });

$("#chooseImages").addEventListener("click", () => chooseSource("chooseFrames"));
$("#imageAlignMode").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-image-align]");
  if (button) setImageAlign(button.dataset.imageAlign);
});
$("#imageRemoveBackground").addEventListener("change", (event) => {
  const recommended = state.source?.recommendations?.keyMode;
  setKeyMode(event.target.checked ? (recommended && recommended !== "alpha" ? recommended : "auto") : "alpha");
  scheduleFramePreview(0); pushHistory(event.target.checked ? "Удаление фона включено" : "Фон картинок сохранён");
  setStatus(event.target.checked ? `Фон будет удалён · режим: ${modeLabel(state.keyMode)}` : "Фон картинок сохраняется как есть", "done", 0);
});
$("#buildImageSheet").addEventListener("click", () => { setTab("process"); if (!$("#buildPreview").disabled) runBuild(true); });
$("#keyMode").addEventListener("click", () => { if (state.source?.kind === "frames") $("#imageRemoveBackground").checked = state.keyMode !== "alpha"; });

loadStudioPreferences();
setLoopMode("loop", { silent: true });
updateExportFormatHint();
renderAnimationBar();
syncPlayerControls();
