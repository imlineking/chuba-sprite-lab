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
  selection: null, selectionStart: null, selectionPoints: [],
  tool: "pencil",
  color: [17, 17, 17, 255],
  brush: 1,
  brushShape: "square",
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
  preview: null,
  savedPixels: null,
  savedLayers: "",
  fitActive: false,
};

let pixelEditorQueue = Promise.resolve();
let pixelEditorCloseDecision = null;
let pixelEditorApplying = false;

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
  window.spriteLabPaletteUI?.repeat();
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
    pixelEditor.imageData.data.set((pixelEditor.preview || pixelEditor.composite).subarray(0, pixelEditor.imageData.data.length));
    context.putImageData(pixelEditor.imageData, 0, 0);
  if (pixelEditor.onion?.length && !pixelEditor.preview) {
    const ghost = document.createElement('canvas'); ghost.width=pixelEditor.width;ghost.height=pixelEditor.height;const g=ghost.getContext('2d');
    for (const neighbor of pixelEditor.onion) {const data=g.createImageData(pixelEditor.width,pixelEditor.height);for(let i=0;i<neighbor.composite.length;i+=4){data.data[i]=neighbor.index<pixelEditor.frameIndex?80:220;data.data[i+1]=neighbor.index<pixelEditor.frameIndex?190:80;data.data[i+2]=220;data.data[i+3]=Math.round(neighbor.composite[i+3]*.25);}g.putImageData(data,0,0);context.drawImage(ghost,0,0);}
  }
  if (pixelEditor.selection) { context.fillStyle = "rgba(255,0,255,.35)"; for (let i = 0; i < pixelEditor.selection.length; i++) if (pixelEditor.selection[i]) context.fillRect(i % pixelEditor.width, Math.floor(i / pixelEditor.width), 1, 1); }
  if (pixelEditor.cursor.inside && ['pencil','eraser'].includes(pixelEditor.tool) && !pixelEditor.preview) {
    for (const [x,y,coverage] of window.SpriteLabBrush.footprint(pixelEditor.cursor.x,pixelEditor.cursor.y,pixelEditor.brush,pixelEditor.brushShape,Number($('#pixelBrushHardness').value))) {
      context.fillStyle = `rgba(80,190,255,${.25*coverage})`; context.fillRect(x,y,1,1);
    }
  }
  }
  const wrap = $("#pixelCanvasWrap");
  wrap.style.setProperty("--pixel-cell", `${pixelEditor.zoom}px`);
  wrap.classList.toggle("grid", pixelEditor.gridOn && pixelEditor.zoom >= 4);
  // A grid cell is one pixel: below 4× it would be a solid mesh instead of a guide.
  $("#pixelGrid").disabled = pixelEditor.zoom < 4;
  canvas.style.width = `${pixelEditor.width * pixelEditor.zoom}px`;
  canvas.style.height = `${pixelEditor.height * pixelEditor.zoom}px`;
  $("#pixelZoomValue").textContent = `${Math.round(pixelEditor.zoom * 100)}%`;
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
    pick.title = layer.kind === 'text' ? 'Выбрать и изменить текст' : 'Сделать слоем для рисования';
    pick.addEventListener("click", async () => { await pixelEditorSend({ op: "updateLayer", layerId: layer.id, active: true }); if (layer.kind === 'text') window.spriteLabTextUI?.edit(layer.id); });

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

