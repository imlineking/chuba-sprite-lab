// Built-in pixel editor.
//
// The document lives in the main process (see editor-session.mjs), so this file only ever holds the
// composite it paints and the layer list it shows. Drawing therefore sends the operation and redraws
// from the answer — one code path for opening, painting, filling, undo and layer changes.
//
// It is a classic script like the rest of the window: it shares the page scope, so `state`, `$` and
// the status helpers come from renderer.js.

const pixelEditor = {
  sessionId: null,
  frameIndex: 0,
  name: "frame",
  width: 0,
  height: 0,
  tool: "pencil",
  color: [17, 17, 17, 255],
  brush: 1,
  tolerance: 24,
  zoom: 8,
  gridOn: true,
  layers: [],
  activeLayerId: null,
  composite: null,
  imageData: null,
  cursor: { x: -1, y: -1, inside: false },
  drawing: false,
  lastPoint: null,
  palette: [],
};

let pixelEditorQueue = Promise.resolve();

/* ------------------------------------------------------------------ helpers */

function pixelEditorIsOpen() {
  return !$("#pixelEditorModal").classList.contains("hidden");
}

function pixelEditorHex(color) {
  const channel = (value) => Math.max(0, Math.min(255, Math.round(Number(value) || 0))).toString(16).padStart(2, "0");
  return `#${channel(color[0])}${channel(color[1])}${channel(color[2])}`;
}

function pixelEditorColorFromHex(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!match) return [0, 0, 0, 255];
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255, 255];
}

function pixelEditorStatus(message, kind = "ready") {
  const status = $("#pixelEditorStatus");
  status.className = `pixel-editor-status ${kind}`;
  status.textContent = message;
}

function pixelEditorPointFromEvent(event) {
  const canvas = $("#pixelCanvas");
  const bounds = canvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return { x: -1, y: -1, inside: false };
  const x = Math.floor(((event.clientX - bounds.left) / bounds.width) * pixelEditor.width);
  const y = Math.floor(((event.clientY - bounds.top) / bounds.height) * pixelEditor.height);
  const inside = x >= 0 && y >= 0 && x < pixelEditor.width && y < pixelEditor.height;
  return { x, y, inside };
}

/* ------------------------------------------------------------------ drawing */

function pixelEditorRenderCanvas() {
  const canvas = $("#pixelCanvas");
  if (!pixelEditor.width || !pixelEditor.height) return;
  if (canvas.width !== pixelEditor.width || canvas.height !== pixelEditor.height) {
    canvas.width = pixelEditor.width;
    canvas.height = pixelEditor.height;
    pixelEditor.imageData = null;
  }
  const context = canvas.getContext("2d");
  if (!pixelEditor.imageData || pixelEditor.imageData.width !== pixelEditor.width) {
    pixelEditor.imageData = context.createImageData(pixelEditor.width, pixelEditor.height);
  }
  if (pixelEditor.composite) {
    pixelEditor.imageData.data.set(pixelEditor.composite.subarray(0, pixelEditor.imageData.data.length));
    context.putImageData(pixelEditor.imageData, 0, 0);
  }
  const wrap = $("#pixelCanvasWrap");
  wrap.style.setProperty("--pixel-cell", `${pixelEditor.zoom}px`);
  wrap.classList.toggle("grid", pixelEditor.gridOn && pixelEditor.zoom >= 4);
  // A grid cell is one pixel: below 4× it would be a solid mesh instead of a guide.
  $("#pixelGrid").disabled = pixelEditor.zoom < 4;
  canvas.style.width = `${pixelEditor.width * pixelEditor.zoom}px`;
  canvas.style.height = `${pixelEditor.height * pixelEditor.zoom}px`;
  $("#pixelZoomValue").textContent = `${pixelEditor.zoom}×`;
}

