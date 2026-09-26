const maskRegion = { selection: null, start: null, picking: false, history: [], index: 0, tools: null, natural: null, info: null, checkerCache: new WeakMap() };
const maskRegionReady = Promise.all([import("./region-color.mjs"), import("./mask-edits.mjs")]).then(([region, masks]) => { maskRegion.tools = { ...region, ...masks }; });

function rememberMaskOperation() {
  const snapshot = structuredClone(state.maskEdits);
  if (JSON.stringify(snapshot) === JSON.stringify(maskRegion.history[maskRegion.index])) return;
  maskRegion.history = maskRegion.history.slice(0, maskRegion.index + 1);
  maskRegion.history.push(snapshot);
  if (maskRegion.history.length > 60) maskRegion.history.shift();
  maskRegion.index = maskRegion.history.length - 1;
  redrawMaskCanvas();
}
window.initializeMaskRegion = async function initializeMaskRegion(image) {
  await maskRegionReady;
  maskRegion.selection = null; maskRegion.start = null; maskRegion.picking = false;
  maskRegion.history = [structuredClone(state.maskEdits)]; maskRegion.index = 0;
  maskRegion.checkerCache = new WeakMap();
  const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true }); context.drawImage(image, 0, 0);
  maskRegion.natural = context.getImageData(0, 0, canvas.width, canvas.height).data;
  maskRegion.info = { width: canvas.width, height: canvas.height, channels: 4 };
};
window.undoMaskOperation = function undoMaskOperation(redo = false) {
  const next = maskRegion.index + (redo ? 1 : -1);
  if (next < 0 || next >= maskRegion.history.length) return;
  maskRegion.index = next; state.maskEdits = structuredClone(maskRegion.history[next]);
  maskRegion.selection = null; redrawMaskCanvas();
};
window.drawRegionMask = function drawRegionMask(context, canvas) {
  if (!maskRegion.tools || !state.maskEditorPixels) return;
  const pixels = state.maskEditorPixels.slice(), info = { width: canvas.width, height: canvas.height, channels: 4 };
  for (const edit of state.maskEdits) {
    if (!maskEditApplies(edit)) continue;
    if (!edit.type && ["erase", "keep"].includes(edit.mode)) maskRegion.tools.applyMaskEdits(pixels, state.maskEditorPixels, info, [edit], activeMaskFrameIndex());
    if (edit.type === "region-color") maskRegion.tools.removeRegionColor(pixels, state.maskEditorPixels, info, edit);
    if (edit.type === "checker" && maskRegion.natural) {
      let result = maskRegion.checkerCache.get(edit);
      if (!result) {
        const cleaned = maskRegion.natural.slice();
        result = { ...maskRegion.tools.removeChecker(cleaned, maskRegion.natural, maskRegion.info, edit.selection), pixels: cleaned };
        maskRegion.checkerCache.set(edit, result);
      }
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const sourceX = Math.min(maskRegion.info.width - 1, Math.floor((x + .5) / canvas.width * maskRegion.info.width));
        const sourceY = Math.min(maskRegion.info.height - 1, Math.floor((y + .5) / canvas.height * maskRegion.info.height));
        const sourceOffset = (sourceY * maskRegion.info.width + sourceX) * 4, offset = (y * canvas.width + x) * 4;
        pixels[offset + 3] = Math.min(pixels[offset + 3], result.pixels[sourceOffset + 3]);
        if (result.pixels[sourceOffset] !== maskRegion.natural[sourceOffset] || result.pixels[sourceOffset + 1] !== maskRegion.natural[sourceOffset + 1]) {
          pixels[offset] = result.pixels[sourceOffset]; pixels[offset + 1] = result.pixels[sourceOffset + 1]; pixels[offset + 2] = result.pixels[sourceOffset + 2];
        }
      }
    }
  }
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.putImageData(new ImageData(pixels, canvas.width, canvas.height), 0, 0);
};
window.drawRegionSelection = function drawRegionSelection(context, canvas) {
  const selection = maskRegion.selection;
  $("#removeSelectedColor").disabled = !selection;
  $("#undoMaskStroke").disabled = maskRegion.index <= 0;
  $("#redoMaskStroke").disabled = maskRegion.index >= maskRegion.history.length - 1;
  if (!selection) return;
  context.save(); context.strokeStyle = "#00c9cd"; context.fillStyle = "rgba(0,201,205,.09)"; context.lineWidth = 2; context.setLineDash([6, 4]);
  context.beginPath();
  if (selection.points) {
    selection.points.forEach((point, i) => context[i ? "lineTo" : "moveTo"](point.x * canvas.width, point.y * canvas.height)); context.closePath();
  } else context.rect(selection.left * canvas.width, selection.top * canvas.height, (selection.right - selection.left) * canvas.width, (selection.bottom - selection.top) * canvas.height);
  context.fill(); context.stroke(); context.restore();
};
function maskSelectionPoint(event) {
  const rect = $("#maskCanvas").getBoundingClientRect();
  return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
}
$("#maskCanvas").addEventListener("pointerdown", event => {
  if (event.button !== 0) return;
  const point = maskSelectionPoint(event);
  if (maskRegion.picking) {
    const { width, height } = maskRegion.info;
    const offset = (Math.min(height - 1, Math.floor(point.y * height)) * width + Math.min(width - 1, Math.floor(point.x * width))) * 4;
    if (!maskRegion.natural[offset + 3]) { $("#maskToolTip").textContent = "Выберите непрозрачный пиксель фона."; return; }
    $("#regionKeyColor").value = "#" + [...maskRegion.natural.slice(offset, offset + 3)].map(value => value.toString(16).padStart(2, "0")).join("");
    maskRegion.picking = false; setMaskTool("select"); return;
  }
  if (!["select", "lasso"].includes(state.maskBrushMode)) return;
  event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
  maskRegion.start = point;
  maskRegion.selection = state.maskBrushMode === "lasso" ? { points: [point] } : { left: point.x, right: point.x, top: point.y, bottom: point.y };
  redrawMaskCanvas();
});
$("#maskCanvas").addEventListener("pointermove", event => {
  if (!maskRegion.start) return;
  const point = maskSelectionPoint(event);
  if (state.maskBrushMode === "lasso") {
    const points = maskRegion.selection.points, last = points.at(-1);
    if (Math.hypot(point.x - last.x, point.y - last.y) > .001 && points.length < 4096) points.push(point);
  } else maskRegion.selection = { left: Math.min(point.x, maskRegion.start.x), right: Math.max(point.x, maskRegion.start.x), top: Math.min(point.y, maskRegion.start.y), bottom: Math.max(point.y, maskRegion.start.y) };
  redrawMaskCanvas();
});
for (const name of ["pointerup", "pointercancel"]) $("#maskCanvas").addEventListener(name, () => {
  maskRegion.start = null;
  const selection = maskRegion.selection;
  if (selection && (selection.points ? selection.points.length < 3 : selection.right - selection.left < .001 || selection.bottom - selection.top < .001)) maskRegion.selection = null;
  rememberMaskOperation(); redrawMaskCanvas();
});
$("#regionPickColor").addEventListener("click", () => { setMaskTool("pick"); maskRegion.picking = true; $("#maskToolTip").textContent = "Щёлкните по цвету на изображении, затем выделите область."; });
$("#clearRegionSelection").addEventListener("click", () => { maskRegion.selection = null; maskRegion.start = null; redrawMaskCanvas(); });
$("#removeSelectedColor").addEventListener("click", () => {
  if (!maskRegion.selection || !maskRegion.natural) return;
  const edit = { type: "region-color", color: hexToRgb($("#regionKeyColor").value), tolerance: Number($("#regionTolerance").value), selection: structuredClone(maskRegion.selection), frameIndex: activeMaskFrameIndex(), applyAll: $("#maskApplyAll").checked, strokeId: ++state.maskStrokeId };
  const count = maskRegion.tools.removeRegionColor(maskRegion.natural.slice(), maskRegion.natural, maskRegion.info, edit);
  if (count) { state.maskEdits.push(edit); rememberMaskOperation(); }
  $("#maskToolTip").textContent = `Удаление: ${count} пикселей внутри выделения. Остальные цвета сохранены. Примените или отмените правку.`;
});
$("#removeCheckerboard").addEventListener("click", () => {
  if (!maskRegion.natural) return;
  const result = maskRegion.tools.checkerMask(maskRegion.natural, maskRegion.info, maskRegion.selection);
  if (result.count) { state.maskEdits.push({ type: "checker", selection: structuredClone(maskRegion.selection), frameIndex: activeMaskFrameIndex(), applyAll: $("#maskApplyAll").checked, strokeId: ++state.maskStrokeId }); rememberMaskOperation(); }
  $("#maskToolTip").textContent = result.count ? `Найдено ${result.count} пикселей клетчатого узора. Проверьте маску; защищайте нужные детали кистью. Для оставшихся клеток выделите область и удалите оба цвета по очереди.` : "Повторяющийся узор не подтверждён. Выделите фон и удалите его цвета пипеткой; рисунок пока не изменён.";
});
$("#redoMaskStroke").addEventListener("click", () => window.undoMaskOperation(true));
