// Auto mode and the model window.
//
// The plan itself is computed in the main process (src/auto-pilot.mjs) from measurements taken off the
// real frames. This file only asks for it, shows each step with the reason it was chosen, and applies
// the parts that map onto the existing controls. Nothing here decides anything on its own.

const autoPilotState = {
  plan: null,
  status: null,
  progress: new Map(),
  open: false,
};

const autoPilotStatusLabels = {
  ready: "готово",
  staged: "этап позже",
  blocked: "нужна модель",
};

function autoPilotBadge(status) {
  const badge = document.createElement("span");
  badge.className = `auto-step-status ${status}`;
  badge.textContent = autoPilotStatusLabels[status] || status;
  return badge;
}

function autoPilotSetSummary(text, kind = "idle") {
  const summary = $("#autoPilotSummary");
  summary.className = `auto-pilot-summary ${kind}`;
  summary.textContent = text;
}

function autoPilotSourcePaths() {
  const fromResult = state.result?.allSourceFramePaths || [];
  if (fromResult.length) return fromResult;
  const source = state.source || {};
  if ((source.kind === "video" || source.kind === "video-batch") && source.samplePaths?.length) return source.samplePaths;
  const raw = Array.isArray(source.frames) ? source.frames : source.paths || [];
  return raw.filter((item) => typeof item === "string");
}

function autoPilotTarget() {
  return {
    intent: state.intent, cleanupRequested: state.intent === "images",
    cellWidth: state.intent === "images" ? 0 : Number($("#cellWidth").value) || 0,
    cellHeight: Number($("#cellHeight").value) || 0,
    atlasMaxSize: Number($("#atlasMaxSize").value) || 0,
    pixelArt: $("#pixelateEnabled").checked,
    attachments: state.attachments?.filter((attachment) => attachment.enabled !== false).length || 0,
    depthRequested: $("#auxDepth").checked,
    inpaintMaskPath: state.auxMaskPath || null,
  };
}

function autoPilotRenderSteps(plan) {
  const list = $("#autoPilotPlan");
  list.replaceChildren();
  for (const step of plan.steps || []) {
    const item = document.createElement("li");
    item.className = `auto-step ${step.status}`;
    const head = document.createElement("div");
    head.className = "auto-step-head";
    const title = document.createElement("strong");
    title.textContent = step.title;
    head.append(title, autoPilotBadge(step.status));
    const why = document.createElement("p");
    why.textContent = step.why;
    item.append(head, why);
    if (step.bytes) {
      const size = document.createElement("small");
      size.className = "auto-step-size";
      size.textContent = `Модель: ${modelLabel(step.modelId)}`;
      item.append(size);
    }
    list.append(item);
  }
}

function modelLabel(id) {
  const entry = autoPilotState.status?.entries?.find((model) => model.id === id);
  return entry ? entry.name : id;
}

function autoPilotRenderNeeded(plan) {
  const box = $("#autoPilotNeeded");
  box.replaceChildren();
  const needed = plan.needed || [];
  if (!needed.length) return;
  const header = document.createElement("p");
  header.className = "auto-needed-head";
  header.textContent = needed.some((entry) => entry.required)
    ? "Для части шагов нужны модели:"
    : "Точнее сработают эти модели:";
  box.append(header);
  for (const entry of needed) {
    const card = document.createElement("div");
    card.className = `auto-needed-card${entry.required ? " required" : ""}`;
    const text = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = entry.name;
    const why = document.createElement("small");
    why.textContent = `${entry.why} · ${entry.licences}${entry.bytes ? ` · ${formatModelSize(entry.bytes)}` : ""}`;
    text.append(name, why);
    card.append(text);
    if (entry.canDownload) {
      const download = document.createElement("button");
      download.type = "button";
      download.className = "button secondary";
      download.textContent = "Скачать";
      download.addEventListener("click", () => { void autoPilotDownload(entry.id, download); });
      card.append(download);
    } else if (entry.page) {
      const page = document.createElement("button");
      page.type = "button";
      page.className = "button secondary";
      page.textContent = "Страница проекта";
      page.addEventListener("click", () => { void window.spriteLab.openModelPage({ id: entry.id }); });
      card.append(page);
    }
    const more = document.createElement("button");
    more.type = "button";
    more.className = "button ghost";
    more.textContent = "Все модели";
    more.addEventListener("click", () => { void autoPilotOpenModels(); });
    card.append(more);
    box.append(card);
  }
}

function formatModelSize(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} ГБ`;
  if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} МБ`;
  if (value >= 1024) return `${Math.round(value / 1024)} КБ`;
  return `${value} Б`;
}