function pixelEditorRenderLayers() {
  const list = $("#pixelLayers");
  list.replaceChildren();
  // Top layer first: the list is read the way the picture is stacked.
  [...pixelEditor.layers].reverse().forEach((layer) => {
    const row = document.createElement("li");
    row.className = `pixel-layer${layer.id === pixelEditor.activeLayerId ? " active" : ""}`;
    row.dataset.layerId = layer.id;

    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "pixel-layer-name";
    pick.textContent = layer.name;
    pick.title = "Сделать слоем для рисования";
    pick.addEventListener("click", () => pixelEditorSend({ op: "updateLayer", layerId: layer.id, active: true }));

    const visible = document.createElement("button");
    visible.type = "button";
    visible.className = `pixel-layer-flag${layer.visible ? " on" : ""}`;
    visible.textContent = layer.visible ? "◉" : "○";
    visible.title = layer.visible ? "Скрыть слой" : "Показать слой";
    visible.addEventListener("click", () => pixelEditorSend({ op: "updateLayer", layerId: layer.id, visible: !layer.visible }));

    const locked = document.createElement("button");
    locked.type = "button";
    locked.className = `pixel-layer-flag${layer.locked ? " on" : ""}`;
    locked.textContent = layer.locked ? "🔒" : "🔓";
    locked.title = layer.locked ? "Разрешить рисование" : "Запретить рисование";
    locked.addEventListener("click", () => pixelEditorSend({ op: "updateLayer", layerId: layer.id, locked: !layer.locked }));

    row.append(pick, visible, locked);
    list.append(row);
  });
  $("#pixelLayerCount").textContent = String(pixelEditor.layers.length);
  $("#pixelRemoveLayer").disabled = pixelEditor.layers.length <= 1;
}

function pixelEditorRenderPalette() {
  const list = $("#pixelPalette");
  list.replaceChildren();
  if (!pixelEditor.palette.length) {
    const empty = document.createElement("small");
    empty.textContent = "Цвета появятся после открытия кадра.";
    list.append(empty);
    return;
  }
  pixelEditor.palette.forEach((color) => {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "pixel-swatch";
    swatch.style.background = pixelEditorHex(color);
    swatch.title = `${pixelEditorHex(color)} · взять как основной`;
    swatch.addEventListener("click", () => pixelEditorSetColor(color));
    list.append(swatch);
  });
}

function pixelEditorSetColor(color) {
  pixelEditor.color = [color[0], color[1], color[2], 255];
  $("#pixelInkColor").value = pixelEditorHex(pixelEditor.color);
  pixelEditorUpdateCursorInfo();
}

function pixelEditorUpdateCursorInfo() {
  const info = $("#pixelCursorInfo");
  const { x, y, inside } = pixelEditor.cursor;
  if (!inside) {
    info.textContent = `${pixelEditor.width} × ${pixelEditor.height} · ${pixelEditorHex(pixelEditor.color)}`;
    return;
  }
  let sampled = null;
  if (pixelEditor.composite) {
    const offset = (y * pixelEditor.width + x) * 4;
    sampled = [pixelEditor.composite[offset], pixelEditor.composite[offset + 1], pixelEditor.composite[offset + 2], pixelEditor.composite[offset + 3]];
  }
  const readable = sampled ? pixelEditorHex(sampled) : "—";
  const alpha = sampled ? ` · A ${sampled[3]}` : "";
  info.textContent = `${x}, ${y} · ${readable}${alpha} · рисую ${pixelEditorHex(pixelEditor.color)}`;
}

/* ------------------------------------------------------------------ commands */

// Every operation is queued: a fast drag produces many small strokes, and each answer repaints the
// canvas, so they have to be applied in the order they were drawn.
function pixelEditorSend(request) {
  if (!pixelEditor.sessionId) return pixelEditorQueue;
  const sessionId = pixelEditor.sessionId;
  pixelEditorQueue = pixelEditorQueue
    .then(async () => {
      if (pixelEditor.sessionId !== sessionId) return null;
      const answer = await window.spriteLab.pixelEditorOp({ ...request, sessionId });
      if (answer && answer.sessionId && pixelEditor.sessionId === sessionId) pixelEditorApplyState(answer);
      return answer;
    })
    .catch((error) => {
      pixelEditorStatus(error?.message || "Не удалось выполнить команду редактора", "error");
      return null;
    });
  return pixelEditorQueue;
}

async function pixelEditorFlush() {
  await pixelEditorQueue.catch(() => {});
}

function pixelEditorApplyState(answer) {
  pixelEditor.sessionId = answer.sessionId;
  pixelEditor.frameIndex = answer.frameIndex;
  pixelEditor.name = answer.name;
  pixelEditor.width = answer.width;
  pixelEditor.height = answer.height;
  pixelEditor.layers = answer.layers;
  pixelEditor.activeLayerId = answer.activeLayerId;
  if (answer.composite) pixelEditor.composite = answer.composite instanceof Uint8ClampedArray
    ? answer.composite
    : new Uint8ClampedArray(answer.composite);
  $("#pixelUndo").disabled = !answer.canUndo;
  $("#pixelRedo").disabled = !answer.canRedo;
  $("#pixelEditorBadge").textContent = `КАДР ${answer.frameIndex + 1}`;
  $("#pixelEditorSize").textContent = `${answer.width} × ${answer.height}`;
  pixelEditorRenderCanvas();
  pixelEditorRenderLayers();
  pixelEditorUpdateCursorInfo();
  if (answer.blocked) pixelEditorStatus(answer.blocked, "warn");
  else if (answer.label) pixelEditorStatus(answer.label, "done");
}

