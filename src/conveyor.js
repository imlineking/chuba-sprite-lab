/* "Конвейер", "Быстрый режим", "Очередь и наблюдение": the default window. The legacy
   three-step workspace stays reachable under "Дополнительно". Tools shown depend on the
   detected input type (capability map in capabilities.mjs, decided in the main process). */
(() => {
  const api = window.spriteLab?.conveyor;
  if (!api) return;
  const q = (s) => document.querySelector(s);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const stageLabels = [["cut", "Нарезка", "Кадры из видео, листа или анимации"], ["clean", "Очистка фона", "Фон, края, ИИ-маска по пресету"], ["pack", "Упаковка", "Атлас MaxRects с отступами"], ["check", "Проверка", "Техническая проверка результата"], ["export", "Экспорт", "Готовые файлы и отчёт"]];
  const statusText = { pending: "Ожидает", running: "Выполняется", done: "Готово", skipped: "Пропуск", failed: "Ошибка" };
  const ui = { intent: null, paths: [], detection: null, caps: null, presets: [], output: "near", outputDir: null, busy: false, result: null, queue: null, watch: null, quick: null, lastView: "conveyor", previewMode: "source", previewVersion: 0, revision: 0, studioKey: null, studioSource: null };
  let workingTools, clock, playback = [], allFrames = [], marks = [], playerHandle = null;
  const workingReady = import("./conveyor-working.mjs").then(m => { workingTools = m; clock = new m.FrameClock(); });
  const busy = () => ui.busy || Boolean(ui.queue?.running);
  const needsIntent = () => ["image-set", "frames-folder"].includes(ui.caps?.type);
  const readyIntent = () => !needsIntent() || Boolean(ui.intent);
  const runLabel = () => ui.workingDirty ? "Применить правки и экспортировать" : ui.intent === "images" ? "Подготовить PNG" : ui.intent === "atlas" ? "Подготовить атлас" : ui.intent === "animation" ? "Подготовить анимацию" : ui.caps?.type === "image" ? "Подготовить PNG" : "Подготовить файл";

  // Views: "advanced" is the original studio (tabs 01–03); "conveyor" / "quick" / "queue"
  // are tabs A–C of the conveyor shell, which reuses the studio's own deck layout.
  function setView(view) {
    if (!["advanced", "conveyor", "quick", "queue"].includes(view)) return;
    if (view !== "advanced") syncWorking();
    if (view !== "conveyor") pausePlayback();
    document.body.dataset.view = view;
    const open = view !== "advanced";
    q("#openConveyor")?.setAttribute("aria-pressed", String(open));
    if (q("#openConveyor")) q("#openConveyor").textContent = open ? "Студия" : "Конвейер";
    document.querySelectorAll("#conveyorShell [data-cv-tab]").forEach((b) => { const on = b.dataset.cvTab === view; b.classList.toggle("active", on); b.setAttribute("aria-selected", String(on)); });
    document.querySelectorAll("#conveyorShell .cv-view").forEach((v) => v.classList.toggle("active", v.dataset.cv === view));
    document.querySelectorAll("#conveyorShell [data-cv-deck]").forEach((d) => d.classList.toggle("hidden", !d.dataset.cvDeck.split(" ").includes(view)));
    if (q("#cvDeckTitle")) q("#cvDeckTitle").textContent = view === "queue" ? "ОЧЕРЕДЬ" : "ПРЕДПРОСМОТР";
    if (open) ui.lastView = view;
    if (view === "conveyor" && ui.workingDirty) void renderPreview("result");
    emit();
  }
  document.querySelectorAll("#conveyorShell [data-cv-tab]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.cvTab)));
  q("#openConveyor")?.addEventListener("click", () => setView(document.body.dataset.view === "advanced" ? ui.lastView || "conveyor" : "advanced"));
  q("#cvBackToStudio")?.addEventListener("click", () => setView("advanced"));

  // The copilot (copilot.js) listens to this snapshot and turns it into hints and chips.
  function snapshot() {
    return { recovery: ui.recovery || null, workingDirty: Boolean(ui.workingDirty), intent: ui.intent, mode: document.body.dataset.view, detection: ui.detection, capabilities: ui.caps, preset: ui.presets.find((p) => p.id === q("#cvPreset")?.value) || ui.presets[0] || null, presets: ui.presets, result: ui.result, queue: ui.queue, watch: ui.watch, busy: busy(), quick: ui.quick };
  }
  function emit() { document.dispatchEvent(new CustomEvent("spriteLab:conveyor", { detail: snapshot() })); }

  function renderStages(stages) {
    const list = q("#cvStages"); list.replaceChildren();
    stageLabels.forEach(([id, label, hint], i) => {
      const s = stages?.find((x) => x.id === id) || { status: "pending" };
      if (s.status === "skipped") return;
      const li = el("li", "cv-stage"); li.dataset.status = s.status; li.dataset.stage = id;
      const body = el("div"); body.append(el("strong", null, label), el("small", null, s.detail || hint));
      li.append(el("span", "cv-stage-num", String(i + 1)), body, el("span", "cv-stage-status", statusText[s.status] || s.status));
      list.append(li);
    });
    const active = stages?.find((s) => s.status === "running" || s.status === "failed");
    const label = active && stageLabels.find(([id]) => id === active.id)?.[1];
    q("#cvStageSummary").textContent = active ? `${label} · ${statusText[active.status]}` : stages?.some((s) => s.status === "done") ? "Обработка завершена · этапы" : "Этапы обработки";
    if (active?.status === "failed") q("#cvStageDetails").open = true;
  }

  function stagesFromCaps(caps, preset) {
    return stageLabels.map(([id]) => {
      const st = caps?.stages.find((s) => s.id === id);
      if (!caps) return { id, status: "pending" };
      if (!caps.supported) return { id, status: "skipped", detail: "Тип не поддерживается" };
      if (!st?.applies) return { id, status: "skipped", detail: "Не нужен для этого типа" };
      if (id === "pack" && ui.intent === "images") return { id, status: "skipped" };
      if (id === "check" && preset && !preset.review) return { id, status: "skipped", detail: "Выключено в пресете" };
      return { id, status: "pending" };
    });
  }
  const currentPreset = () => ui.presets.find((p) => p.id === q("#cvPreset").value) || ui.presets[0];

  function renderPresetInfo() {
    const p = currentPreset(); const box = q("#cvPresetInfo"); box.replaceChildren();
    if (!p) return;
    const rows = [["Фон", { auto: "Автоматически", none: "Не трогать", ai: "ИИ-маска" }[p.background] || p.background], ["Края", p.edgeCleanup ? "Очищать" : "Как есть"], ["Пиксель-арт", p.pixelArt ? "Да" : "Нет"], ["Форматы", p.atlas.formats.join(", ")], ["Отступ / экструзия", `${p.atlas.padding} / ${p.atlas.extrude} px`], ["Макс. размер", `${p.atlas.maxSize} px${p.atlas.powerOfTwo ? ", степень двойки" : ""}`], ["Проверка", p.review ? "Только алгоритмы" : "Выключена"]];
    const packs = ui.intent !== "images" && ui.caps?.stages.some(s => s.id === "pack" && s.applies);
    const png = ui.caps?.type === "image" || ui.intent === "images";
    for (const row of rows) if (row[0] === "Проверка" && png && p.review) row[1] = "PNG · размеры и прозрачность";
    for (const [k, v] of rows.filter(([k]) => packs || !["Форматы", "Отступ / экструзия", "Макс. размер"].includes(k))) box.append(el("span", null, k), el("b", null, v));
    if (ui.caps && !ui.result && !busy()) renderStages(stagesFromCaps(ui.caps, p));
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

  async function openInAdvanced(tool) {
    if (!ui.paths.length || busy() || state.busy || ui.opening) return;
    ui.opening = true;
    const revision = ui.revision;
    try {
      if (tool.id === "review" && ui.workingDirty) { setView("conveyor"); return; }
      if (tool.id === "review" && ui.result?.review) {
        const dialog = window.renderReviewPanel({ review: ui.result.review, config: ui.result.reviewConfig, output: ui.result.reviewConfig?.output, onInspect: inspectIssue, onEdit: editIssue });
        dialog.showModal(); return;
      }
      if (tool.id === "review" && ui.caps?.type === "image") {
        const review = await api.reviewPng(ui.paths);
        ui.inspectOriginal = true;
        window.renderReviewPanel({ review, onInspect: inspectIssue, onEdit: editIssue }).showModal(); return;
      }
      const { conveyorToolRoute } = await import("./conveyor-tools.mjs");
      const route = conveyorToolRoute(tool.id);
      if (!route) throw new Error("Инструмент пока не подключён.");
      const manifest = !route.original && ui.result?.artifacts?.manifestPath;
      const key = `${ui.revision}:${manifest || (route.original ? "original" : "source")}`;
      if (!(ui.workspace && ui.studioSource === state.source && !route.original) && (ui.studioKey !== key || ui.studioSource !== state.source)) {
        const source = await api.openInAdvanced(manifest ? [manifest] : ui.paths);
        if (revision !== ui.revision || busy() || state.busy) return;
        // The exported sheet has already been cleaned. Keep its RGBA on entry.
        if (manifest) { source.maskPrepared = true; source.recommendations = { ...source.recommendations, keyMode: "alpha" }; }
        if (manifest) {
          source.kind = "frames";
          for (const id of ["fringeCleanup", "edgeDecontaminate", "contourAlphaEnabled", "pixelateEnabled", "toningEnabled", "auxRife", "auxEsrgan", "auxDepth", "whiteOutput"]) q("#" + id).checked = false;
          q("#edgeRefineMode").value = "none"; q("#colorStyle").value = "none";
        }
        setSource(source);
        ui.studioKey = key; ui.studioSource = state.source;
      }
      const bind = Boolean(!route.original && (manifest || ui.caps?.type === "image") && (!ui.workspace || ui.workspace.source !== state.source));
      setView("advanced"); setTab(route.tab);
      if (route.keyMode) setKeyMode(route.keyMode);
      if (route.action === "editor") {
        if (!state.result?.allSourceFramePaths?.length) {
          const source = state.source.kind === "frames" ? state.source : { ...state.source, kind: "frames" };
          state.source = source; ui.studioSource = source;
          window.startImageEditing(ui.intent !== "images" && ui.intent !== "atlas" && source.paths.length > 1);
          if (source.paths.length > 1) configureTimeline(source);
        }
        if (Number.isInteger(ui.editIndex)) selectFrame(ui.editIndex);
        await pixelEditorOpen();
      } else if (route.action === "mask") {
        if (!state.result) window.startImageEditing(ui.intent !== "images" && ui.intent !== "atlas" && state.source.paths.length > 1);
        if (Number.isInteger(ui.editIndex)) selectFrame(ui.editIndex);
        await openMaskEditor();
      }
      else if (route.action === "review") window.openReviewPanel?.();
      if (bind) { ui.workspace = { source: state.source, outputDir: ui.result?.outputDir, name: ui.detection.paths[0].split(/[\\/]/).pop().replace(/\.[^.]+$/, ""), signature: workingTools.workingSignature(collectOptions()) }; ui.studioSource = state.source; }
      ui.editIndex = null;
      const target = route.focus && q(`#${route.focus}`);
      if (route.details) { const details = route.details === true ? target : q(`#${route.details}`); if (details?.tagName === "DETAILS") details.open = true; }
      target?.closest("details")?.setAttribute("open", "");
      target?.scrollIntoView({ block: "nearest" });
      if (target?.matches("input, select, button, summary")) target.focus();
    } catch (error) { showError(error.message); setStatus(error.message, "error", 0); }
    finally { ui.opening = false; }
  }

  async function renderPreview(mode = ui.previewMode) {
    ui.previewMode = mode;
    const version = ++ui.previewVersion;
    await workingReady;
    pausePlayback();
    const result = mode === "result", file = ui.result?.artifacts?.previewPath;
    allFrames = result ? (ui.result?.artifacts?.frames || []) : [];
    if (result && ui.workingDirty && ui.workspace?.source === state.source) {
      const entries = state.intent === "images" ? state.source.paths.map((_, i) => ({ src: i })) : timelineEntries();
      allFrames = entries.filter(e => !state.excludedFrames.has(e.src)).map(e => ({ path: state.frameOverrides[e.src] || state.source.paths[e.src], durationMs: e.d || state.frameMetadata[e.src]?.durationMs || 1000 / (Number(q("#fps").value) || 12), animation: "Рабочая версия", sourceIndex: e.src }));
    }
    configurePlayback();
    q("#cvShowSource").classList.toggle("selected", !result); q("#cvShowSource").setAttribute("aria-pressed", String(!result));
    q("#cvShowResult").classList.toggle("selected", result); q("#cvShowResult").setAttribute("aria-pressed", String(result));
    q("#cvPreviewImage").classList.add("hidden"); q("#cvPreviewImage").removeAttribute("src");
    q("#cvPreviewEmpty").classList.remove("hidden"); q("#cvPreviewEmpty").textContent = "Готовлю просмотр…";
    q("#cvPreviewCaption").textContent = result ? "Результат · первый кадр" : "Исходник · первый кадр";
    try {
      if (allFrames.length) { const selected = ui.workingDirty ? playback.findIndex(f => f.sourceIndex === state.selectedFrameIndex) : 0; clock.seek(Math.max(0, selected)); showPlaybackFrame(clock.index); return; }
      const preview = await api.preview(result && file ? [file] : ui.paths);
      if (version !== ui.previewVersion) return;
      if (!preview?.url) { q("#cvPreviewEmpty").textContent = "Для этого материала просмотр недоступен."; return; }
      q("#cvPreviewImage").src = preview.url; q("#cvPreviewImage").alt = result ? "Обработанный кадр" : "Исходный кадр";
      q("#cvPreviewImage").classList.remove("hidden"); q("#cvPreviewEmpty").classList.add("hidden");
    } catch (error) { if (version === ui.previewVersion) q("#cvPreviewEmpty").textContent = `Просмотр недоступен: ${error.message}`; }
  }
  function pausePlayback() {
    clock?.pause(); cancelAnimationFrame(playerHandle); playerHandle = null;
    q("#cvPlay").textContent = "Воспроизвести";
  }
  function configurePlayback() {
    marks = []; drawMarks();
    const clip = q("#cvClip"), keep = clip.value; clip.replaceChildren();
    for (const name of new Set(allFrames.map(f => f.animation || "Анимация"))) { const option = el("option", null, name); option.value = name; clip.append(option); }
    if ([...clip.options].some(o => o.value === keep)) clip.value = keep;
    const independent = ["images", "atlas"].includes(ui.intent);
    clip.classList.toggle("hidden", independent || clip.options.length < 2);
    playback = independent ? allFrames : allFrames.filter(f => (f.animation || "Анимация") === clip.value);
    clock.setFrames(playback); q("#cvFrameSeek").max = Math.max(0, playback.length - 1);
    q("#cvPlayback").classList.toggle("hidden", allFrames.length < 2);
    for (const id of ["cvPrevFrame", "cvNextFrame", "cvFrameSeek", "cvFrameLabel"]) q("#" + id).classList.toggle("hidden", allFrames.length < 2);
    q("#cvPlay").classList.toggle("hidden", independent || allFrames.length < 2);
    q("#cvPlay").disabled = playback.length < 2 || ["images", "atlas"].includes(ui.intent) || Boolean(ui.workingDirty);
  }
  function showPlaybackFrame(index) {
    if (!playback[index]) return;
    const frame = playback[index], image = q("#cvPreviewImage");
    const draftUrl = ui.workingDirty && ui.frameDraft?.signature === studioSignature() && ui.frameDraft.frameIndex === frame.sourceIndex ? ui.frameDraft.url : null;
    const url = draftUrl || frame.url || "file:///" + frame.path.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/");
    image.src = url + (url.includes("?") ? "&" : "?") + "v=" + ui.revision;
    image.classList.remove("hidden"); q("#cvPreviewEmpty").classList.add("hidden");
    q("#cvFrameSeek").value = index;
    q("#cvFrameLabel").textContent = `${index + 1}/${playback.length} · ${Math.round(frame.durationMs || 100)} мс`;
    q("#cvPreviewCaption").textContent = ui.workingDirty ? "Рабочий кадр · примените правки для проверки и экспорта" : "Результат · " + (frame.name || `кадр ${index + 1}`);
    image.onload = drawMarks;
  }
  function tickPlayback(now) {
    if (!clock.playing) return;
    const before = clock.index, index = clock.tick(now);
    if (before !== index) { marks = []; drawMarks(); showPlaybackFrame(index); }
    playerHandle = requestAnimationFrame(tickPlayback);
  }
  q("#cvPlay").onclick = () => {
    if (clock.playing) return pausePlayback();
    clock.play(performance.now()); q("#cvPlay").textContent = "Пауза";
    playerHandle = requestAnimationFrame(tickPlayback);
  };
  const seek = index => { pausePlayback(); marks = []; drawMarks(); clock.seek(index); showPlaybackFrame(clock.index); };
  q("#cvPrevFrame").onclick = () => seek((clock.index - 1 + playback.length) % playback.length);
  q("#cvNextFrame").onclick = () => seek((clock.index + 1) % playback.length);
  q("#cvFrameSeek").oninput = event => seek(Number(event.target.value));
  q("#cvClip").onchange = () => { pausePlayback(); const name = q("#cvClip").value; playback = allFrames.filter(f => (f.animation || "Анимация") === name); clock.setFrames(playback); q("#cvFrameSeek").max = Math.max(0, playback.length - 1); showPlaybackFrame(0); marks = []; drawMarks(); };
  document.addEventListener("visibilitychange", () => { if (document.hidden) pausePlayback(); });
  function drawMarks() {
    const canvas = q("#cvIssueOverlay"), figure = q(".cv-preview"), image = q("#cvPreviewImage");
    q("#cvPlayback").classList.toggle("hidden", allFrames.length < 2 && !marks.length);
    canvas.classList.toggle("hidden", !marks.length); q("#cvHideMarks").classList.toggle("hidden", !marks.length);
    canvas.width = figure.clientWidth; canvas.height = figure.clientHeight;
    canvas.style.width = canvas.width + "px"; canvas.style.height = canvas.height + "px";
    canvas.style.left = figure.scrollLeft + "px"; canvas.style.top = figure.scrollTop + "px";
    if (!marks.length || !image.naturalWidth) return;
    const area = image.getBoundingClientRect(), outer = figure.getBoundingClientRect();
    const scale = Math.min(area.width / image.naturalWidth, area.height / image.naturalHeight);
    const x = area.left - outer.left + (area.width - image.naturalWidth * scale) / 2;
    const y = area.top - outer.top + (area.height - image.naturalHeight * scale) / 2;
    const ctx = canvas.getContext("2d"); ctx.strokeStyle = "#00cbd5"; ctx.fillStyle = "#00cbd52a"; ctx.lineWidth = 2;
    for (const r of marks) { const w = Math.max(3, r.width * scale), h = Math.max(3, r.height * scale); ctx.fillRect(x + r.left * scale, y + r.top * scale, w, h); ctx.strokeRect(x + r.left * scale, y + r.top * scale, w, h); }
  }
  q("#cvHideMarks").onclick = () => { marks = []; drawMarks(); };
  new ResizeObserver(drawMarks).observe(q(".cv-preview")); q(".cv-preview").addEventListener("scroll", drawMarks);
  async function inspectIssue(issue) {
    pausePlayback(); setView("conveyor");
    const index = issue.target.frameIndex;
    await renderPreview(ui.inspectOriginal && !ui.result?.artifacts?.frames?.length ? "source" : "result");
    if (ui.inspectOriginal && !ui.result?.artifacts?.frames?.length) allFrames = ui.paths.map(path => ({ path, animation: "Исходник", durationMs: 100 }));
    else allFrames = ui.result?.artifacts?.frames || [];
    const frame = allFrames[index]; if (!frame) return;
    configurePlayback(); q("#cvClip").value = frame.animation || "Анимация";
    playback = ["images", "atlas"].includes(ui.intent) ? allFrames : allFrames.filter(f => (f.animation || "Анимация") === q("#cvClip").value); clock.setFrames(playback); clock.seek(playback.indexOf(frame));
    q("#cvPlayback").classList.remove("hidden"); q("#cvFrameSeek").max = Math.max(0, playback.length - 1);
    showPlaybackFrame(clock.index); marks = issue.regions || []; drawMarks();
  }
  async function editIssue(issue) {
    const frame = ui.result?.artifacts?.frames?.[issue.target.frameIndex];
    ui.editIndex = ui.workspace?.source === state.source && ui.resultFromWorkspace ? frame?.sourceIndex ?? issue.target.frameIndex : issue.target.frameIndex;
    await openInAdvanced({ id: "edge-cleanup" });
  }
  function studioSignature() { return workingTools && ui.workspace?.source === state.source ? workingTools.workingSignature(collectOptions()) : null; }
  function framePreviewReady({ result, signature, frameIndex }) {
    if (!signature || signature !== studioSignature()) return;
    ui.frameDraft = { signature, frameIndex, url: result.afterUrl };
    if (ui.workingDirty && ui.previewMode === "result" && document.body.dataset.view === "conveyor") showPlaybackFrame(clock.index);
  }
  function syncWorking() {
    if (!workingTools || !ui.workspace) return;
    if (ui.workspace.source !== state.source) { ui.workspace = null; ui.workingDirty = false; q("#cvWorking").classList.add("hidden"); syncBusy(); emit(); return; }
    const dirty = workingTools.workingSignature(collectOptions()) !== ui.workspace.signature;
    const changed = dirty !== Boolean(ui.workingDirty); ui.workingDirty = dirty;
    if (dirty) q("#cvShowResult").disabled = false;
    q("#cvWorking").classList.toggle("hidden", !dirty);
    if (changed) { syncBusy(); if (document.body.dataset.view !== "advanced") void renderPreview("result"); emit(); }
  }
  async function applyWorking() {
    if (busy() || state.busy || ui.workspace?.source !== state.source) return;
    setBusy(true); pausePlayback();
    try {
      const options = structuredClone(collectOptions()), signature = workingTools.workingSignature(options);
      const result = await api.rebuild({ source: state.source, options, intent: ui.intent, presetId: currentPreset()?.id, outputDir: ui.workspace.outputDir || ui.result?.outputDir || await api.quickTarget(ui.paths[0]), name: ui.workspace.name, targetRoot: ui.output === "folder" ? ui.outputDir : null });
      if (!result.ok) { setStatus(result.error, "error", 0); return; }
      ui.workspace.signature = signature; ui.workingDirty = false; q("#cvWorking").classList.add("hidden");
      renderResult(result, { keepStudio: true });
    } catch (error) { setStatus(error.message, "error", 0); }
    finally { setBusy(false); }
  }
  q("#cvApplyWorking").onclick = applyWorking;
  q("#cvShowSource").addEventListener("click", () => renderPreview("source"));
  q("#cvShowResult").addEventListener("click", () => renderPreview("result"));
  q("#cvPreviewBackdrop").addEventListener("change", (event) => { q(".cv-preview").dataset.backdrop = event.target.value; });
  q("#cvPreviewFit").addEventListener("click", () => {
    const actual = q(".cv-preview").dataset.scale !== "actual";
    q(".cv-preview").dataset.scale = actual ? "actual" : "fit";
    q("#cvPreviewFit").textContent = actual ? "1:1" : "Вписать";
    q("#cvPreviewFit").setAttribute("aria-pressed", String(!actual)); requestAnimationFrame(drawMarks);
  });

  function showMessage(text) { ui.result = { ok: false, error: text }; emit(); const r = q("#cvResult"); r.classList.remove("hidden"); r.replaceChildren(el("strong", null, "Не получилось"), el("span", null, text)); }

  function renderDetection(result) {
    const { detection, capabilities: caps } = result; ui.detection = detection; ui.caps = caps;
    ui.revision += 1; ui.studioKey = null; ui.intent = null; ui.workspace = null; ui.workingDirty = false; q("#cvWorking").classList.add("hidden");
    q("#cvIntent").classList.toggle("hidden", !needsIntent());
    document.querySelectorAll("[data-intent]").forEach(b => b.setAttribute("aria-pressed", "false"));
    q("#cvIntentHint").textContent = "Выберите цель. Исходные файлы сохранятся.";
    q("#conveyorShell").dataset.loaded = "true";
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
    q("#cvRunAll").disabled = !runnable || busy() || !readyIntent(); q("#cvEnqueue").disabled = !runnable || busy() || !readyIntent();
    q("#cvRunAll").textContent = runLabel();
    q("#cvResult").classList.add("hidden"); ui.result = null;
    q("#cvShowResult").disabled = true;
    void renderPreview("source");
    renderStages(stagesFromCaps(caps, currentPreset()));
    updateOutputHint(); emit();
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
    if (!paths?.length || busy()) return;
    const revision = ++ui.revision;
    try { const result = await api.detect(paths); if (revision !== ui.revision) return; ui.paths = paths; renderDetection(result); } catch (error) { if (revision === ui.revision) showMessage(error.message); }
  }
  async function detectFiles(files) {
    if (busy()) return;
    const revision = ++ui.revision;
    try { const result = await api.detectDropped(files); if (revision !== ui.revision) return; ui.paths = result.detection.paths; renderDetection(result); } catch (error) { if (revision === ui.revision) showMessage(error.message); }
  }

  function renderResult(result, { keepStudio = false } = {}) {
    ui.result = result; ui.resultFromWorkspace = keepStudio; emit();
    if (!keepStudio) { ui.revision += 1; ui.studioKey = null; ui.workspace = null; ui.workingDirty = false; q("#cvWorking").classList.add("hidden"); }
    q("#cvShowResult").disabled = !result.artifacts?.previewPath;
    if (result.artifacts?.previewPath) void renderPreview("result");
    const r = q("#cvResult"); r.classList.remove("hidden"); r.replaceChildren();
    if (!result.ok) {
      r.append(el("strong", null, "Остановлено"), el("span", null, result.error || "Ошибка"));
      if (result.resumeId) { const resume = el("button", "button primary", "Продолжить с этапа ошибки"); resume.type = "button"; resume.onclick = () => runAll(null, result.resumeId); r.append(resume);
        const folder = el("button", "button secondary", "В другую папку и продолжить"); folder.type = "button"; folder.onclick = async () => { if (busy()) return; const output = await api.pickOutput(); if (output) { ui.output = "folder"; ui.outputDir = output; await runAll(null, result.resumeId); } }; r.append(folder); }
      return;
    }
    r.append(el("strong", null, result.review ? `Готово. Проверка: ${result.review.verdictLabel || result.review.verdict}` : "Готово"));
    r.append(el("span", "cv-path", result.outputDir || ""));
    if (result.review?.issues?.length) r.append(el("span", null, `Замечаний: ${result.review.issues.length}. Подробности в отчёте проверки.`));
    if (result.exported?.summary?.includes("Godot SpriteFrames")) r.append(el("span", null, result.exported.summary));
    const actions = el("div", "cv-result-actions"); r.append(actions);
    if (result.review) { const report = el("button", "button secondary", "Открыть проверку"); report.type = "button"; report.onclick = () => openInAdvanced({ id: "review" }); actions.append(report); }
    const edit = el("button", "button secondary", "Править результат"); edit.type = "button";
    edit.addEventListener("click", () => openInAdvanced({ id: "pixel-editor" })); actions.append(edit);
    const reveal = el("button", "button secondary", "Показать в папке"); reveal.type = "button"; reveal.addEventListener("click", () => window.spriteLab.revealOutput(result.outputDir)); actions.append(reveal);
  }

  function setBusy(busy) {
    ui.busy = busy; syncBusy();
    emit();
  }
  function syncBusy() {
    const active = busy();
    q("#cvCancel").classList.toggle("hidden", !active);
    q("#cvQuickCancel").classList.toggle("hidden", !active);
    const runnable = ui.caps?.supported && ui.caps.stages.some((stage) => stage.applies);
    q("#cvRunAll").disabled = active || !runnable || !readyIntent(); q("#cvEnqueue").disabled = active || !runnable || !readyIntent() || Boolean(ui.workingDirty);
    q("#cvRunAll").textContent = active ? "Выполняется" : runLabel();
    for (const control of document.querySelectorAll("#cvPickFile, #cvPickFolder, #cvPreset, #cvSettings button:not(#cvEnqueue), #cvToolsCard button, #cvQuickPick, #cvQuickBackground, #cvQuickAtlas, #cvIntent button, #conveyorView .cv-segmented button")) control.disabled = active;
    q("#cvApplyWorking").disabled = active;
    q("#cvDrop").setAttribute("aria-disabled", String(active));
  }
  async function cancel() {
    if (ui.queue?.running && !ui.busy) return renderQueue(await api.queueCancel(ui.queue.running));
    return api.cancel();
  }

  async function runAll(fix = null, resumeId = null) {
    if (!ui.paths.length || busy() || !readyIntent()) return;
    if (ui.workingDirty || ui.resultFromWorkspace && ui.workspace?.source === state.source) return applyWorking();
    if (ui.output === "folder" && !ui.outputDir) { ui.outputDir = await api.pickOutput(); updateOutputHint(); if (!ui.outputDir) return; }
    if (!resumeId) { ui.recovery = null; q("#cvRecovery").classList.add("hidden"); }
    setBusy(true);
    try { renderResult(resumeId ? await api.resumeSaved({ resumeId, outputDir: ui.output === "folder" ? ui.outputDir : null }) : await api.run({ paths: ui.paths, intent: ui.intent, presetId: currentPreset()?.id, outputDir: ui.output === "folder" ? ui.outputDir : null, ...(fix ? { fix } : {}) })); if (ui.result?.ok || ui.result?.resumeInvalid) { ui.recovery = null; q("#cvRecovery").classList.add("hidden"); } }
    catch (error) { showMessage(error.message); } finally { setBusy(false); }
  }
  function chooseIntent(intent) {
    if (busy() || !["images", "atlas", "animation"].includes(intent)) return;
    ui.intent = intent; ui.result = null; ui.revision += 1; ui.workspace = null; ui.workingDirty = false; q("#cvWorking").classList.add("hidden");
    q("#cvResult").classList.add("hidden"); q("#cvShowResult").disabled = true;
    document.querySelectorAll("[data-intent]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.intent === intent)));
    q("#cvIntentHint").textContent = { images: "Каждый PNG — отдельный файл в своём размере.", atlas: "Разные объекты — один атлас. Размеры объектов сохраняются.", animation: "Файлы — последовательные кадры одной анимации." }[intent];
    renderPresetInfo(); renderStages(stagesFromCaps(ui.caps, currentPreset())); syncBusy(); emit();
  }
  document.querySelectorAll("[data-intent]").forEach(b => b.onclick = () => chooseIntent(b.dataset.intent));
  q("#cvRunAll").addEventListener("click", () => runAll());
  q("#cvEnqueue").addEventListener("click", async () => {
    if (!ui.paths.length || busy()) return;
    if (ui.output === "folder" && !ui.outputDir) { ui.outputDir = await api.pickOutput(); updateOutputHint(); if (!ui.outputDir) return; }
    try { renderQueue(await api.queueAdd({ paths: ui.resultFromWorkspace && ui.result?.artifacts?.manifestPath ? [ui.result.artifacts.manifestPath] : ui.paths, intent: ui.intent, presetId: currentPreset()?.id, outputDir: ui.output === "folder" ? ui.outputDir : null })); } catch (error) { showMessage(error.message); }
  });
  q("#cvCancel").addEventListener("click", () => cancel());
  q("#cvQuickCancel").addEventListener("click", () => cancel());
  function invalidateResume() {
    if (ui.result?.resumeId) { ui.result = null; q("#cvResult").classList.add("hidden"); }
  }
  q("#cvPreset").addEventListener("change", () => { invalidateResume(); renderPresetInfo(); emit(); });
  document.querySelectorAll("#conveyorView .cv-segmented button").forEach((b) => b.addEventListener("click", async () => {
    if (busy()) return;
    ui.output = b.dataset.output;
    document.querySelectorAll("#conveyorView .cv-segmented button").forEach((x) => { x.classList.toggle("selected", x === b); x.setAttribute("aria-checked", String(x === b)); });
    if (ui.output === "folder" && !ui.outputDir) ui.outputDir = await api.pickOutput();
    updateOutputHint();
  }));
  q("#cvPickFile").addEventListener("click", async (e) => { e.stopPropagation(); detect(await api.pickInput(false)); });
  q("#cvPickFolder").addEventListener("click", async (e) => { e.stopPropagation(); detect(await api.pickInput(true)); });
  q("#cvDrop").addEventListener("click", async () => { if (!busy()) await detect(await api.pickInput(false)); });
  for (const zone of [q("#cvDrop"), q("#cvQuickDrop")]) zone.addEventListener("keydown", (event) => { if ((event.key === "Enter" || event.key === " ") && !busy()) { event.preventDefault(); zone.click(); } });
  api.onProgress((p) => { if (p.stages && document.body.dataset.view === "conveyor") renderStages(p.stages); if (p.stages && document.body.dataset.view === "quick") renderQuickProgress(p.stages); });

  /* Quick mode */
  function renderQuickProgress(stages) {
    const box = q("#cvQuickStatus"); box.classList.remove("hidden");
    const running = stages.find((s) => s.status === "running");
    box.replaceChildren(el("strong", null, running ? `${running.label}` : "Обработка"), el("span", "cv-path", stages.filter((s) => s.status === "done").map((s) => s.label).join(" > ")));
  }
  async function quickRun(paths) {
    if (!paths?.length || busy()) return;
    const box = q("#cvQuickStatus"); box.classList.remove("hidden");
    if (paths.length > 1) { box.replaceChildren(el("strong", null, "Нужен один файл"), el("span", null, "Для нескольких файлов используйте «Конвейер» или очередь.")); return; }
    setBusy(true);
    try {
      const { detection, capabilities } = await api.detect(paths);
      if (!capabilities.supported || !capabilities.tools.some((t) => t.id === "quick")) { box.replaceChildren(el("strong", null, capabilities.label), el("span", null, capabilities.message || "Для этого типа быстрый режим недоступен; откройте его в «Конвейере».")); return; }
      box.replaceChildren(el("strong", null, `${capabilities.label}: обработка`));
      const result = await api.run({ paths: detection.paths, quick: true, presetId: "quick", quickOptions: { background: q("#cvQuickBackground").checked, atlas: q("#cvQuickAtlas").checked } });
      box.replaceChildren();
      if (!result.ok) { ui.quick = { error: result.error }; emit(); box.append(el("strong", null, "Остановлено"), el("span", null, result.error)); return; }
      ui.quick = { outputDir: result.outputDir }; emit();
      box.append(el("strong", null, "Готово"), el("span", "cv-path", result.outputDir));
      const reveal = el("button", "button secondary", "Показать в папке"); reveal.type = "button"; reveal.addEventListener("click", () => window.spriteLab.revealOutput(result.outputDir)); box.append(reveal);
    } catch (error) { ui.quick = { error: error.message }; emit(); box.replaceChildren(el("strong", null, "Не получилось"), el("span", null, error.message)); }
    finally { setBusy(false); }
  }
  q("#cvQuickPick").addEventListener("click", async (e) => { e.stopPropagation(); quickRun(await api.pickInput(false)); });
  q("#cvQuickDrop").addEventListener("click", async () => { if (!busy()) await quickRun(await api.pickInput(false)); });

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
    if (busy()) return;
    document.querySelectorAll(".cv-drop").forEach((z) => z.classList.remove("dragging"));
    if (view === "quick") api.detectDropped(e.dataTransfer.files).then((r) => quickRun(r.detection.paths)).catch((error) => showMessage(error.message));
    else { if (view === "queue") setView("conveyor"); detectFiles(e.dataTransfer.files); }
  });

  /* Queue and watch folder */
  const queueStatus = { pending: "Ожидает", running: "Выполняется", done: "Готово", failed: "Ошибка", cancelled: "Отменено" };
  function renderQueue(snap) {
    if (!snap) return;
    ui.queue = snap; syncBusy(); emit();
    void renderSummary();
    const list = q("#cvQueueList"); list.replaceChildren();
    const active = snap.items.filter((i) => i.status === "pending" || i.status === "running").length;
    q("#cvQueueBadge").textContent = String(active); q("#cvQueueBadge").classList.toggle("hidden", !active);
    q("#cvQueuePause").classList.toggle("hidden", snap.paused); q("#cvQueueResume").classList.toggle("hidden", !snap.paused && (Boolean(snap.running) || !snap.items.some(i => i.status === "pending")));
    if (!snap.items.length) { list.append(el("li", "cv-empty", "Очередь пуста. Перетащите файлы на экран «Конвейер» и нажмите «Добавить в очередь».")); return; }
    for (const item of snap.items) {
      const li = el("li"); li.dataset.status = item.status;
      const name = el("div", "cv-q-name", item.paths.map((p) => p.split(/[\\/]/).pop()).join(", "));
      name.append(el("small", null, `${item.origin === "watch" ? "Папка наблюдения · " : ""}${item.detail || ""}`));
      const action = el("button", null, item.status === "running" || item.status === "pending" ? "Отменить" : "Убрать"); action.type = "button";
      action.addEventListener("click", async () => renderQueue(item.status === "running" || item.status === "pending" ? await api.queueCancel(item.id) : await api.queueRemove(item.id)));
      const actions = el("div", "cv-result-actions");
      if (item.status === "failed") {
        const retry = el("button", null, item.resumeId ? "Продолжить" : "Повторить заново"); retry.type = "button";
        retry.onclick = async () => { try { renderQueue(await api.queueRetry({ id: item.id, fresh: !item.resumeId })); } catch (error) { setStatus(error.message, "error", 0); } }; actions.append(retry);
        if (item.resumeId) { const move = el("button", null, "В другую папку"); move.type = "button"; move.onclick = async () => { try { renderQueue(await api.queueRetry({ id: item.id, pickOutput: true })); } catch (error) { setStatus(error.message, "error", 0); } }; actions.append(move); }
      }
      actions.append(action); li.append(name, el("span", "cv-stage-status", queueStatus[item.status] || item.status), actions); list.append(li);
    }
  }
  async function renderSummary() {
    const s = await api.queueSummary();
    q("#cvQueueSummary").textContent = s.total ? `Всего ${s.total}: готово ${s.done}, ошибок ${s.failed}, отменено ${s.cancelled}, ждут ${s.pending}` : "";
  }
  function renderWatch(config) {
    ui.watch = config || null; emit();
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
  async function loadRecovery() {
    const recovery = await api.recovery(); ui.recovery = recovery;
    q("#cvRecovery").classList.toggle("hidden", !recovery);
    if (recovery && !state.source && !ui.paths.length) setView("conveyor");
    if (recovery) q("#cvRecoveryName").textContent = recovery.request.paths.map(p => p.split(/[\\/]/).pop()).join(", ") + " · " + (recovery.request.preset?.label || "");
  }
  async function recover(pickOutput = false) {
    if (busy() || !ui.recovery) return;
    const saved = ui.recovery; setView("conveyor");
    let outputDir = saved.request.outputDir;
    if (pickOutput) { outputDir = await api.pickOutput(); if (!outputDir) return; }
    await detect(saved.request.paths);
    if (["images", "atlas", "animation"].includes(saved.request.intent)) chooseIntent(saved.request.intent);
    ui.output = outputDir ? "folder" : "near"; ui.outputDir = outputDir; updateOutputHint();
    if (ui.presets.some(p => p.id === saved.request.preset.id)) q("#cvPreset").value = saved.request.preset.id;
    setBusy(true);
    try { renderResult(await api.resumeSaved({ resumeId: saved.resumeId, outputDir })); if (ui.result?.ok || ui.result?.resumeInvalid) { ui.recovery = null; q("#cvRecovery").classList.add("hidden"); } }
    catch (error) { showMessage(error.message); }
    finally { setBusy(false); }
  }
  q("#cvRecover").onclick = () => recover(); q("#cvRecoverFolder").onclick = () => recover(true);
  q("#cvForgetRecovery").onclick = async () => { if (busy()) return; await api.forgetRecovery(); ui.recovery = null; q("#cvRecovery").classList.add("hidden"); };
  const ready = workingReady.then(() => loadPresets()).then(() => api.queue()).then(renderQueue).then(() => api.watchGet()).then(renderWatch).then(loadRecovery).catch(() => {});
  // Copilot chips (planConveyorGuide ids) come back here.
  async function act(id) {
    const [kind, arg] = String(id).split(/:(.*)/s);
    if (busy() && !["cancel", "view", "queue-pause", "queue-resume", "watch-stop"].includes(kind)) return;
    if (kind === "view") return setView(arg);
    if (kind === "recover") return recover();
    if (kind === "apply-working") return applyWorking();
    if (kind === "intent") return chooseIntent(arg);
    if (kind === "resume") return runAll(null, ui.result?.resumeId);
    if (kind === "run") return runAll();
    if (kind === "cancel") return cancel();
    if (kind === "enqueue") return q("#cvEnqueue").click();
    if (kind === "pick-file") { setView("conveyor"); return detect(await api.pickInput(false)); }
    if (kind === "pick-folder") { setView("conveyor"); return detect(await api.pickInput(true)); }
    if (kind === "quick-pick") { setView("quick"); return quickRun(await api.pickInput(false)); }
    if (kind === "preset" && ui.presets.some((p) => p.id === arg)) { q("#cvPreset").value = arg; invalidateResume(); renderPresetInfo(); return emit(); }
    if (kind === "tool") { const tool = ui.caps?.tools.find((t) => t.id === arg); if (tool) return openInAdvanced(tool); return; }
    if (kind === "fix") { const issue = ui.result?.review?.issues?.[Number(arg)]; if (issue?.fix) return runAll(issue.fix); return; }
    if (kind === "reveal") { const dir = ui.result?.outputDir || ui.quick?.outputDir; if (dir) window.spriteLab.revealOutput(dir); return; }
    if (kind === "review") return openInAdvanced({ id: "review" });
    if (kind === "queue-pause") return renderQueue(await api.queuePause());
    if (kind === "queue-resume") return renderQueue(await api.queueResume());
    if (kind === "queue-clear") return renderQueue(await api.queueClear());
    if (kind === "watch-pick") { setView("queue"); return q("#cvWatchPick").click(); }
    if (kind === "watch-stop") return renderWatch(await api.watchStop());
  }
  window.conveyorUI = { setView, detect, renderDetection, renderQueue, renderStages, renderResult, studioChanged: syncWorking, workingSignature: studioSignature, framePreviewReady, renderPreview, quickRun, act, snapshot, ready };
  emit();
})();