function pixelEditorRenderPalette() { window.spriteLabPixelUI.renderPalette(); }

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
      if (answer && answer.sessionId && pixelEditor.sessionId === sessionId) {
        pixelEditorCancelPreview();
        pixelEditorApplyState(answer);
        if (["paletteDocument", "text", "removeLayer", "updateLayer", "frameColor", "frameAdjust", "undo", "redo"].includes(request.op)) {
          pixelEditor.palette = pixelEditorPaletteFromComposite(pixelEditor.composite);
          pixelEditorRenderPalette();
        }
      }
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
  pixelEditor.selection = answer.selection;
  pixelEditor.sessionId = answer.sessionId;
  pixelEditor.frameIndex = answer.frameIndex;
  pixelEditor.name = answer.name;
  pixelEditor.width = answer.width;
  pixelEditor.height = answer.height;
  pixelEditor.layers = answer.layers;
  pixelEditor.colorMode=answer.colorMode;pixelEditor.documentPalette=answer.documentPalette;
  pixelEditor.activeLayerId = answer.activeLayerId;
  window.spriteLabFramesUI?.sync(answer);
  if (answer.composite) pixelEditor.composite = answer.composite instanceof Uint8ClampedArray
    ? answer.composite
    : new Uint8ClampedArray(answer.composite);
  $("#pixelUndo").disabled = !answer.canUndo;
  $("#pixelRedo").disabled = !answer.canRedo;
  $("#pixelEditorBadge").textContent = t("КАДР {number}", { number: answer.frameIndex + 1 });
  $("#pixelEditorSize").textContent = `${answer.width} × ${answer.height}`;
  pixelEditorRenderCanvas();
  pixelEditorRenderLayers();
  window.spriteLabPaletteUI?.sync();
  window.spriteLabTextUI?.sync();
  pixelEditorUpdateCursorInfo();
  if (answer.blocked) pixelEditorStatus(answer.blocked, "warn");
  else if (answer.label) pixelEditorStatus(answer.label, "done");
}

function pixelEditorPaletteFromComposite(composite) { return window.SpriteLabPixelColors.palette(composite); }

function pixelEditorFitZoom() {
  const wrap = $("#pixelCanvasWrap");
  const availableWidth = Math.max(1, wrap.clientWidth - 28);
  const availableHeight = Math.max(1, wrap.clientHeight - 28);
  const fit = Math.min(availableWidth / Math.max(1, pixelEditor.width), availableHeight / Math.max(1, pixelEditor.height));
  return Math.max(0.01, Math.min(24, fit >= 1 ? Math.floor(fit) : fit));
}

function pixelEditorSetTool(tool) {
  pixelEditor.tool = tool;
  const tools = { line:'#pixelToolLine',rectangle:'#pixelToolRectangle',ellipse:'#pixelToolEllipse',text: '#pixelToolText', select: "#pixelToolSelect", wand: "#pixelToolWand", lasso: "#pixelToolLasso", pencil: "#pixelToolPencil", eraser: "#pixelToolEraser", fill: "#pixelToolFill", picker: "#pixelToolPicker" };
  for (const [name, selector] of Object.entries(tools)) $(selector).classList.toggle("active", name === tool);
  const hints = { select: "Выделите прямоугольник. Перенос и удаление работают с пикселями активного слоя и отменяются Ctrl+Z.", wand: "Палочка: связанная область похожего цвета; допуск — «Разброс». Можно отделить часть слипшегося объекта.", lasso: "Обведите часть объекта, затем перенесите или удалите выделенные пиксели.",
    text: 'Текст: нажмите на кадр, чтобы задать положение. Надпись меняется в панели «Текстовый слой». Перемещение и правка отменяются Ctrl+Z.',
    pencil: "Карандаш: рисует основным цветом. Удерживайте кнопку мыши, чтобы вести линию.",
    eraser: "Ластик: стирает пиксели выбранного слоя до прозрачности.",
    fill: "Заливка: заливает связанную область под курсором. «Разброс» задаёт, какие цвета считать одинаковыми, а «Стереть кайму» убирает почти прозрачный ореол вокруг спрайта.",
    picker: "Пипетка: берёт цвет из кадра как основной. Не меняет пиксели.",
  };
  $("#pixelEditorHint").textContent = hints[tool] || 'Протяните фигуру от начала к концу. Размер, форма кисти, жёсткость и непрозрачность задаются в настройках кисти. Ctrl+Z отменяет фигуру.';
}