function pixelEditorPaletteFromComposite(composite, limit = 20) {
  const counts = new Map();
  for (let offset = 0; offset + 3 < composite.length; offset += 4) {
    if (composite[offset + 3] < 8) continue;
    const key = (composite[offset] << 16) | (composite[offset + 1] << 8) | composite[offset + 2];
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([key]) => [(key >> 16) & 255, (key >> 8) & 255, key & 255, 255]);
}

function pixelEditorFitZoom() {
  const wrap = $("#pixelCanvasWrap");
  const availableWidth = Math.max(160, wrap.clientWidth - 24);
  const availableHeight = Math.max(160, wrap.clientHeight - 24);
  const fit = Math.min(availableWidth / Math.max(1, pixelEditor.width), availableHeight / Math.max(1, pixelEditor.height));
  return Math.max(1, Math.min(24, Math.floor(fit)));
}

function pixelEditorSetTool(tool) {
  pixelEditor.tool = tool;
  const tools = { pencil: "#pixelToolPencil", eraser: "#pixelToolEraser", fill: "#pixelToolFill", picker: "#pixelToolPicker" };
  for (const [name, selector] of Object.entries(tools)) $(selector).classList.toggle("active", name === tool);
  const hints = {
    pencil: "Карандаш: рисует основным цветом. Удерживайте кнопку мыши, чтобы вести линию.",
    eraser: "Ластик: стирает пиксели выбранного слоя до прозрачности.",
    fill: "Заливка: заливает связанную область под курсором. «Разброс» задаёт, какие цвета считать одинаковыми, а «Стереть кайму» убирает почти прозрачный ореол вокруг спрайта.",
    picker: "Пипетка: берёт цвет из кадра как основной. Не меняет пиксели.",
  };
  $("#pixelEditorHint").textContent = hints[tool];
}

async function pixelEditorOpen() {
  if (!state.result?.allSourceFramePaths?.length || state.busy || state.source?.kind === "video-batch") return;
  const frameIndex = state.selectedFrameIndex;
  const sourcePath = state.frameOverrides[frameIndex] || state.result.allSourceFramePaths[frameIndex];
  pixelEditorStatus("Открываю кадр…", "busy");
  const answer = await window.spriteLab.openPixelEditor({ path: sourcePath, frameIndex, name: "frame" });
  pixelEditor.palette = pixelEditorPaletteFromComposite(answer.composite);
  pixelEditorApplyState(answer);
  pixelEditor.zoom = pixelEditorFitZoom();
  pixelEditorRenderCanvas();
  pixelEditorRenderPalette();
  pixelEditorSetTool("pencil");
  pixelEditorSetColor(pixelEditor.color);
  pixelEditorStatus("Кадр открыт. Рисуйте и сохраните — он встанет в спрайт-лист.", "ready");
  setModalOpen($("#pixelEditorModal"), true, $("#pixelToolPencil"), $("#openPixelEditor"));
}

async function pixelEditorClose() {
  if (!pixelEditorIsOpen()) return;
  const sessionId = pixelEditor.sessionId;
  pixelEditor.sessionId = null;
  setModalOpen($("#pixelEditorModal"), false, null, $("#openPixelEditor"));
  pixelEditor.drawing = false;
  pixelEditor.lastPoint = null;
  if (sessionId) await window.spriteLab.pixelEditorOp({ op: "close", sessionId }).catch(() => {});
}

