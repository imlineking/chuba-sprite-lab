// Shared colour and palette decisions for a single image or a selected batch.
// Decisions produce reviewed PNGs; they never write originals or apply a draft.
let batchPipetteActive = false;
function batchPaletteCandidates() {
  if (!imageBatchDraft) return [];
  return imageBatchIndexes().filter(index => imageBatchDraft.results[index]?.suggestNoLightArtwork
    && imageBatchDraft.cleanupChoices?.[index]?.lightArtworkPolicy !== "protect");
}
window.renderBatchCleanupSuggestion = function () {
  const indexes = batchPaletteCandidates();
  $("#imageBatchLightSuggestion").classList.toggle("hidden", !indexes.length);
  $("#imageBatchLightSuggestionText").textContent = `В ${indexes.length} файлах светлые участки могут быть остатками фона. Проверьте, есть ли белые или серые детали самого рисунка.`;
  $("#imageBatchConfirmNoLight").disabled = state.busy;
  $$(".batch-color-removal input, .batch-color-removal select, .batch-color-removal button").forEach(control => { control.disabled = state.busy; });
};
async function requestBatchCleanupConfirmation(indexes, message) {
  if (!imageBatchDraft || state.busy || !indexes.length) return false;
  const dialog = $("#imageBatchCleanupConfirm");
  if (dialog.open) return false;
  const signature = JSON.stringify(imageBatchDraft.paths);
  $("#imageBatchCleanupConfirmMessage").textContent = message;
  const list = $("#imageBatchCleanupConfirmFiles"); list.replaceChildren();
  for (const index of indexes) {
    const item = document.createElement("li"); item.textContent = baseName(imageBatchDraft.paths[index]); list.append(item);
  }
  dialog.returnValue = "";
  const closed = new Promise(resolve => dialog.addEventListener("close", () => resolve(dialog.returnValue === "accept"), { once: true }));
  dialog.showModal(); $("#imageBatchCleanupConfirmCancel").focus();
  return await closed && !state.busy && signature === JSON.stringify(imageBatchDraft?.paths);
}
window.confirmBatchNoLightArtwork = async function (indexes) {
  const targets = [...indexes];
  const confirmed = await requestBatchCleanupConfirmation(targets,
    `Белого и серого в этих рисунках нет — вы уверены? Уберём светлые остатки и перекрасим кромку цветами из глубины объекта. Белые лепестки, блики и пятна тоже могут исчезнуть. Файлов: ${targets.length}. Сначала подготовим просмотр.`);
  if (!confirmed) return;
  imageBatchDraft.cleanupChoices ||= {};
  for (const index of targets) imageBatchDraft.cleanupChoices[index] = { ...imageBatchDraft.cleanupChoices[index], lightArtworkPolicy: "none" };
  persistImageBatchDraft(); await prepareImageBatch("all", targets);
};
$("#imageBatchConfirmNoLight").addEventListener("click", () => window.confirmBatchNoLightArtwork(batchPaletteCandidates()));
$("#imageBatchRemovePickedColor").addEventListener("click", async () => {
  const targets = imageBatchIndexes(), hex = $("#imageBatchRemoveColor").value;
  const tolerance = Number($("#imageBatchColorTolerance").value), scope = $("#imageBatchColorScope").value;
  if (targets.some(index => (imageBatchDraft.cleanupChoices?.[index]?.colors?.length || 0) >= 16)) {
    $("#imageBatchPipetteHint").textContent = "В этом просмотре уже выбрано 16 цветов. Примените результат перед следующей очисткой."; return;
  }
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 255) { $("#imageBatchPipetteHint").textContent = "Допуск должен быть от 0 до 255."; return; }
  const confirmed = await requestBatchCleanupConfirmation(targets,
    `Удалить цвет ${hex.toUpperCase()} из ${targets.length} файлов — вы уверены? Допуск близких оттенков: ${tolerance}. ${scope === "all" ? "Цвет исчезнет во всём рисунке, включая детали объекта." : "Уберём только фон и просветы, связанные с прозрачностью; замкнутые детали останутся."} Сначала подготовим просмотр.`);
  if (!confirmed) return;
  const color = hex.match(/[\da-f]{2}/gi).map(value => parseInt(value, 16));
  imageBatchDraft.cleanupChoices ||= {};
  for (const index of targets) {
    const choice = imageBatchDraft.cleanupChoices[index] || {};
    const edit = { color, tolerance, scope }, colors = choice.colors || [];
    imageBatchDraft.cleanupChoices[index] = { ...choice, colors: colors.some(item => JSON.stringify(item) === JSON.stringify(edit)) ? colors : [...colors, edit] };
  }
  persistImageBatchDraft(); await prepareImageBatch("all", targets);
});
function setBatchPipette(active) {
  batchPipetteActive = active;
  $("#imageBatchColorPipette").setAttribute("aria-pressed", String(active));
  $("#imageBatchComparison").classList.toggle("picking-color", active);
  $("#imageBatchPipetteHint").textContent = active ? "Нажмите нужный пиксель на исходнике. Esc — отменить пипетку." : `Выбран цвет ${$("#imageBatchRemoveColor").value.toUpperCase()}.`;
}
$("#imageBatchColorPipette").addEventListener("click", () => setBatchPipette(!batchPipetteActive));
$("#imageBatchRemoveColor").addEventListener("input", () => setBatchPipette(false));
for (const selector of ["#imageBatchBefore", "#imageBatchBeforeGamePreview"]) $(selector).addEventListener("click", event => {
  if (!batchPipetteActive || state.busy) return;
  const image = $("#imageBatchBefore");
  if (!image.complete || !image.naturalWidth) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const scale = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
  const x = Math.floor((event.clientX - rect.left - (rect.width - image.naturalWidth * scale) / 2) / scale);
  const y = Math.floor((event.clientY - rect.top - (rect.height - image.naturalHeight * scale) / 2) / scale);
  if (x < 0 || y < 0 || x >= image.naturalWidth || y >= image.naturalHeight) return;
  const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true }); context.drawImage(image, 0, 0);
  const pixel = context.getImageData(x, y, 1, 1).data;
  if (!pixel[3]) { $("#imageBatchPipetteHint").textContent = "Это прозрачный пиксель. Выберите цветной пиксель исходника."; return; }
  $("#imageBatchRemoveColor").value = "#" + [...pixel].slice(0, 3).map(value => value.toString(16).padStart(2, "0")).join("");
  setBatchPipette(false);
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && batchPipetteActive) { event.preventDefault(); event.stopImmediatePropagation(); setBatchPipette(false); }
}, true);
$("#closeImageBatch").addEventListener("click", () => setBatchPipette(false));