async function autoPilotRun() {
  const paths = autoPilotSourcePaths();
  if (!paths.length) {
    autoPilotSetSummary("Сначала добавьте источник: без кадров измерять нечего.", "error");
    return null;
  }
  $("#runAutoPilot").disabled = true;
  autoPilotSetSummary("Измеряю кадры…", "busy");
  try {
    const source = state.source || {};
    const plan = await window.spriteLab.planAutoPilot({
      paths,
      target: autoPilotTarget(),
      source: { kind: source.kind || "images", frameCount: state.result?.allSourceFramePaths?.length || source.estimatedFrames || source.frameCount || paths.length },
    });
    autoPilotState.plan = plan;
    autoPilotRenderSteps(plan);
    autoPilotRenderNeeded(plan);
    $("#applyAutoPilot").disabled = !plan.steps?.length;
    const sampled = plan.measurements?.sampled || 0;
    autoPilotSetSummary(`${plan.summary} Проверено кадров: ${sampled}.`, "done");
    for (const note of plan.notes || []) {
      const line = document.createElement("p");
      line.className = "auto-pilot-note";
      line.textContent = note;
      $("#autoPilotNeeded").append(line);
    }
    return plan;
  } catch (error) {
    autoPilotSetSummary(error?.message || "Не удалось построить план", "error");
    return null;
  } finally {
    $("#runAutoPilot").disabled = false;
  }
}

// Applying the plan only touches settings that exist in the interface; everything else the pipeline
// already does by itself (tracking attachments, slicing, splitting pages, checking the atlas).
function autoPilotApply() {
  const plan = autoPilotState.plan;
  if (!plan) return;
  const applied = [];
  for (const id of ["auxRife", "auxEsrgan", "auxDepth"]) $("#" + id).checked = false;
  for (const step of plan.steps || []) {
    if (step.stage === "key") {
      setKeyMode(step.tool === "alpha" ? "alpha" : "auto");
      applied.push(step.tool === "alpha" ? "сохранена прозрачность исходника" : "фон однотонный — оставлен точный контур");
    } else if (step.stage === "matting") {
      if (step.status !== "ready") continue;
      setKeyMode("ai");
      if (plan.settings?.quality) $("#aiQuality").value = plan.settings.quality;
      if (plan.settings?.provider) $("#aiProvider").value = plan.settings.provider;
      if (step.modelId && $(`#aiModel option[value="${step.modelId}"]`)) $("#aiModel").value = step.modelId;
      applied.push(`выделение моделью ${modelLabel(step.modelId)}`);
    } else if (step.stage === "checker") {
      state.maskEdits.push({ type: "checker", frameIndex: state.selectedFrameIndex, applyAll: false, strokeId: ++state.maskStrokeId });
      applied.push("удаление запечённых шахмат");
    } else if (step.stage === "fringe") {
      $("#edgeDecontaminate").checked = true;
      $("#edgeDecontaminate").dispatchEvent(new Event("change"));
      applied.push("снятие ореола с края");
    } else if (step.stage === "pixelate" && step.settings) {
      $("#pixelateEnabled").checked = true;
      $("#pixelateSize").value = String(step.settings.size);
      $("#pixelateColors").value = String(step.settings.colors);
      $("#pixelateMode").value = step.settings.mode;
      $("#pixelateDither").value = step.settings.dither;
      $("#pixelatePalette").value = step.settings.palette;
      for (const id of ["pixelateEnabled", "pixelateSize", "pixelateColors", "pixelateMode", "pixelateDither", "pixelatePalette"]) {
        $(`#${id}`).dispatchEvent(new Event("change"));
      }
      applied.push(`пиксель-арт ${step.settings.size} px, ${step.settings.colors} цветов`);
    } else if (step.stage === "upscale" || step.stage === "interpolate" || step.stage === "depth" || step.stage === "inpaint") {
      const control = { upscale: "auxEsrgan", interpolate: "auxRife", depth: "auxDepth" }[step.stage];
      if (control) {
        $("#" + control).checked = step.status === "ready";
        $("#" + control).dispatchEvent(new Event("change"));
      }
      if (step.status === "ready") applied.push(step.title.toLowerCase());
    }
  }
  savePreferences();
  const blocked = (plan.steps || []).filter((step) => step.status === "blocked");
  autoPilotSetSummary(blocked.length
    ? `Применено доступное: ${applied.join("; ") || "встроенные этапы"}. Не включены ${blocked.map((step) => step.title).join(", ")}: установите модели.`
    : applied.length
      ? `Применено: ${applied.join("; ")}. Проверка атласа пройдёт при сборке.`
      : "В плане нет дополнительных настроек: конвейер выполнит встроенные этапы при сборке.", blocked.length ? "error" : "done");
  setStatus("План авто-режима применён · проверьте предпросмотр", "done", 0);
  if (typeof scheduleFramePreview === "function") scheduleFramePreview(120);
}

/* ------------------------------------------------------------------ models window */