async function pixelEditorSave() {
  if (!pixelEditor.sessionId) return;
  const frameIndex = pixelEditor.frameIndex;
  pixelEditorStatus("Сохраняю кадр…", "busy");
  await pixelEditorFlush();
  const saved = await window.spriteLab.savePixelEditor({ sessionId: pixelEditor.sessionId, frameIndex, name: pixelEditor.name });
  state.frameOverrides[frameIndex] = saved.path;
  markPreviewDirty();
  pixelEditorStatus("Кадр сохранён · он попадёт в следующий спрайт-лист", "done");
  setStatus(t("Кадр {number} изменён в пиксельном редакторе · пересоберите анимацию", { number: frameIndex + 1 }), "done", 0);
  pushHistory(t("Кадр {number} изменён в пиксельном редакторе", { number: frameIndex + 1 }));
  if (state.result) buildFilmstrip(state.result);
  try {
    await requestFramePreview(saved.path);
  } catch (error) {
    setStatus(error?.message || "Кадр сохранён, но предпросмотр не обновился", "error", 0);
  }
}

/* ------------------------------------------------------------------ pointer */

function pixelEditorSampleCursor(point) {
  pixelEditor.cursor = point;
  pixelEditorUpdateCursorInfo();
}

function pixelEditorPaintTo(point) {
  const erase = pixelEditor.tool === "eraser";
  const from = pixelEditor.lastPoint || point;
  pixelEditor.lastPoint = point;
  pixelEditorSend({ op: "paint", from: [from.x, from.y], to: [point.x, point.y], color: pixelEditor.color, size: pixelEditor.brush, erase });
}

function pixelEditorPointerDown(event) {
  if (event.button !== 0 || !pixelEditor.sessionId) return;
  const point = pixelEditorPointFromEvent(event);
  if (!point.inside) return;
  if (pixelEditor.tool === "picker") {
    window.spriteLab.pixelEditorOp({ op: "pick", sessionId: pixelEditor.sessionId, x: point.x, y: point.y })
      .then((answer) => {
        if (answer?.color && answer.color[3] > 0) {
          pixelEditorSetColor(answer.color);
          pixelEditorStatus(`Взят цвет ${pixelEditorHex(answer.color)}`, "done");
        } else {
          pixelEditorStatus("В этой точке прозрачно.", "warn");
        }
      })
      .catch((error) => pixelEditorStatus(error?.message || "Не удалось взять цвет", "error"));
    return;
  }
  event.currentTarget.setPointerCapture?.(event.pointerId);
  pixelEditor.drawing = true;
  pixelEditor.lastPoint = point;
  if (pixelEditor.tool === "fill") {
    pixelEditorSend({ op: "fill", x: point.x, y: point.y, color: pixelEditor.color, tolerance: pixelEditor.tolerance });
    pixelEditor.drawing = false;
    return;
  }
  pixelEditorPaintTo(point);
}

function pixelEditorPointerMove(event) {
  const point = pixelEditorPointFromEvent(event);
  pixelEditorSampleCursor(point);
  if (!pixelEditor.drawing || !point.inside) return;
  pixelEditorPaintTo(point);
}

function pixelEditorPointerUp(event) {
  if (!pixelEditor.drawing) return;
  pixelEditor.drawing = false;
  pixelEditor.lastPoint = null;
  event.currentTarget.releasePointerCapture?.(event.pointerId);
}

function pixelEditorWheel(event) {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  pixelEditorSetZoom(pixelEditor.zoom + (event.deltaY < 0 ? 1 : -1));
}

function pixelEditorSetZoom(value) {
  pixelEditor.zoom = Math.max(1, Math.min(24, value));
  pixelEditorRenderCanvas();
}

/* ------------------------------------------------------------------ wiring */

function pixelEditorSyncBrush() {
  pixelEditor.brush = Math.max(1, Math.min(16, Number($("#pixelBrushSize").value) || 1));
  $("#pixelBrushValue").textContent = `${pixelEditor.brush} px`;
}

function pixelEditorSyncTolerance() {
  pixelEditor.tolerance = Math.max(0, Math.min(255, Number($("#pixelTolerance").value) || 0));
  $("#pixelToleranceValue").textContent = String(pixelEditor.tolerance);
}

$("#openPixelEditor").addEventListener("click", async () => {
  try {
    await pixelEditorOpen();
  } catch (error) {
    setStatus(error?.message || "Не удалось открыть пиксельный редактор", "error", 0);
    showError(error?.message || "Не удалось открыть пиксельный редактор");
  }
});

