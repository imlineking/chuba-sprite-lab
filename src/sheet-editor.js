// The original sheet remains untouched. Rectangles are saved with the project
// and only become extracted frames when the user applies the new layout.
function sheetImagePoint(event) {
  const image = $("#sheetEditorImage");
  const rect = image.getBoundingClientRect();
  const width = state.source?.sheetWidth || image.naturalWidth;
  const height = state.source?.sheetHeight || image.naturalHeight;
  return {
    x: Math.max(0, Math.min(width, Math.round((event.clientX - rect.left) * width / rect.width))),
    y: Math.max(0, Math.min(height, Math.round((event.clientY - rect.top) * height / rect.height))),
  };
}

function sheetClampCell(cell) {
  const width = state.source?.sheetWidth || 1;
  const height = state.source?.sheetHeight || 1;
  const left = Math.max(0, Math.min(width - 1, Math.round(Number(cell.left) || 0)));
  const top = Math.max(0, Math.min(height - 1, Math.round(Number(cell.top) || 0)));
  return {
    left, top,
    width: Math.max(1, Math.min(width - left, Math.round(Number(cell.width) || 1))),
    height: Math.max(1, Math.min(height - top, Math.round(Number(cell.height) || 1))),
  };
}

function drawSheetCells() {
  const overlay = $("#sheetCellOverlay");
  overlay.replaceChildren();
  const width = state.source?.sheetWidth || 1;
  const height = state.source?.sheetHeight || 1;
  state.sheetDraftCells.forEach((cell, index) => {
    const box = document.createElement("span");
    box.className = "sheet-cell-box";
    box.style.left = `${cell.left / width * 100}%`;
    box.style.top = `${cell.top / height * 100}%`;
    box.style.width = `${cell.width / width * 100}%`;
    box.style.height = `${cell.height / height * 100}%`;
    box.textContent = String(index + 1);
    overlay.append(box);
  });
  $("#sheetCellCount").textContent = `${state.sheetDraftCells.length} кадр.`;
}

function renderSheetCellList() {
  const list = $("#sheetCellList");
  list.replaceChildren();
  state.sheetDraftCells.forEach((cell, index) => {
    const row = document.createElement("div");
    row.className = "sheet-cell-row";
    const title = document.createElement("strong");
    title.textContent = `#${index + 1}`;
    row.append(title);
    for (const [key, label] of [["left", "X"], ["top", "Y"], ["width", "W"], ["height", "H"]]) {
      const field = document.createElement("label");
      field.textContent = label;
      const input = document.createElement("input");
      input.type = "number"; input.min = key === "width" || key === "height" ? "1" : "0";
      input.value = String(cell[key]); input.setAttribute("aria-label", `Кадр ${index + 1}: ${label}`);
      input.addEventListener("change", () => {
        state.sheetDraftCells[index] = sheetClampCell({ ...state.sheetDraftCells[index], [key]: input.value });
        renderSheetCellList(); drawSheetCells(); saveSessionSoon();
      });
      field.append(input); row.append(field);
    }
    const remove = document.createElement("button");
    remove.type = "button"; remove.textContent = "×"; remove.title = `Удалить рамку ${index + 1}`;
    remove.addEventListener("click", () => {
      if (state.sheetDraftCells.length <= 1) return;
      state.sheetDraftCells.splice(index, 1);
      renderSheetCellList(); drawSheetCells(); saveSessionSoon();
    });
    row.append(remove); list.append(row);
  });
}

function renderSheetEditor(source) {
  state.sheetDraftCells = source?.kind === "sheet" ? (source.sheetCells || []).map(sheetClampCell) : [];
  $("#sheetManualEditor").classList.toggle("hidden", source?.kind !== "sheet" || source.sheetMode !== "manual");
  if (source?.kind !== "sheet") return;
  $("#sheetEditorImage").src = source.sheetUrl;
  updateSheetManualGrid();
  renderSheetCellList(); drawSheetCells();
}

function updateSheetManualGrid() {
  const grid = $("#sheetManualGrid");
  grid.classList.toggle("hidden", !$("#sheetShowGrid").checked);
  const image = $("#sheetEditorImage");
  const width = state.source?.sheetWidth || image.naturalWidth;
  if (!width || !image.clientWidth) return;
  const pixels = Math.max(2, Number($("#sheetGridSpacing").value) * image.clientWidth / width);
  grid.style.backgroundSize = `${pixels}px ${pixels}px`;
}

$("#sheetEditorImage").addEventListener("load", updateSheetManualGrid);
$("#sheetShowGrid").addEventListener("change", updateSheetManualGrid);
$("#sheetGridSpacing").addEventListener("change", updateSheetManualGrid);
new ResizeObserver(updateSheetManualGrid).observe($("#sheetEditorStage"));

function chooseManualSheetMode() {
  $$("#sheetSliceMode button").forEach((button) => button.classList.toggle("selected", button.dataset.sheetMode === "manual"));
  $("#sheetGridFields").classList.add("hidden");
  $("#sheetManualEditor").classList.remove("hidden");
}

$("#sheetAddCell").addEventListener("click", () => {
  if (!state.source?.sheetPath) return;
  chooseManualSheetMode();
  state.sheetDraftCells.push(sheetClampCell({ left: 0, top: 0, width: 64, height: 64 }));
  renderSheetCellList(); drawSheetCells(); saveSessionSoon();
});

let sheetDrawing = null;
$("#sheetDrawCell").addEventListener("click", () => {
  chooseManualSheetMode();
  $("#sheetEditorStage").classList.toggle("drawing");
  $("#sheetDrawCell").classList.toggle("active");
});
$("#sheetEditorStage").addEventListener("pointerdown", (event) => {
  if (!$("#sheetEditorStage").classList.contains("drawing")) return;
  event.preventDefault();
  sheetDrawing = { start: sheetImagePoint(event), index: state.sheetDraftCells.length };
  state.sheetDraftCells.push(sheetClampCell({ left: sheetDrawing.start.x, top: sheetDrawing.start.y, width: 1, height: 1 }));
  event.currentTarget.setPointerCapture(event.pointerId);
  drawSheetCells();
});
$("#sheetEditorStage").addEventListener("pointermove", (event) => {
  if (!sheetDrawing) return;
  const point = sheetImagePoint(event);
  const left = Math.min(sheetDrawing.start.x, point.x);
  const top = Math.min(sheetDrawing.start.y, point.y);
  state.sheetDraftCells[sheetDrawing.index] = sheetClampCell({ left, top, width: Math.abs(point.x - sheetDrawing.start.x), height: Math.abs(point.y - sheetDrawing.start.y) });
  drawSheetCells();
});
$("#sheetEditorStage").addEventListener("pointerup", () => {
  if (!sheetDrawing) return;
  const cell = state.sheetDraftCells[sheetDrawing.index];
  if (cell.width < 3 || cell.height < 3) state.sheetDraftCells.splice(sheetDrawing.index, 1);
  sheetDrawing = null;
  renderSheetCellList(); drawSheetCells(); saveSessionSoon();
});
