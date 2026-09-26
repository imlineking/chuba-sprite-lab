// Independent images keep their original canvas. No slicing, rescaling or timeline.
window.startImageEditing = function startImageEditing() {
  if (state.source?.kind !== "frames") return false;
  state.intent = "images"; document.body.dataset.intent = "images";
  $("#sourceBadge").textContent = "PNG";
  $("#sourceTitle").textContent = state.source.title.replace(/кадров/g, "изображений");
  // Do not carry an animation's resize/style settings into a plain cleanup task.
  if (state.result?.imageWorkspace) return true;
  const paths = state.source.paths;
  const urls = paths.map(file => "file:///" + file.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/"));
  state.result = { imageWorkspace: true, frameCount: paths.length, allSourceFramePaths: [...paths], allSourceFrameUrls: urls, sourceFrameIndexes: paths.map((_, i) => i), frameUrls: urls, copyableFrameIndexes: [], skipped: {}, warnings: [], frameIssues: [], atlasIssues: [] };
  state.timeline = null;
  state.warnings = []; showWarnings([], []);
  buildFilmstrip(state.result);
  $$("#filmstrip button").forEach((button, index) => { button.draggable = false; button.title = baseName(paths[index]); });
  $("#filmstripNote").textContent = `${paths.length} отдельных изображений · выберите файл для правки`;
  $("#metaFrames").textContent = String(paths.length);
  $("#metaCell").textContent = "Исходный размер"; $("#metaGrid").textContent = "—";
  $("#metaAnchor").textContent = "Без смещения"; $("#metaAtlas").textContent = "Отдельные PNG";
  state.selectedFrameIndex = Math.min(state.selectedFrameIndex, paths.length - 1);
  setPreviewMode("after"); updateActionState();
  scheduleFramePreview(0);
  return true;
};

window.saveIndependentImages = async function saveIndependentImages({ all = false, automatic = false } = {}) {
  if (state.source?.kind !== "frames" || state.busy) return null;
  const sourceIndexes = all ? state.source.paths.map((_, i) => i) : [state.selectedFrameIndex];
  const paths = sourceIndexes.map(i => state.source.paths[i]);
  if (automatic) { clearTimeout(state.historyTimer); pushHistory("Перед автоочисткой изображений"); }
  state.busy = true; updateActionState();
  try {
    const outputDir = state.outputFolder || await window.spriteLab.automaticOutput(paths[0]);
    state.outputFolder = outputDir; $("#outputFolder").textContent = outputDir;
    $("#cancelJob").classList.remove("hidden");
    setStatus(`Сохраняю ${paths.length} PNG в исходном размере…`, "busy", .02);
    const result = await window.spriteLab.imageBatch({ paths, sourceIndexes, outputDir, outputKind: "images", automatic, options: collectOptions() });
    state.lastExportDir = outputDir; state.lastRevealPath = result.revealPath;
    if (result.failed) showError(result.failures.map(item => `${item.name}: ${item.message}`).join("\n"));
    else hideError();
    setStatus(`Сохранено PNG: ${result.completed}/${result.total}${result.cancelled ? " · отменено" : ""}${result.failed ? ` · ошибок: ${result.failed}` : ""}`, result.failed ? "error" : "done", 1);
    for (const item of result.results) {
      const index = state.source.paths.indexOf(item.input);
      if (index >= 0) $("#filmstrip button[data-source-index='" + index + "'] img").src = "file:///" + item.imagePath.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/");
      if (index >= 0 && automatic && all && !result.failed && !result.cancelled) state.frameOverrides[index] = item.imagePath;
    }
    if (automatic && all && result.completed && !result.failed && !result.cancelled) {
      // The saved PNG already contains these operations. Consume them so a
      // subsequent preview/export does not tone, transform or erode it twice.
      state.maskEdits = []; state.frameTransforms = {}; state.attachments = [];
      for (const id of ["pixelateEnabled", "toningEnabled", "fringeCleanup", "edgeDecontaminate"]) $("#" + id).checked = false;
      $("#edgeRefineMode").value = "none";
      setKeyMode("alpha"); updateMaskEditSummary(); renderAttachmentList(); pushHistory("Автоочистка изображений");
      const models = [...new Set(result.results.map(item => item.fallback?.model || item.plan?.steps.find(step => step.stage === "matting")?.modelId).filter(Boolean))];
      $("#filmstripNote").title = `Автоочистка: ${models.length ? models.join(", ") : "контур / альфа / проверка шахмат"}. Решения по файлам: ${result.reportPath}`;
    }
    return result;
  } catch (error) { showError(error.message); setStatus(error.message, "error", 0); return null; }
  finally { state.busy = false; updateActionState(); $("#cancelJob").classList.add("hidden"); scheduleFramePreview(0); }
};

$("#regionEditImage").addEventListener("click", () => openMaskEditor({ tool: "select" }).catch(error => showError(error.message)));
$("#saveImagePng").addEventListener("click", () => window.saveIndependentImages());
$("#saveAllImagePng").addEventListener("click", () => window.saveIndependentImages({ all: true }));
$("#imageAutoCleanup").addEventListener("click", () => window.saveIndependentImages({ all: true, automatic: true }));
$("#imageScenarioChoices").addEventListener("click", event => {
  const button = event.target.closest("button[data-image-task]");
  if (button) window.taskChoose(button.dataset.imageTask, "manual");
});
// History belongs beside Apply/Cancel and must stay visible when tools scroll.
const maskHistoryButtons = $(".mask-history-actions");
$(".mask-editor-footer").insertBefore(maskHistoryButtons, $(".mask-editor-footer").firstChild);
const checkerButton = $("#removeCheckerboard");
$(".mask-tools").insertBefore(checkerButton, $(".mask-tools").firstChild);