$("#closePixelEditor").addEventListener("click", () => { void pixelEditorClose(); });
$("#pixelEditorModal").addEventListener("click", (event) => { if (event.target === $("#pixelEditorModal")) void pixelEditorClose(); });
$("#pixelToolPencil").addEventListener("click", () => pixelEditorSetTool("pencil"));
$("#pixelToolEraser").addEventListener("click", () => pixelEditorSetTool("eraser"));
$("#pixelToolFill").addEventListener("click", () => pixelEditorSetTool("fill"));
$("#pixelToolPicker").addEventListener("click", () => pixelEditorSetTool("picker"));
$("#pixelBrushSize").addEventListener("input", pixelEditorSyncBrush);
$("#pixelTolerance").addEventListener("input", pixelEditorSyncTolerance);
$("#pixelEraseTransparent").addEventListener("click", () => {
  pixelEditorSend({ op: "eraseTransparent", threshold: pixelEditor.tolerance });
});
$("#pixelInkColor").addEventListener("input", () => pixelEditorSetColor(pixelEditorColorFromHex($("#pixelInkColor").value)));
$("#pixelGrid").addEventListener("change", () => { pixelEditor.gridOn = $("#pixelGrid").checked; pixelEditorRenderCanvas(); });
$("#pixelZoomIn").addEventListener("click", () => pixelEditorSetZoom(pixelEditor.zoom + 1));
$("#pixelZoomOut").addEventListener("click", () => pixelEditorSetZoom(pixelEditor.zoom - 1));
$("#pixelZoomFit").addEventListener("click", () => pixelEditorSetZoom(pixelEditorFitZoom()));
$("#pixelUndo").addEventListener("click", () => pixelEditorSend({ op: "undo" }));
$("#pixelRedo").addEventListener("click", () => pixelEditorSend({ op: "redo" }));
$("#pixelAddLayer").addEventListener("click", () => pixelEditorSend({ op: "addLayer" }));
$("#pixelRemoveLayer").addEventListener("click", () => pixelEditorSend({ op: "removeLayer", layerId: pixelEditor.activeLayerId }));
$("#pixelSaveFrame").addEventListener("click", async () => {
  try {
    await pixelEditorSave();
  } catch (error) {
    pixelEditorStatus(error?.message || "Не удалось сохранить кадр", "error");
  }
});

const pixelEditorCanvas = $("#pixelCanvas");
pixelEditorCanvas.addEventListener("pointerdown", pixelEditorPointerDown);
pixelEditorCanvas.addEventListener("pointermove", pixelEditorPointerMove);
pixelEditorCanvas.addEventListener("pointerup", pixelEditorPointerUp);
pixelEditorCanvas.addEventListener("pointercancel", pixelEditorPointerUp);
pixelEditorCanvas.addEventListener("pointerleave", () => pixelEditorSampleCursor({ x: -1, y: -1, inside: false }));
pixelEditorCanvas.addEventListener("contextmenu", (event) => event.preventDefault());
$("#pixelCanvasWrap").addEventListener("wheel", pixelEditorWheel, { passive: false });

document.addEventListener("keydown", (event) => {
  if (!pixelEditorIsOpen()) return;
  const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement;
  const key = event.code?.startsWith("Key") ? event.code.slice(3).toLowerCase() : event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === "s") { event.preventDefault(); void pixelEditorSave().catch((error) => pixelEditorStatus(error?.message || "Не удалось сохранить кадр", "error")); return; }
  if ((event.ctrlKey || event.metaKey) && key === "z") { event.preventDefault(); pixelEditorSend({ op: event.shiftKey ? "redo" : "undo" }); return; }
  if ((event.ctrlKey || event.metaKey) && key === "y") { event.preventDefault(); pixelEditorSend({ op: "redo" }); return; }
  if (typing || event.ctrlKey || event.metaKey) return;
  if (key === "escape") { event.preventDefault(); void pixelEditorClose(); return; }
  if (key === "p" || key === "b") pixelEditorSetTool("pencil");
  else if (key === "e") pixelEditorSetTool("eraser");
  else if (key === "g" || key === "f") pixelEditorSetTool("fill");
  else if (key === "i") pixelEditorSetTool("picker");
  else if (key === "[" || key === "]") {
    $("#pixelBrushSize").value = String(Math.max(1, Math.min(16, pixelEditor.brush + (key === "]" ? 1 : -1))));
    pixelEditorSyncBrush();
  } else if (key === "+" || key === "=") pixelEditorSetZoom(pixelEditor.zoom + 1);
  else if (key === "-" || key === "_") pixelEditorSetZoom(pixelEditor.zoom - 1);
});

pixelEditorSyncBrush();
pixelEditorSyncTolerance();
pixelEditorSetTool("pencil");
pixelEditorStatus("Откройте кадр из полосы кадров.", "ready");