async function pixelEditorOpen() {
  if (!state.result?.allSourceFramePaths?.length || state.busy || state.source?.kind === "video-batch") return;
  const frameIndex = state.selectedFrameIndex;
  const sourcePath = state.frameOverrides[frameIndex] || state.result.allSourceFramePaths[frameIndex];
  pixelEditorStatus("Открываю кадр…", "busy");
  const record = state.frameDocuments[frameIndex];
  const entries = state.intent === 'animation' ? timelineEntries() : [];
  const indices = [...new Set(entries.map(entry=>entry.src))];
  const series = indices.length > 1 ? indices.map(index=>{const file=state.frameOverrides[index]||state.result.allSourceFramePaths[index],doc=state.frameDocuments[index];return {index,path:file,documentPath:doc?.imagePath===file?doc.path:undefined,durationMs:entries.find(entry=>entry.src===index)?.d||baseDurationMs()};}) : undefined;
  const answer = await window.spriteLab.openPixelEditor({ path: sourcePath, series, frameIndex, name: "frame", documentPath: record?.imagePath === sourcePath ? record.path : undefined });
  pixelEditorCancelPreview();
  pixelEditorApplyState(answer);
  pixelEditorMarkApplied();
  pixelEditor.palette = pixelEditorPaletteFromComposite(pixelEditor.composite);
  pixelEditor.zoom = 1;
  pixelEditorRenderCanvas();
  $("#pixelPalette").scrollTop = 0;
  pixelEditorRenderPalette();
  pixelEditorSetTool("pencil");
  pixelEditorSetColor(pixelEditor.color);
  pixelEditorStatus(t(state.intent === "images" ? "Правки применяются к проекту. PNG сохраняется в главном окне." : "Примените правки к проекту, затем пересоберите лист перед экспортом."), "ready");
  setModalOpen($("#pixelEditorModal"), true, $("#pixelToolPencil"), $("#openPixelEditor"));
  window.spriteLabTextUI?.reset();
  if (state.intent === "images") $("#pixelAdjustDetails").open = true;
  // Measure after the dialog is laid out; hidden elements have no viewport.
  await new Promise(resolve => requestAnimationFrame(resolve));
  if (pixelEditorIsOpen()) pixelEditorSetZoom(pixelEditorFitZoom(), true);
}

function pixelEditorMarkApplied() {
  pixelEditor.savedPixels = pixelEditor.composite.slice();
  pixelEditor.savedLayers = JSON.stringify(pixelEditor.layers);pixelEditor.savedPalette=JSON.stringify([pixelEditor.colorMode,pixelEditor.documentPalette]);
}

function pixelEditorHasPendingEdits() {
  if (!pixelEditor.sessionId || !pixelEditor.savedPixels) return false;
  if (pixelEditor.frameIndices?.length > 1) return pixelEditor.seriesDirty || Boolean(pixelEditor.preview) || Boolean(window.spriteLabTextUI?.hasDraft());
  if (JSON.stringify(pixelEditor.layers) !== pixelEditor.savedLayers || JSON.stringify([pixelEditor.colorMode,pixelEditor.documentPalette])!==pixelEditor.savedPalette) return true;
  if (window.spriteLabTextUI?.hasDraft()) return true;
  const pixels = pixelEditor.composite, preview = pixelEditor.preview;
  return pixels.some((n, i) => n !== pixelEditor.savedPixels[i] || (preview && preview[i] !== n));
}

function pixelEditorAnswerClose(choice) {
  const answer = pixelEditorCloseDecision;
  pixelEditorCloseDecision = null;
  $("#pixelClosePrompt").classList.add("hidden");
  answer?.(choice);
}