function autoPilotRenderModels() {
  const status = autoPilotState.status;
  const list = $("#modelsList");
  list.replaceChildren();
  if (!status) {
    const loading = document.createElement("p");
    loading.className = "models-lead";
    loading.textContent = "Читаю список…";
    list.append(loading);
    return;
  }
  $("#modelsDirectory").textContent = status.directory;
  $("#modelsDirectory").title = status.directory;
  for (const entry of status.entries) {
    const row = document.createElement("article");
    row.className = `model-row${entry.installed ? " installed" : ""}`;

    const head = document.createElement("div");
    head.className = "model-head";
    const name = document.createElement("strong");
    name.textContent = entry.name;
    const licence = document.createElement("span");
    licence.className = "model-licence";
    licence.textContent = `${entry.licence.name}${entry.licence.commercial ? " · коммерческое использование разрешено" : " · только некоммерческое"}`;
    head.append(name, licence);

    const meta = document.createElement("small");
    meta.className = "model-meta";
    const parts = [
      entry.tasks.join(" · "),
      entry.sizeBytes ? formatModelSize(entry.totalBytes) : "размер не заявлен",
      entry.bundled ? "в комплекте" : entry.url ? "скачивается" : "только вручную",
    ];
    meta.textContent = parts.join(" · ");

    const note = document.createElement("p");
    note.className = "model-note";
    note.textContent = entry.note;

    const stateLine = document.createElement("div");
    stateLine.className = "model-state";
    const statuses = [];
    const origin = entry.files.find((file) => file.present)?.origin || null;
    if (origin === "bundled") statuses.push("есть в комплекте");
    else if (origin === "downloaded") statuses.push("файл скачан");
    else statuses.push("файл не установлен");
    if (entry.validation) statuses.push(`проверена запуском: вход ${entry.validation.inputSize}×${entry.validation.inputSize}, ${entry.validation.ms} мс`);
    else if (entry.installed) statuses.push("на этом компьютере запуск ещё не проверялся");
    const verified = entry.files.filter((file) => file.verification?.level === "published").length;
    if (verified) statuses.push(`контрольная сумма опубликована (${verified})`);
    else if (entry.installed) statuses.push(entry.bundled ? "контрольная сумма в манифесте комплекта" : "сумма записана при загрузке");
    stateLine.textContent = statuses.join(" · ");

    const actions = document.createElement("div");
    actions.className = "model-actions";
    const progress = autoPilotState.progress.get(entry.id);
    if (progress != null) {
      const bar = document.createElement("progress");
      bar.max = 1;
      bar.value = progress;
      bar.className = "model-progress";
      actions.append(bar);
    } else if (entry.installed) {
      const validate = document.createElement("button");
      validate.type = "button";
      validate.className = "button secondary";
      validate.textContent = "Проверить запуском";
      validate.addEventListener("click", () => { void autoPilotValidate(entry.id, validate); });
      actions.append(validate);
      if (!entry.bundled) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "button ghost";
        remove.textContent = "Удалить";
        remove.addEventListener("click", async () => {
          await window.spriteLab.removeModel({ id: entry.id });
          await autoPilotRefreshModels();
        });
        actions.append(remove);
      }
    } else if (entry.readiness !== "ready") {
      const later = document.createElement("small");
      later.textContent = "Этап в разработке. Загрузка модели сейчас не нужна.";
      actions.append(later);
    } else if (entry.bundled) {
      const missing = document.createElement("small");
      missing.textContent = "Файл комплекта отсутствует. Скопируйте папку portable полностью.";
      actions.append(missing);
    } else if (entry.url) {
      const download = document.createElement("button");
      download.type = "button";
      download.className = "button secondary";
      download.textContent = "Скачать";
      download.addEventListener("click", () => { void autoPilotDownload(entry.id, download); });
      actions.append(download);
    } else if (entry.page) {
      const page = document.createElement("button");
      page.type = "button";
      page.className = "button secondary";
      page.textContent = "Страница проекта";
      page.addEventListener("click", () => { void window.spriteLab.openModelPage({ id: entry.id }); });
      actions.append(page);
      const hint = document.createElement("small");
      hint.className = "model-hint";
      hint.textContent = `Положите ${entry.file} в папку моделей — программа подхватит файл.`;
      actions.append(hint);
    }

    row.append(head, meta, note, stateLine, actions);
    list.append(row);
  }

  const rejected = $("#modelsRejected");
  rejected.replaceChildren();
  for (const model of status.rejected || []) {
    const line = document.createElement("p");
    const name = document.createElement("strong");
    name.textContent = `${model.name}: `;
    line.append(name, document.createTextNode(model.reason));
    rejected.append(line);
  }
}

async function autoPilotRefreshModels() {
  autoPilotState.status = await window.spriteLab.modelsStatus();
  autoPilotRenderModels();
  autoPilotFillModelSelect();
  return autoPilotState.status;
}

