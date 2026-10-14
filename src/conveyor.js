/* "Конвейер", "Быстрый режим", "Очередь и наблюдение": the default window. The legacy
   three-step workspace stays reachable under "Дополнительно". Tools shown depend on the
   detected input type (capability map in capabilities.mjs, decided in the main process). */
(() => {
  const api = window.spriteLab?.conveyor;
  if (!api) return;
  const q = (s) => document.querySelector(s);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const stageLabels = [["cut", "Нарезка", "Кадры из видео, листа или анимации"], ["clean", "Очистка фона", "Фон, края, ИИ-маска по пресету"], ["pack", "Упаковка", "Атлас MaxRects с отступами"], ["check", "Проверка", "Алгоритмы и встроенная модель"], ["export", "Экспорт", "Файлы для движка и отчёт"]];
  const statusText = { pending: "Ожидает", running: "Выполняется", done: "Готово", skipped: "Пропуск", failed: "Ошибка" };
  const toolTab = { cut: "source", clean: "process", style: "process", edit: "process", pack: "export", export: "export", check: "export", main: "source" };
  const ui = { paths: [], detection: null, caps: null, presets: [], output: "near", outputDir: null, busy: false };

  function setView(view) {
    document.body.dataset.view = view;
    document.querySelectorAll("#viewSwitch button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === view)));
    document.querySelectorAll(".cv-view").forEach((v) => v.classList.toggle("hidden", v.dataset.cv !== view));
  }
  document.querySelectorAll("#viewSwitch button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));

  function renderStages(stages) {
    const list = q("#cvStages"); list.replaceChildren();
    stageLabels.forEach(([id, label, hint], i) => {
      const s = stages?.find((x) => x.id === id) || { status: "pending" };
      const li = el("li", "cv-stage"); li.dataset.status = s.status; li.dataset.stage = id;
      const body = el("div"); body.append(el("strong", null, label), el("small", null, s.detail || hint));
      li.append(el("span", "cv-stage-num", String(i + 1)), body, el("span", "cv-stage-status", statusText[s.status] || s.status));
      list.append(li);
    });
  }

  function stagesFromCaps(caps, preset) {
    return stageLabels.map(([id]) => {
      const st = caps?.stages.find((s) => s.id === id);
      if (!caps) return { id, status: "pending" };
      if (!caps.supported) return { id, status: "skipped", detail: "Тип не поддерживается" };
      if (!st?.applies) return { id, status: "skipped", detail: "Не нужен для этого типа" };
      if (id === "check" && preset && !preset.review) return { id, status: "skipped", detail: "Выключено в пресете" };
      return { id, status: "pending" };
    });
  }
  const currentPreset = () => ui.presets.find((p) => p.id === q("#cvPreset").value) || ui.presets[0];

  function renderPresetInfo() {
    const p = currentPreset(); const box = q("#cvPresetInfo"); box.replaceChildren();
    if (!p) return;
    const rows = [["Фон", { auto: "Автоматически", none: "Не трогать", ai: "ИИ-маска" }[p.background] || p.background], ["Края", p.edgeCleanup ? "Очищать" : "Как есть"], ["Пиксель-арт", p.pixelArt ? "Да" : "Нет"], ["Форматы", p.atlas.formats.join(", ")], ["Отступ / экструзия", `${p.atlas.padding} / ${p.atlas.extrude} px`], ["Макс. размер", `${p.atlas.maxSize} px${p.atlas.powerOfTwo ? ", степень двойки" : ""}`], ["Проверка", p.review ? (p.useModel ? "Алгоритмы и модель" : "Только алгоритмы") : "Выключена"]];
    for (const [k, v] of rows) box.append(el("span", null, k), el("b", null, v));
    if (ui.caps) renderStages(stagesFromCaps(ui.caps, p));
  }

  async function loadPresets() {
    ui.presets = await api.presets();
    for (const sel of [q("#cvPreset"), q("#cvWatchPreset")]) {
      const keep = sel.value; sel.replaceChildren();
      for (const p of ui.presets.filter((x) => x.id !== "quick")) { const o = el("option", null, p.label); o.value = p.id; sel.append(o); }
      if (keep) sel.value = keep;
    }
    renderPresetInfo();
  }

  function openInAdvanced(tool) {
    if (!ui.paths.length) return;
    api.openInAdvanced(ui.paths).then((source) => {
      if (source && typeof setSource === "function") setSource(source);
      setView("advanced");
      if (typeof setTab === "function") setTab(toolTab[tool.group] || "source");
      if (tool.id === "review" && typeof window.openReviewPanel === "function") window.openReviewPanel();
    }).catch((error) => showMessage(error.message));
  }

  function showMessage(text) { const r = q("#cvResult"); r.classList.remove("hidden"); r.replaceChildren(el("strong", null, "Не получилось"), el("span", null, text)); }

  function renderDetection(result) {
    const { detection, capabilities: caps } = result; ui.detection = detection; ui.caps = caps;
    q("#cvTypeCard").classList.remove("hidden");
    q("#cvTypeLabel").textContent = caps.label;
    q("#cvTypeFormat").textContent = detection.format === "folder" ? `${detection.files.length} кадров` : String(detection.format || "").toUpperCase();
    q("#cvTypeName").textContent = detection.paths.length > 1 ? `${detection.paths.length} элементов` : detection.paths[0];
    const warnings = q("#cvWarnings"); warnings.replaceChildren();
    for (const w of detection.warnings || []) warnings.append(el("li", null, w));
    if (detection.facts?.reason) warnings.append(el("li", null, `Похоже на спрайт-лист: ${detection.facts.reason}.`));
    q("#cvUnsupported").classList.toggle("hidden", caps.supported);
    q("#cvUnsupported").textContent = caps.message || "";
    const groups = q("#cvToolGroups"); groups.replaceChildren();
    for (const g of caps.groups) {
      if (g.id === "main") continue;
      const box = el("div", "cv-tool-group"); box.append(el("span", null, g.label));
      const list = el("div", "cv-tool-list");
      for (const t of g.tools) { const b = el("button", "cv-tool", t.label); b.type = "button"; b.dataset.tool = t.id; b.addEventListener("click", () => openInAdvanced(t)); list.append(b); }
      box.append(list); groups.append(box);
    }
    q("#cvToolsCard").classList.toggle("hidden", !caps.supported || !groups.children.length);
    const runnable = caps.supported && caps.stages.some((s) => s.applies);
    q("#cvRunAll").disabled = !runnable || ui.busy; q("#cvEnqueue").disabled = !runnable || ui.busy;
    q("#cvResult").classList.add("hidden");
    renderStages(stagesFromCaps(caps, currentPreset()));
    updateOutputHint();
  }

  function updateOutputHint() {
    const near = ui.output === "near";
    const first = ui.detection?.paths?.[0];
    if (near) {
      if (first) api.quickTarget(first).then((t) => { q("#cvOutputPath").textContent = t; });
      else q("#cvOutputPath").textContent = "Папка «имя-spritelab» рядом с исходником";
    } else q("#cvOutputPath").textContent = ui.outputDir || "Папка не выбрана";
  }

  async function detect(paths) {
    if (!paths?.length) return;
    ui.paths = paths;
    try { renderDetection(await api.detect(paths)); } catch (error) { showMessage(error.message); }
  }
  async function detectFiles(files) {
    try { const result = await api.detectDropped(files); ui.paths = result.detection.paths; renderDetection(result); } catch (error) { showMessage(error.message); }
  }

  function renderResult(result) {
    const r = q("#cvResult"); r.classList.remove("hidden"); r.replaceChildren();
    if (!result.ok) { r.append(el("strong", null, "Остановлено"), el("span", null, result.error || "Ошибка")); return; }
    r.append(el("strong", null, result.review ? `Готово. Проверка: ${result.review.verdictLabel || result.review.verdict}` : "Готово"));
    r.append(el("span", "cv-path", result.outputDir || ""));
    if (result.review?.issues?.length) r.append(el("span", null, `Замечаний: ${result.review.issues.length}. Подробности в review.json.`));
    const reveal = el("button", null, "Показать в папке"); reveal.type = "button"; reveal.addEventListener("click", () => window.spriteLab.revealOutput(result.outputDir)); r.append(reveal);
  }

  function setBusy(busy) {
    ui.busy = busy; q("#cvCancel").classList.toggle("hidden", !busy);
    q("#cvRunAll").disabled = busy || !ui.caps?.supported; q("#cvEnqueue").disabled = busy || !ui.caps?.supported;
    q("#cvRunAll").textContent = busy ? "Выполняется" : "Сделать всё";
  }

  q("#cvRunAll").addEventListener("click", async () => {
    if (!ui.paths.length) return;
    if (ui.output === "folder" && !ui.outputDir) { ui.outputDir = await api.pickOutput(); updateOutputHint(); if (!ui.outputDir) return; }
    setBusy(true);
    try { renderResult(await api.run({ paths: ui.paths, presetId: currentPreset()?.id, outputDir: ui.output === "folder" ? ui.outputDir : null })); }
    catch (error) { showMessage(error.message); } finally { setBusy(false); }
  });
  q("#cvEnqueue").addEventListener("click", async () => {
    if (!ui.paths.length) return;
    try { renderQueue(await api.queueAdd({ paths: ui.paths, presetId: currentPreset()?.id, outputDir: ui.output === "folder" ? ui.outputDir : null })); } catch (error) { showMessage(error.message); }
  });
  q("#cvCancel").addEventListener("click", () => api.cancel());
  q("#cvPreset").addEventListener("change", renderPresetInfo);
  document.querySelectorAll("#conveyorView .cv-segmented button").forEach((b) => b.addEventListener("click", async () => {
    ui.output = b.dataset.output;
    document.querySelectorAll("#conveyorView .cv-segmented button").forEach((x) => { x.classList.toggle("selected", x === b); x.setAttribute("aria-checked", String(x === b)); });
    if (ui.output === "folder" && !ui.outputDir) ui.outputDir = await api.pickOutput();
    updateOutputHint();
  }));
  q("#cvPickFile").addEventListener("click", async (e) => { e.stopPropagation(); detect(await api.pickInput(false)); });
  q("#cvPickFolder").addEventListener("click", async (e) => { e.stopPropagation(); detect(await api.pickInput(true)); });
  q("#cvDrop").addEventListener("click", async () => detect(await api.pickInput(false)));
  api.onProgress((p) => { if (p.stages && document.body.dataset.view === "conveyor") renderStages(p.stages); if (p.stages && document.body.dataset.view === "quick") renderQuickProgress(p.stages); });

  /* Quick mode */
  function renderQuickProgress(stages) {
    const box = q("#cvQuickStatus"); box.classList.remove("hidden");
    const running = stages.find((s) => s.status === "running");
    box.replaceChildren(el("strong", null, running ? `${running.label}` : "Обработка"), el("span", "cv-path", stages.filter((s) => s.status === "done").map((s) => s.label).join(" > ")));
  }
  async function quickRun(paths) {
    if (!paths?.length) return;
    const box = q("#cvQuickStatus"); box.classList.remove("hidden");
    if (paths.length > 1) { box.replaceChildren(el("strong", null, "Нужен один файл"), el("span", null, "Для нескольких файлов используйте «Конвейер» или очередь.")); return; }
    try {
      const { detection, capabilities } = await api.detect(paths);
      if (!capabilities.supported || !capabilities.tools.some((t) => t.id === "quick")) { box.replaceChildren(el("strong", null, capabilities.label), el("span", null, capabilities.message || "Для этого типа быстрый режим недоступен; откройте его в «Конвейере».")); return; }
      box.replaceChildren(el("strong", null, `${capabilities.label}: обработка`));
      const result = await api.run({ paths: detection.paths, quick: true, presetId: "quick", quickOptions: { background: q("#cvQuickBackground").checked, atlas: q("#cvQuickAtlas").checked } });
      box.replaceChildren();
      if (!result.ok) { box.append(el("strong", null, "Остановлено"), el("span", null, result.error)); return; }
      box.append(el("strong", null, "Готово"), el("span", "cv-path", result.outputDir));
      const reveal = el("button", null, "Показать в папке"); reveal.type = "button"; reveal.addEventListener("click", () => window.spriteLab.revealOutput(result.outputDir)); box.append(reveal);
    } catch (error) { box.replaceChildren(el("strong", null, "Не получилось"), el("span", null, error.message)); }
  }
  q("#cvQuickPick").addEventListener("click", async (e) => { e.stopPropagation(); quickRun(await api.pickInput(false)); });
  q("#cvQuickDrop").addEventListener("click", async () => quickRun(await api.pickInput(false)));

  /* Drag and drop for the conveyor views */
  for (const zone of [q("#cvDrop"), q("#cvQuickDrop")]) {
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("dragging"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("dragging"));
  }
  document.addEventListener("dragover", (e) => { if (document.body.dataset.view !== "advanced") e.preventDefault(); });
  document.addEventListener("drop", (e) => {
    const view = document.body.dataset.view;
    if (view === "advanced" || !e.dataTransfer?.files?.length) return;
    e.preventDefault();
    document.querySelectorAll(".cv-drop").forEach((z) => z.classList.remove("dragging"));
    if (view === "quick") api.detectDropped(e.dataTransfer.files).then((r) => quickRun(r.detection.paths)).catch((error) => showMessage(error.message));
    else { if (view === "queue") setView("conveyor"); detectFiles(e.dataTransfer.files); }
  });

  /* Queue and watch folder */
  const queueStatus = { pending: "Ожидает", running: "Выполняется", done: "Готово", failed: "Ошибка", cancelled: "Отменено" };
  function renderQueue(snap) {
    if (!snap) return;
    void renderSummary();
    const list = q("#cvQueueList"); list.replaceChildren();
    const active = snap.items.filter((i) => i.status === "pending" || i.status === "running").length;
    q("#cvQueueBadge").textContent = String(active); q("#cvQueueBadge").classList.toggle("hidden", !active);
    q("#cvQueuePause").classList.toggle("hidden", snap.paused); q("#cvQueueResume").classList.toggle("hidden", !snap.paused);
    if (!snap.items.length) { list.append(el("li", "cv-empty", "Очередь пуста. Перетащите файлы на экран «Конвейер» и нажмите «Добавить в очередь».")); return; }
    for (const item of snap.items) {
      const li = el("li"); li.dataset.status = item.status;
      const name = el("div", "cv-q-name", item.paths.map((p) => p.split(/[\\/]/).pop()).join(", "));
      name.append(el("small", null, `${item.origin === "watch" ? "Папка наблюдения · " : ""}${item.detail || ""}`));
      const action = el("button", null, item.status === "running" || item.status === "pending" ? "Отменить" : "Убрать"); action.type = "button";
      action.addEventListener("click", async () => renderQueue(item.status === "running" || item.status === "pending" ? await api.queueCancel(item.id) : await api.queueRemove(item.id)));
      li.append(name, el("span", "cv-stage-status", queueStatus[item.status] || item.status), action); list.append(li);
    }
  }
  async function renderSummary() {
    const s = await api.queueSummary();
    q("#cvQueueSummary").textContent = s.total ? `Всего ${s.total}: готово ${s.done}, ошибок ${s.failed}, отменено ${s.cancelled}, ждут ${s.pending}` : "";
  }
  function renderWatch(config) {
    q("#cvWatchState").textContent = config ? `${config.dir}  >  ${config.outputDir}` : "Не настроена";
    q("#cvWatchStop").classList.toggle("hidden", !config); q("#cvWatchPick").textContent = config ? "Сменить папку" : "Выбрать папку";
    if (config?.presetId) q("#cvWatchPreset").value = config.presetId;
  }
  q("#cvQueuePause").addEventListener("click", async () => renderQueue(await api.queuePause()));
  q("#cvQueueResume").addEventListener("click", async () => renderQueue(await api.queueResume()));
  q("#cvQueueClear").addEventListener("click", async () => renderQueue(await api.queueClear()));
  q("#cvWatchPick").addEventListener("click", async () => { try { renderWatch(await api.watchSet({ pick: true, presetId: q("#cvWatchPreset").value })); } catch (error) { q("#cvWatchState").textContent = error.message; } });
  q("#cvWatchStop").addEventListener("click", async () => renderWatch(await api.watchStop()));
  api.onQueue(renderQueue);

  renderStages(null);
  loadPresets().then(() => api.queue()).then(renderQueue).then(() => api.watchGet()).then(renderWatch).catch(() => {});
  window.conveyorUI = { setView, detect, renderDetection, renderQueue, renderStages, renderResult };
})();