async function pixelEditorClose() {
  window.spriteLabFramesUI?.stop();
  if (!pixelEditorIsOpen()) return true;
  if (pixelEditorCloseDecision || pixelColorBusy || pixelEditorApplying) return false;
  await pixelEditorFlush();
  if (pixelEditorHasPendingEdits()) {
    const choice = await new Promise(resolve => {
      pixelEditorCloseDecision = resolve;
      $("#pixelClosePrompt").classList.remove("hidden");
      $("#pixelCloseKeep").focus();
    });
    if (choice === "keep") return false;
    if (choice === "apply") {
      try { if (!await pixelEditorSave()) return false; }
      catch (error) { pixelEditorStatus(error?.message || "Не удалось применить правки", "error"); return false; }
    }
  }
  pixelEditorCancelPreview();
  const sessionId = pixelEditor.sessionId;
  pixelEditor.sessionId = null;
  setModalOpen($("#pixelEditorModal"), false, null, $("#openPixelEditor"));
  pixelEditor.drawing = false;
  pixelEditor.lastPoint = null;
  if (sessionId) await window.spriteLab.pixelEditorOp({ op: "close", sessionId }).catch(() => {});
  return true;
}

window.spriteLabPrepareEditorClose = async () => pixelEditorClose();

async function pixelEditorSave() {
  if (!pixelEditor.sessionId || pixelColorBusy || pixelEditorApplying) return false;
  pixelEditorApplying = true;
  $("#pixelSaveFrame").disabled = true;
  try {
    if (pixelEditor.preview || window.spriteLabTextUI?.hasDraft()) {
      const answer = window.spriteLabTextUI?.hasDraft() ? await window.spriteLabTextUI.commit() : window.spriteLabTextRepairUI?.hasDraft() ? await window.spriteLabTextRepairUI.commit() : window.spriteLabPaletteUI?.hasDraft() ? await window.spriteLabPaletteUI.commit() : pixelColorDraft ? await pixelColorCommit() : pixelAdjustDraft ? await pixelAdjustmentCommit() : null;
      if (!answer || answer.blocked) return false;
    }
    const frameIndex = pixelEditor.frameIndex;
    pixelEditorStatus(t("Применяю правки к проекту…"), "busy");
    await pixelEditorFlush();
    const saved = await window.spriteLab.savePixelEditor({ sessionId: pixelEditor.sessionId, frameIndex, name: pixelEditor.name, series:pixelEditor.frameIndices?.length>1 });
    for(const frame of saved.frames||[{...saved,frameIndex}]){state.frameOverrides[frame.frameIndex]=frame.path;state.frameDocuments[frame.frameIndex]={path:frame.documentPath,imagePath:frame.path};if(saved.frames){state.frameMetadata[frame.frameIndex]={...state.frameMetadata[frame.frameIndex],durationMs:frame.durationMs};for(const entry of state.timeline||[])if(entry.src===frame.frameIndex)entry.d=frame.durationMs;}}
    pixelEditor.seriesDirty=false;
    pixelEditorMarkApplied();
    if (state.intent === "images") {
      state.resultDirty = false;
      updateActionState();
      pixelEditorStatus(t("Правки в проекте · сохраните PNG в главном окне"), "done");
      setStatus(t("Изображение {number} изменено · сохраните PNG", { number: frameIndex + 1 }), "done", 0);
    } else {
      markPreviewDirty();
      pixelEditorStatus(t("Правки в проекте · пересоберите лист перед экспортом"), "done");
      setStatus(t("Кадр {number} изменён в пиксельном редакторе · пересоберите анимацию", { number: frameIndex + 1 }), "done", 0);
    }
    pushHistory(t("Кадр {number} изменён в пиксельном редакторе", { number: frameIndex + 1 }));
    if (state.result) buildFilmstrip(state.result);
    try {
      await requestFramePreview(saved.path);
    } catch (error) {
      setStatus(error?.message || "Правки применены, но предпросмотр не обновился", "error", 0);
    }
    return true;
  } finally { pixelEditorApplying = false; $("#pixelSaveFrame").disabled = pixelColorBusy; }
}

/* ------------------------------------------------------------------ pointer */

function pixelEditorSampleCursor(point) {
  pixelEditor.cursor = point;
  pixelEditorUpdateCursorInfo();
  pixelEditorRenderCanvas();
}

