// The view moves; mask edits always use normalized source coordinates.
const maskNav = { zoom: 1, x: 0, y: 0, drag: null, colorEdit: null, smartSeed: null };
const maskShell = $("#maskCanvas").parentElement;
function updateMaskNavigation() {
  const canvas = $("#maskCanvas");
  if (!state.maskEditorImage) return;
  const fit = Math.min((maskShell.clientWidth - 48) / canvas.width, (maskShell.clientHeight - 96) / canvas.height);
  canvas.style.width = `${Math.max(1, canvas.width * fit)}px`; canvas.style.height = `${Math.max(1, canvas.height * fit)}px`;
  canvas.style.transform = `translate(${maskNav.x}px, ${maskNav.y}px) scale(${maskNav.zoom})`;
  $("#maskZoomValue").textContent = `${Math.round(fit * maskNav.zoom * canvas.width / state.maskEditorImage.naturalWidth * 100)}%`;
}
window.resetMaskNavigation = () => { Object.assign(maskNav, { zoom: 1, x: 0, y: 0, drag: null, colorEdit: null, smartSeed: null }); updateMaskNavigation(); };
function zoomMask(factor, clientX, clientY) {
  const rect = maskShell.getBoundingClientRect(), old = maskNav.zoom, next = Math.max(.2, Math.min(32, old * factor));
  const x = (clientX ?? rect.left + rect.width / 2) - rect.left - rect.width / 2;
  const y = (clientY ?? rect.top + rect.height / 2) - rect.top - rect.height / 2;
  maskNav.x = x - (x - maskNav.x) * next / old; maskNav.y = y - (y - maskNav.y) * next / old;
  maskNav.zoom = next; updateMaskNavigation();
}
maskShell.addEventListener("wheel", event => { if (event.target.closest(".mask-navigation")) return; event.preventDefault(); zoomMask(Math.exp(-event.deltaY * .002), event.clientX, event.clientY); }, { passive: false });
maskShell.addEventListener("pointerdown", event => {
  if (event.target.closest(".mask-navigation, .mask-canvas-legend") || ![0, 1].includes(event.button)) return;
  $("#maskCanvas").focus({ preventScroll: true });
  const tool = state.maskBrushMode;
  if (event.target === $("#maskCanvas") && !state.spaceHand && event.button === 0 && !["smart", "color"].includes(tool)) return;
  event.preventDefault(); event.stopPropagation();
  maskNav.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, panX: maskNav.x, panY: maskNav.y, moved: false, tool, sample: event.target === $("#maskCanvas") && !state.spaceHand && event.button === 0 };
  maskShell.setPointerCapture(event.pointerId);
}, true);
maskShell.addEventListener("pointermove", event => {
  const drag = maskNav.drag; if (!drag || drag.id !== event.pointerId) return;
  event.preventDefault(); event.stopPropagation();
  if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 4) drag.moved = true;
  if (drag.moved) { maskNav.x = drag.panX + event.clientX - drag.x; maskNav.y = drag.panY + event.clientY - drag.y; updateMaskNavigation(); }
}, true);
for (const name of ["pointerup", "pointercancel"]) maskShell.addEventListener(name, event => {
  const drag = maskNav.drag; if (!drag || drag.id !== event.pointerId) return;
  event.preventDefault(); event.stopPropagation(); maskNav.drag = null;
  if (maskShell.hasPointerCapture(event.pointerId)) maskShell.releasePointerCapture(event.pointerId);
  if (name !== "pointerup" || drag.moved || !drag.sample) return;
  if (drag.tool === "smart") { maskNav.smartSeed = maskSelectionPoint(event); selectTrackedRegion(event); rememberMaskOperation(); }
  if (drag.tool === "color") {
    const point = maskSelectionPoint(event), { width, height } = maskRegion.info;
    const offset = (Math.min(height - 1, Math.floor(point.y * height)) * width + Math.min(width - 1, Math.floor(point.x * width))) * 4;
    if (!maskRegion.natural[offset + 3]) { $("#maskToolTip").textContent = "Это уже прозрачный пиксель. Щёлкните по непрозрачному остатку фона."; return; }
    window.previewGlobalMaskColor([...maskRegion.natural.slice(offset, offset + 3)]);
  }
}, true);
window.previewGlobalMaskColor = color => {
  if (!maskRegion.natural) return;
  const previous = maskNav.colorEdit;
  if (previous && state.maskEdits.includes(previous)) state.maskEdits.splice(state.maskEdits.indexOf(previous), 1);
  const edit = { type: "region-color", color, tolerance: Number($("#smartRegionTolerance").value), selection: null, frameIndex: activeMaskFrameIndex(), applyAll: $("#maskApplyAll").checked, strokeId: ++state.maskStrokeId };
  const count = maskRegion.tools.removeRegionColor(maskRegion.natural.slice(), maskRegion.natural, maskRegion.info, edit);
  maskNav.colorEdit = edit; state.maskEdits.push(edit); rememberMaskOperation();
  $("#maskToolTip").textContent = count ? `Выбрано ${count} пикселей по всему изображению, включая отдельные островки. Подсвеченные пиксели удалятся после применения. Проверьте детали; допуск меняет маску.` : "Похожих непрозрачных пикселей нет. Увеличьте допуск или щёлкните по другому образцу.";
};
$("#smartRegionTolerance").addEventListener("input", () => {
  if (state.maskBrushMode === "color" && maskNav.colorEdit) window.previewGlobalMaskColor(maskNav.colorEdit.color);
  if (state.maskBrushMode === "smart" && maskNav.smartSeed) {
    const edit = state.maskEdits.at(-1); if (edit?.type === "tracked-region") state.maskEdits.pop();
    const rect = $("#maskCanvas").getBoundingClientRect();
    selectTrackedRegion({ clientX: rect.left + maskNav.smartSeed.x * rect.width, clientY: rect.top + maskNav.smartSeed.y * rect.height }); rememberMaskOperation();
  }
});
$("#maskApplyAll").addEventListener("change", () => { if (state.maskBrushMode === "color" && maskNav.colorEdit) window.previewGlobalMaskColor(maskNav.colorEdit.color); });
$("#maskZoomIn").addEventListener("click", () => zoomMask(1.25));
$("#maskZoomOut").addEventListener("click", () => zoomMask(.8));
$("#maskZoomFit").addEventListener("click", () => { maskNav.zoom = 1; maskNav.x = maskNav.y = 0; updateMaskNavigation(); });
new ResizeObserver(updateMaskNavigation).observe(maskShell);
