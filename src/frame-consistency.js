let frameSizeAnalysis = null;

function resetFrameConsistency() {
  frameSizeAnalysis = null;
  $("#frameSizeList").replaceChildren();
  $("#applyFrameSizes").classList.add("hidden");
}

function displayFrameSizeAnalysis(analysis) {
  const list = $("#frameSizeList");
  list.replaceChildren();
  analysis.frames.forEach((frame) => {
    const sourceIndex = frame.index;
    // frameBounds carries source indexes, while the thumbnail list follows build order.
    const position = state.result?.sourceFrameIndexes?.indexOf(sourceIndex) ?? -1;
    const row = document.createElement("div");
    row.className = "frame-size-row";
    const image = document.createElement("img");
    image.src = position >= 0 ? (state.result?.frameUrls?.[position] || "") : "";
    image.alt = `Кадр ${sourceIndex + 1}`;
    const description = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = `Кадр ${sourceIndex + 1} · ${frame.width}×${frame.height}`;
    const note = document.createElement("small");
    note.textContent = frame.confidence === "similar-silhouette" ? "похожий силуэт · предложен масштаб" : "другая поза · проверьте размер тела";
    description.append(title, note);
    const scale = document.createElement("input");
    scale.type = "number"; scale.min = "50"; scale.max = "150"; scale.step = "1";
    scale.value = String(Math.round(frame.proposedScale * 100));
    scale.dataset.frameIndex = String(sourceIndex);
    scale.setAttribute("aria-label", `Масштаб кадра ${sourceIndex + 1} в процентах`);
    const edit = document.createElement("button");
    edit.type = "button"; edit.textContent = "Править";
    edit.addEventListener("click", () => { selectFrame(sourceIndex); setTransformPanel(true); });
    row.append(image, description, scale, edit); list.append(row);
  });
  $("#applyFrameSizes").classList.remove("hidden");
}

$("#analyzeFrameSizes").addEventListener("click", async () => {
  if (!state.result?.frameBounds?.length || state.resultDirty) {
    setStatus("Сначала соберите актуальный предпросмотр анимации", "error", 0);
    return;
  }
  const button = $("#analyzeFrameSizes");
  button.disabled = true;
  setStatus("Сравниваю размер кадров…", "busy", 0.2);
  try {
    // Bounds and transforms come from the finished build, so nothing is re-keyed.
    const referenceIndex = Number($("#consistencyReference").value) - 1;
    if (!Number.isInteger(referenceIndex) || referenceIndex < 0) throw new Error("Укажите номер опорного кадра.");
    frameSizeAnalysis = await window.spriteLab.analyzeFrames({ measurements: state.result.frameBounds, transforms: state.frameTransforms, referenceIndex });
    displayFrameSizeAnalysis(frameSizeAnalysis);
    setStatus(`Проверено кадров: ${frameSizeAnalysis.frames.length}. Разные позы оставлены для ручной проверки.`, "done", 1);
  } catch (error) {
    setStatus(error.message || "Не удалось сравнить кадры", "error", 0);
    showError(error.message || "Не удалось сравнить кадры.");
  } finally { button.disabled = false; }
});

$("#applyFrameSizes").addEventListener("click", () => {
  if (!frameSizeAnalysis || !state.result) return;
  let changed = 0;
  for (const input of $$("#frameSizeList input[data-frame-index]")) {
    const percent = Number(input.value);
    if (!Number.isFinite(percent) || percent < 50 || percent > 150) { input.focus(); return; }
    if (Math.abs(percent - 100) < 1) continue;
    const sourceIndex = Number(input.dataset.frameIndex);
    const current = state.frameTransforms[sourceIndex] || state.frameTransforms["*"] || { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0, skewX: 0, fill: null };
    const scale = percent / 100;
    state.frameTransforms[sourceIndex] = { ...current, scaleX: Math.max(0.25, Math.min(2.5, current.scaleX * scale)), scaleY: Math.max(0.25, Math.min(2.5, current.scaleY * scale)), fill: null };
    changed += 1;
  }
  if (!changed) { setStatus("Масштаб оставлен без изменений", "done", 0); return; }
  setAnchor($("#consistencyAnchor").value);
  frameSizeAnalysis = null;
  $("#applyFrameSizes").classList.add("hidden");
  markPreviewDirty(); scheduleFramePreview(0); pushHistory(`Масштаб исправлен: ${changed} кадр.`); saveSessionSoon();
  setStatus(`Исправлено кадров: ${changed}. Соберите предпросмотр, чтобы проверить анимацию.`, "done", 0);
});