// The select only offers models that are on disk: a chosen model that is not there would silently fall
// back to the bundled one, which is more confusing than not offering it.
function autoPilotFillModelSelect() {
  const select = $("#aiModel");
  if (!select || !autoPilotState.status) return;
  const keep = select.value;
  select.replaceChildren();
  for (const entry of autoPilotState.status.entries) {
    if (!entry.installed || !entry.tasks.includes("matting") || entry.readiness !== "ready") continue;
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = `${entry.name}${entry.bundled ? " — в комплекте" : ""}`;
    option.selected = entry.id === keep;
    select.append(option);
  }
  if (!select.options.length) {
    const option = document.createElement("option");
    option.value = "u2netp";
    option.textContent = "U²-Net small — в комплекте";
    select.append(option);
  }
  if ([...select.options].some((option) => option.value === keep)) select.value = keep;
}

async function autoPilotDownload(id, button) {
  if (button) button.disabled = true;
  autoPilotState.progress.set(id, 0);
  autoPilotRenderModels();
  try {
    await window.spriteLab.downloadModel({ id });
    autoPilotState.progress.delete(id);
    await autoPilotRefreshModels();
    setStatus(`${modelLabel(id)} скачана и проверена по размеру`, "done", 0);
  } catch (error) {
    autoPilotState.progress.delete(id);
    autoPilotRenderModels();
    setStatus(error?.message || "Не удалось скачать модель", "error", 0);
    showError(error?.message || "Не удалось скачать модель");
  }
}

async function autoPilotValidate(id, button) {
  if (button) { button.disabled = true; button.textContent = "Проверяю…"; }
  try {
    const report = await window.spriteLab.validateModel({ id });
    await autoPilotRefreshModels();
    setStatus(`${modelLabel(id)} проверена запуском: вход ${report.inputSize}×${report.inputSize}, ${report.ms} мс`, "done", 0);
  } catch (error) {
    await autoPilotRefreshModels();
    setStatus(error?.message || "Модель не запустилась", "error", 0);
    showError(error?.message || "Модель не запустилась");
  }
}

async function autoPilotOpenModels() {
  autoPilotState.open = true;
  setModalOpen($("#modelsModal"), true, $("#closeModels"), $("#openModels"));
  await autoPilotRefreshModels();
}

function autoPilotCloseModels() {
  autoPilotState.open = false;
  setModalOpen($("#modelsModal"), false, null, $("#openModels"));
}

/* ------------------------------------------------------------------ wiring */

$("#runAutoPilot").addEventListener("click", () => { void autoPilotRun(); });
$("#applyAutoPilot").addEventListener("click", autoPilotApply);
$("#openModels").addEventListener("click", () => { void autoPilotOpenModels(); });
for (const id of ["auxRife", "auxEsrgan", "auxDepth"]) {
  $("#" + id).addEventListener("change", () => { markPreviewDirty(); savePreferences(); });
}
$("#chooseLamaMask").addEventListener("click", async () => {
  try {
    const mask = await window.spriteLab.chooseAIMask();
    if (!mask) return;
    state.auxMaskPath = mask.path;
    $("#lamaMaskName").textContent = `Маска: ${mask.name}`;
    $("#clearLamaMask").classList.remove("hidden");
    markPreviewDirty();
  } catch (error) { showError(error?.message || "Не удалось открыть PNG-маску."); }
});
$("#clearLamaMask").addEventListener("click", () => {
  state.auxMaskPath = null;
  $("#lamaMaskName").textContent = "Маска не выбрана";
  $("#clearLamaMask").classList.add("hidden");
  markPreviewDirty();
});
$("#closeModels").addEventListener("click", autoPilotCloseModels);
$("#modelsModal").addEventListener("click", (event) => { if (event.target === $("#modelsModal")) autoPilotCloseModels(); });
$("#openModelsFolder").addEventListener("click", async () => {
  try {
    const answer = await window.spriteLab.openModelsFolder();
    setStatus(`Папка моделей открыта: ${answer.directory}`, "done", 0);
  } catch (error) {
    setStatus(error?.message || "Не удалось открыть папку моделей", "error", 0);
  }
});

window.spriteLab.onModelsProgress((progress) => {
  if (!progress?.id) return;
  autoPilotState.progress.set(progress.id, progress.value || 0);
  if (autoPilotState.open) autoPilotRenderModels();
  setStatus(`Скачивание ${modelLabel(progress.id)}: ${Math.round((progress.value || 0) * 100)}%`, "busy", progress.value || 0);
  if (progress.value >= 1) autoPilotState.progress.delete(progress.id);
});

// The model list is read once at start so the select is filled before the first build.
void autoPilotRefreshModels().catch(() => { /* The list is optional until the window is opened. */ });