function pixelEditorPaintTo(point) {
  const erase = pixelEditor.tool === "eraser";
  const from = pixelEditor.lastPoint || point;
  pixelEditor.lastPoint = point;
  pixelEditorSend({ op: "paint", from: [from.x, from.y], to: [point.x, point.y], color: pixelEditor.color, size: pixelEditor.brush, shape: pixelEditor.brushShape, hardness: Number($('#pixelBrushHardness').value), opacity: Number($('#pixelBrushOpacity').value), symmetry: $('#pixelBrushSymmetry').value, pixelPerfect: $('#pixelBrushPerfect').checked, wrap:$('#pixelTileWrap').checked, continueStroke: true, beginStroke: pixelEditor.strokeStart, erase });
  pixelEditor.strokeStart = false;
}

function pixelEditorPointerDown(event) {
  if (event.button !== 0 || !pixelEditor.sessionId) return;
  if (pixelEditor.tool === 'text') { const point = pixelEditorPointFromEvent(event); if (point.inside) window.spriteLabTextUI?.position(point); return; }
  if (pixelEditor.preview) {
    pixelEditorStatus("Примените или отмените предпросмотр перед рисованием.", "warn");
    return;
  }
  const point = pixelEditorPointFromEvent(event);
  if (!point.inside) return;
  if(['line','rectangle','ellipse'].includes(pixelEditor.tool)){event.currentTarget.setPointerCapture?.(event.pointerId);pixelEditor.shapeStart=point;return;}
  if (["select", "wand", "lasso"].includes(pixelEditor.tool)) {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    if (pixelEditor.tool === "wand") pixelEditorSend({ op: "selectPixels", mode: "wand", from: [point.x, point.y], tolerance: pixelEditor.tolerance });
    else { pixelEditor.selectionStart = point; pixelEditor.selectionPoints = [[point.x, point.y]]; }
    return;
  }
  if (pixelEditor.tool === "picker") {
    window.spriteLab.pixelEditorOp({ op: "pick", sessionId: pixelEditor.sessionId, x: point.x, y: point.y })
      .then((answer) => {
        if (answer?.color && answer.color[3] > 0) {
          pixelEditorSetColor(answer.color);
          pixelEditorChooseFrameColor(answer.color);
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
  pixelEditor.strokeStart = true;
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
  if(pixelEditor.shapeStart&&point.inside){const start=pixelEditor.shapeStart;void window.spriteLab.pixelEditorOp({op:'shape',preview:true,sessionId:pixelEditor.sessionId,kind:pixelEditor.tool,from:[start.x,start.y],to:[point.x,point.y],color:pixelEditor.color,size:pixelEditor.brush,shape:pixelEditor.brushShape,opacity:Number($('#pixelBrushOpacity').value),hardness:Number($('#pixelBrushHardness').value),filled:$('#pixelShapeFilled').checked}).then(pixels=>{if(pixelEditor.shapeStart===start){pixelEditor.preview=new Uint8ClampedArray(pixels);pixelEditorRenderCanvas();}}).catch(error=>pixelEditorStatus(error.message,'error'));return;}
  if (pixelEditor.selectionStart && point.inside) { pixelEditor.selectionPoints.push([point.x, point.y]); return; }
  if (!pixelEditor.drawing || !point.inside) return;
  pixelEditorPaintTo(point);
}

function pixelEditorPointerUp(event) {
  if(pixelEditor.shapeStart){const start=pixelEditor.shapeStart,point=pixelEditorPointFromEvent(event);pixelEditor.shapeStart=null;pixelEditorCancelPreview();pixelEditorSend({op:'shape',kind:pixelEditor.tool,from:[start.x,start.y],to:[point.x,point.y],color:pixelEditor.color,size:pixelEditor.brush,shape:pixelEditor.brushShape,opacity:Number($('#pixelBrushOpacity').value),hardness:Number($('#pixelBrushHardness').value),filled:$('#pixelShapeFilled').checked});return;}
  if (pixelEditor.selectionStart) {
    const point = pixelEditorPointFromEvent(event), start = pixelEditor.selectionStart; pixelEditor.selectionStart = null;
    pixelEditorSend({ op: "selectPixels", mode: pixelEditor.tool === "lasso" ? "lasso" : "rect", from: [start.x, start.y], to: [point.x, point.y], points: pixelEditor.selectionPoints });
    return;
  }
  if (!pixelEditor.drawing) return;
  pixelEditor.drawing = false;
  pixelEditor.lastPoint = null;
  pixelEditorSend({ op: 'endStroke' });
  event.currentTarget.releasePointerCapture?.(event.pointerId);
}

function pixelEditorWheel(event) {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  pixelEditorSetZoom(pixelEditor.zoom * (event.deltaY < 0 ? 1.25 : 0.8));
}

function pixelEditorSetZoom(value, fit = false) {
  pixelEditor.fitActive = fit;
  pixelEditor.zoom = Math.max(0.01, Math.min(24, value));
  pixelEditorRenderCanvas();
}

new ResizeObserver(() => {
  if (pixelEditorIsOpen() && pixelEditor.fitActive) {
    const zoom = pixelEditorFitZoom();
    if (Math.abs(zoom - pixelEditor.zoom) > 0.0001) pixelEditorSetZoom(zoom, true);
  }
}).observe($("#pixelCanvasWrap"));

/* ------------------------------------------------------------------ wiring */

function pixelEditorSyncBrush() {
  pixelEditor.brush = Math.max(1, Math.min(64, Number($("#pixelBrushSize").value) || 1));
  pixelEditor.brushShape = $("#pixelBrushShape").value;
  $("#pixelBrushValue").textContent = `${pixelEditor.brush} px`;
  if (pixelEditorIsOpen()) pixelEditorRenderCanvas();
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

$("#pixelCloseKeep").addEventListener("click", () => pixelEditorAnswerClose("keep"));
$("#pixelCloseDiscard").addEventListener("click", () => pixelEditorAnswerClose("discard"));
$("#pixelCloseApply").addEventListener("click", () => pixelEditorAnswerClose("apply"));
$("#closePixelEditor").addEventListener("click", () => { void pixelEditorClose(); });
$("#pixelEditorModal").addEventListener("click", (event) => { if (event.target === $("#pixelEditorModal")) void pixelEditorClose(); });
$("#pixelToolPencil").addEventListener("click", () => pixelEditorSetTool("pencil"));
$("#pixelToolEraser").addEventListener("click", () => pixelEditorSetTool("eraser"));
$("#pixelToolFill").addEventListener("click", () => pixelEditorSetTool("fill"));
$("#pixelToolPicker").addEventListener("click", () => pixelEditorSetTool("picker"));
for(const [tool,id]of[['line','pixelToolLine'],['rectangle','pixelToolRectangle'],['ellipse','pixelToolEllipse']])$('#'+id).addEventListener('click',()=>pixelEditorSetTool(tool));
for(const [id,mode]of[['pixelFlipX','flip-x'],['pixelFlipY','flip-y'],['pixelRotateLeft','rotate-left'],['pixelRotateRight','rotate-right']])$('#'+id).addEventListener('click',()=>pixelEditorSend({op:'rotateSelection',mode}));
$("#pixelBrushSize").addEventListener("input", pixelEditorSyncBrush);
$("#pixelBrushShape").addEventListener("change", pixelEditorSyncBrush);
for (const [field,output] of [['pixelBrushHardness','pixelBrushHardnessValue'],['pixelBrushOpacity','pixelBrushOpacityValue']]) $('#'+field).addEventListener('input',()=>{ $('#'+output).textContent=$('#'+field).value+'%';pixelEditorRenderCanvas(); });
$("#pixelTolerance").addEventListener("input", pixelEditorSyncTolerance);
$("#pixelEraseTransparent").addEventListener("click", () => {
  pixelEditorSend({ op: "eraseTransparent", threshold: pixelEditor.tolerance });
});
$("#pixelInkColor").addEventListener("input", () => pixelEditorSetColor(pixelEditorColorFromHex($("#pixelInkColor").value)));
$("#pixelGrid").addEventListener("change", () => { pixelEditor.gridOn = $("#pixelGrid").checked; pixelEditorRenderCanvas(); });
$("#pixelZoomIn").addEventListener("click", () => pixelEditorSetZoom(pixelEditor.zoom * 1.25));
$("#pixelZoomOut").addEventListener("click", () => pixelEditorSetZoom(pixelEditor.zoom * 0.8));
$("#pixelZoomFit").addEventListener("click", () => pixelEditorSetZoom(pixelEditorFitZoom()));
$("#pixelUndo").addEventListener("click", () => { if (pixelEditor.preview) pixelEditorCancelPreview(); else pixelEditorSend({ op: "undo" }); });
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
  const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement;
  const key = event.code?.startsWith("Key") ? event.code.slice(3).toLowerCase() : event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === "s") { event.preventDefault(); void pixelEditorSave().catch((error) => pixelEditorStatus(error?.message || "Не удалось сохранить кадр", "error")); return; }
  if ((event.ctrlKey || event.metaKey) && key === "z") { if (typing && event.target instanceof HTMLTextAreaElement) return; event.preventDefault(); if (pixelEditor.preview) pixelEditorCancelPreview(); else pixelEditorSend({ op: event.shiftKey ? "redo" : "undo" }); return; }
  if ((event.ctrlKey || event.metaKey) && key === "y") { event.preventDefault(); pixelEditorSend({ op: "redo" }); return; }
  if (key === "escape" && pixelEditorCloseDecision) { event.preventDefault(); pixelEditorAnswerClose("keep"); return; }
  if (typing || event.ctrlKey || event.metaKey) return;
  if (key === "escape") { event.preventDefault(); void pixelEditorClose(); return; }
  if (key === "p" || key === "b") pixelEditorSetTool("pencil");
  else if (key === "e") pixelEditorSetTool("eraser");
  else if (key === "g" || key === "f") pixelEditorSetTool("fill");
  else if (key === "i") pixelEditorSetTool("picker");
  else if (key === "m") pixelEditorSetTool("select");
  else if (key === "w") pixelEditorSetTool("wand");
  else if (key === "l") pixelEditorSetTool("lasso");
  else if (key === 't') window.spriteLabTextUI?.open();
  else if (key === "delete" && pixelEditor.selection) pixelEditorSend({ op: "movePixels", erase: true });
  else if (key === "[" || key === "]") {
    $("#pixelBrushSize").value = String(Math.max(1, Math.min(64, pixelEditor.brush + (key === "]" ? 1 : -1))));
    pixelEditorSyncBrush();
  } else if (key === "+" || key === "=") pixelEditorSetZoom(pixelEditor.zoom * 1.25);
  else if (key === "-" || key === "_") pixelEditorSetZoom(pixelEditor.zoom * 0.8);
});

pixelEditorSyncBrush();
pixelEditorSyncTolerance();
pixelEditorSetTool("pencil");
pixelEditorStatus("Откройте кадр из полосы кадров.", "ready");

for (const [id, tool] of [["pixelToolSelect", "select"], ["pixelToolWand", "wand"], ["pixelToolLasso", "lasso"]]) $("#" + id).addEventListener("click", () => pixelEditorSetTool(tool));
$("#pixelMoveSelection").addEventListener("click", () => pixelEditorSend({ op: "movePixels", dx: Number($("#pixelSelectionX").value), dy: Number($("#pixelSelectionY").value) }));
$("#pixelCutSelection").addEventListener("click", () => pixelEditorSend({ op: "movePixels", erase: true }));
$("#pixelClearSelection").addEventListener("click", () => pixelEditorSend({ op: "selectPixels", clear: true }));

$("#pixelSeparateSelection").addEventListener("click", () => pixelEditorSend({ op: "movePixels", newLayer: true, dx: Number($("#pixelSelectionX").value), dy: Number($("#pixelSelectionY").value) }));
