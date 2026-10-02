// Names, pivots and alignment points are source-frame data; packing never owns them.
window.syncFrameMetadataControls = function () {
  const item = state.frameMetadata[state.selectedFrameIndex] || {};
  $("#frameMetaName").value = item.name || "";
  $("#frameMetaTag").value = item.tag || "";
  $("#framePivotX").value = String(item.pivot?.x ?? .5);
  $("#framePivotY").value = String(item.pivot?.y ?? .5);
  for (let i = 0; i < 2; i++) for (const axis of ["x", "y"]) document.getElementById("framePoint" + (i + 1) + axis.toUpperCase()).value = item.anchorPoints?.[i]?.[axis] ?? "";
  $("#frameAnchorReference").value = String(state.anchorReference + 1);
};

$("#applyFrameMetadata").addEventListener("click", () => {
  const name = $("#frameMetaName").value.trim(), tag = $("#frameMetaTag").value.trim();
  const pivot = { x: Number($("#framePivotX").value), y: Number($("#framePivotY").value) };
  if (![pivot.x, pivot.y].every(n => Number.isFinite(n) && n >= 0 && n <= 1)) { showError("Опора JSON: X и Y от 0 до 1."); return; }
  if (name && Object.entries(state.frameMetadata).some(([i, m]) => Number(i) !== state.selectedFrameIndex && m.name === name)) { showError("У кадров должны быть разные имена."); return; }
  const anchorPoints = [];
  for (let i = 1; i <= 2; i++) {
    const x = document.getElementById("framePoint" + i + "X").value, y = document.getElementById("framePoint" + i + "Y").value;
    if (!x && !y) continue;
    if (!x || !y || ![Number(x), Number(y)].every(n => Number.isFinite(n) && n >= 0)) { showError("Укажите обе координаты точки в пикселях исходного кадра."); return; }
    anchorPoints.push({ x: Number(x), y: Number(y) });
  }
  pushHistory("До правки метаданных кадра");
  state.frameMetadata[state.selectedFrameIndex] = { ...state.frameMetadata[state.selectedFrameIndex], name, tag, pivot, anchorPoints };
  state.anchorReference = Math.max(0, Math.round(Number($("#frameAnchorReference").value) || 1) - 1);
  pushHistory("Метаданные кадра изменены"); markPreviewDirty(); saveSessionSoon();
  setStatus("Имя, тег и опора сохранены в проекте · пересоберите просмотр для JSON", "done", 0);
});

$("#alignManualPoints").addEventListener("click", () => {
  if (!state.source) return;
  setAnchor("manual"); markPreviewDirty(); scheduleHistory("Выравнивание по ручным точкам");
  setStatus("Выравнивание по первой точке; две точки задают общий масштаб тела без растяжения. Подготовьте просмотр.", "ready", 0);
});


window.mergeAddedSpriteFiles = function (source) {
  if (!state.source) { setSource(source); return; }
  pushHistory("До добавления файлов");
  const old = captureHistoryState(), previous = state.source, history = state.history, historyIndex = state.historyIndex, projectPath = state.projectPath;
  const map = new Map(previous.paths.map((file, index) => [index, source.paths.indexOf(file)]));
  const remap = values => Object.fromEntries(Object.entries(values || {}).filter(([index]) => map.get(Number(index)) >= 0).map(([index, value]) => [map.get(Number(index)), value]));
  source.frameMetadata = remap(old.frameMetadata); source.importedMetadata = previous.importedMetadata; source.importedAnimations = previous.importedAnimations;
  setSource(source); applyControlState(old.controls);
  state.frameMetadata = remap(old.frameMetadata); state.frameOverrides = remap(old.frameOverrides); state.frameTransforms = remap(old.frameTransforms); state.preparedCleanup = remap(old.preparedCleanup);
  state.excludedFrames = new Set(old.excludedFrames.map(i => map.get(i)).filter(i => i >= 0));
  state.timeline = old.timeline?.map(entry => ({ ...entry, src: map.get(entry.src) })).filter(entry => entry.src >= 0) || null;
  state.anchorReference = Math.max(0, map.get(old.anchorReference) || 0);
  state.history = history; state.historyIndex = historyIndex; state.projectPath = projectPath;
  pushHistory("Файлы добавлены · метаданные сохранены"); markPreviewDirty(); saveSessionSoon();
};
