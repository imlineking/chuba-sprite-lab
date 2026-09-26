// Task-first entrance. Advanced controls stay available, but the selected job owns
// the first screen and one clear next action. No source files are modified here.
(() => {
  const taskNames = {
    batch: "Пакетно подготовить изображения",
    layout: "Разнести объекты по сетке",
    clipping: "Исправить обрезание",
    remove: "Убрать объект из кадров",
    background: "Удалить фон",
    animation: "Собрать анимацию",
    combine: "Собрать общий атлас объектов",
    extract: "Вырезать один объект из листа",
    objectEdit: "Изменить объект и вернуть в лист",
    match: "Выровнять размеры объекта",
    edit: "Редактировать изображения",
    cutout: "Вырезать объект",
    stylize: "Стилизовать в пиксель-арт",
    depth: "Построить карту глубины",
    upscale: "Увеличить небольшой спрайт",
  };
  let selected = localStorage.getItem("spriteLab.task") || "";
  if (!taskNames[selected]) selected = "";
  // A remembered task is an invitation, not a full workflow card over an empty project.
  let resumeCollapsed = Boolean(selected);
  let approach = localStorage.getItem("spriteLab.taskApproach") === "manual" ? "manual" : "auto";
  let primaryAction = null;
  let secondaryAction = null;
  let arranged = "";
  let extractedPath = null;
  let objectEditOpened = false;
  let preparedLayout = "";
  let batchReport = null;
  let preparingLayout = false;

  async function taskOutput(source = state.source) {
    if (!state.outputFolder) {
      const original = source?.sheetPath || source?.paths?.[0] || source?.previewPath;
      state.outputFolder = await window.spriteLab.automaticOutput(original);
      $("#outputFolder").textContent = state.outputFolder; $("#outputFolder").title = state.outputFolder;
      savePreferences();
    }
    return state.outputFolder;
  }

  async function taskBuildAtlas() {
    await taskOutput();
    $("#exportSheet").checked = true; $("#exportMetadata").checked = true;
    $("#exportFrames").checked = false; $("#exportPreview").checked = false;
    syncExportDependencies("");
    return runBuild(false, true);
  }

  function batchInputPaths() {
    return state.source?.sheetPath ? [state.source.sheetPath] : state.source?.kind === "frames" ? state.source.paths : [];
  }

  async function taskBatchAdd() {
    if (state.busy) return;
    try { const source = await window.spriteLab.addImages(batchInputPaths()); if (source) setSource(source); }
    catch (error) { showError(error.message); }
  }

  async function taskBatchRun() {
    const paths = batchInputPaths(); if (!paths.length || state.busy) return;
    state.busy = true; updateActionState(); taskRender();
    try {
      await taskOutput();
      const profile = $("#batchImageProfile").value;
      if (profile === "ai") await taskEnsureModel($("#aiModel").value || "u2netp");
      const options = collectOptions();
      if (profile === "color") Object.assign(options, { keyMode: "custom", keyColor: hexToRgb($("#batchKeyColor").value), keyScope: $("#batchKeyScope").value, tolerance: Number($("#batchTolerance").value) });
      if (profile === "ai") options.keyMode = "ai";
      Object.assign(options, { autoSize: true, autoColumns: true, anchor: "body", padding: Math.max(24, options.padding || 0), fitEachFrame: false, frameOverrides: {}, frameTransforms: {}, aiEdits: [], attachments: [], attachmentPlacements: null, excludedFrames: [], timeline: null, auxAI: { ...options.auxAI, interpolate: false, inpaintMaskPath: null } });
      $("#stopAfterCurrent").disabled = false; $("#stopAfterCurrent").textContent = "Остановить после текущего"; $("#stopAfterCurrent").classList.remove("hidden");
      setStatus(`Подготавливаю ${paths.length} изображений…`, "busy", 0.02);
      batchReport = await window.spriteLab.imageBatch({ paths, outputDir: state.outputFolder, options, splitObjects: $("#batchSplitObjects").checked });
      state.lastExportDir = batchReport.outputDir; state.lastRevealPath = batchReport.revealPath;
      $("#exportSummary").textContent = `Готово: ${batchReport.completed}/${batchReport.total} файлов · PNG + JSON${batchReport.failed ? ` · ошибок: ${batchReport.failed}` : ""}${batchReport.stopped ? " · очередь остановлена" : ""}`;
      $("#exportSummary").classList.remove("hidden"); $("#completionActions").classList.remove("hidden");
      setStatus($("#exportSummary").textContent, batchReport.failed ? "error" : "done", 1);
      const rows = batchReport.results.map(item => {
        const button = document.createElement("button"); button.type = "button"; button.className = "button secondary";
        button.textContent = `${item.name} · ${item.frameCount} объектов · PNG + JSON`; button.title = item.sheetPath;
        button.addEventListener("click", () => window.spriteLab.revealOutput(item.sheetPath)); return button;
      });
      for (const failure of batchReport.failures) { const row = document.createElement("p"); row.textContent = `${failure.name}: ${failure.message}`; rows.push(row); }
      $("#batchImageResults").replaceChildren(...rows);
      if (!batchReport.failed) hideError();
    } catch (error) { setStatus(error.message || "Обработка остановлена", /отмен|abort/i.test(error.message) ? "idle" : "error", 0); if (!/отмен|abort/i.test(error.message)) showError(error.message); }
    finally { state.busy = false; updateActionState(); $("#stopAfterCurrent").classList.add("hidden"); $("#cancelJob").classList.add("hidden"); taskRender(); }
  }

  async function taskAddImages() {
    if (state.busy || (state.source && state.source.kind !== "frames")) return;
    try {
      const source = await window.spriteLab.addImages(state.source?.paths || []);
      if (source) { setSource(source); setTab("source"); $("#taskGuide").scrollIntoView({ block: "start", behavior: "smooth" }); }
    } catch (error) { setStatus(error?.message || "Не удалось добавить изображения", "error", 0); showError(error?.message); }
  }

  function taskSet(name, nextApproach = "auto") {
    if (!taskNames[name]) return;
    selected = name;
    state.intent = name === "edit" ? "images" : name === "combine" ? "combine" : name === "animation" ? "animation" : ""; document.body.dataset.intent = state.intent;
    if (name === "edit") window.startImageEditing?.();
    else if (state.result?.imageWorkspace) { state.result = null; state.timeline = null; $("#filmstripBar").classList.add("hidden"); }
    resumeCollapsed = false;
    approach = nextApproach === "manual" ? "manual" : "auto";
    localStorage.setItem("spriteLab.task", name);
    localStorage.setItem("spriteLab.taskApproach", approach);
    document.body.dataset.task = name;
    setCopilotPanel(false);
    setTab("source");
    taskRender();
  }

  function taskQuick(name) {
    if (name === "atlas") taskSet(state.source?.sheetPath ? "layout" : state.source?.kind?.startsWith("video") ? "animation" : "combine");
    else if (name === "cutout") taskSet(state.source?.kind === "sheet" ? "extract" : "cutout");
    else if (name === "clipping") taskSet("clipping");
  }

  function taskExport() {
    const singlePng = ["cutout", "stylize", "upscale", "extract"].includes(selected) && state.source?.kind === "frames" && state.source.paths.length === 1;
    $("#exportSheet").checked = !singlePng;
    $("#exportMetadata").checked = !singlePng;
    $("#exportFrames").checked = singlePng;
    $("#exportPreview").checked = false;
    $("#atlasPacking").value = "grid";
    syncExportDependencies("");
    if (!state.outputFolder) {
      setTab("export");
      $("#chooseOutput").click();
      return;
    }
    void runBuild(false);
  }

  async function taskLayoutPreview() {
    if (!state.source?.sheetPath || state.busy || preparingLayout) return;
    preparingLayout = true; taskRender();
    const mode = $("#sheetSliceMode button.selected")?.dataset.sheetMode || "objects";
    try {
      setStatus("Уточняю рамки объектов…", "busy", 0.1);
      const source = await window.spriteLab.resliceSheet({
        sheetPath: state.source.sheetPath,
        options: { mode, columns: Number($("#sheetColumns").value), rows: Number($("#sheetRows").value), cells: state.sheetDraftCells },
      });
      setSource(source);
      $("#sheetFitEach").checked = false;
      $("#autoSize").checked = true;
      $("#autoColumns").checked = false;
      $("#columns").value = String(Math.max(1, Math.ceil(Math.sqrt(source.paths.length))));
      $("#padding").value = String(Math.max(24, Number($("#padding").value) || 0));
      $("#atlasPacking").value = "grid";
      setAnchor("body");
      savePreferences();
      const built = approach === "auto" ? await taskBuildAtlas() : await runBuild(true);
      if (built && approach === "auto") preparedLayout = source.sheetPath;
      setTab("source");
      taskRender();
    } catch (error) { setStatus(error?.message || "Не удалось разнести объекты", "error", 0); showError(error?.message); }
    finally { preparingLayout = false; taskRender(); }
  }

  async function taskApplyAutoPlan() {
    let plan = await autoPilotRun();
    if (!plan) return false;
    const required = (plan.needed || []).filter((item) => item.required && item.canDownload && item.readiness === "ready");
    if (required.length) {
      try {
        for (const model of required) {
          setStatus(`Загружаю модель ${model.name} для выбранной задачи…`, "busy", 0.1);
          await window.spriteLab.downloadModel({ id: model.id });
        }
        await autoPilotRefreshModels();
        plan = await autoPilotRun();
      } catch (error) {
        setStatus(error?.message || "Модель не загрузилась", "error", 0);
        showError(error?.message || "Модель не загрузилась. Откройте каталог моделей.");
        return false;
      }
    }
    if (plan?.steps?.some((step) => step.status === "blocked")) {
      setStatus("Для полного авто-решения нужна модель. Откройте каталог моделей.", "error", 0);
      return false;
    }
    autoPilotApply();
    return true;
  }

  async function taskEnsureModel(id) {
    const status = await window.spriteLab.modelsStatus();
    const model = status.entries.find((entry) => entry.id === id);
    if (!model) throw new Error(`Модель ${id} отсутствует в каталоге.`);
    if (model.installed) return;
    setStatus(`Загружаю ${model.name}…`, "busy", 0.1);
    await window.spriteLab.downloadModel({ id });
    await autoPilotRefreshModels();
  }

  function taskRender() {
    if (state.source) resumeCollapsed = false;
    document.body.dataset.task = selected;
    document.body.dataset.taskApproach = approach;
    const layout = selected && state.source ? state.source.kind === "sheet" ? "guided-sheet" : "guided-source" : "default";
    if (layout !== arranged) {
      const sourcePanel = $("#sourcePanel");
      // Keep every legacy control available, but put the relevant controls first.
      if (layout !== "default") {
        sourcePanel.insertBefore($("#sourceCard"), sourcePanel.querySelector(".panel-heading"));
        if (layout === "guided-sheet") sourcePanel.insertBefore($("#sheetControls"), sourcePanel.querySelector(".panel-heading"));
        else sourcePanel.insertBefore($("#sheetControls"), $("#imageSheetControls"));
      } else {
        sourcePanel.insertBefore($("#sourceCard"), $("#batchNote"));
        sourcePanel.insertBefore($("#sheetControls"), $("#imageSheetControls"));
      }
      arranged = layout;
    }
    const showWelcome = !selected || resumeCollapsed;
    $("#taskWelcome").classList.toggle("hidden", !showWelcome);
    $("#taskGuide").classList.toggle("hidden", showWelcome);
    $("#resumeTask").classList.toggle("hidden", !resumeCollapsed);
    $("#taskWelcomeTitle").textContent = resumeCollapsed ? taskNames[selected] : "Что хотите сделать?";
    $("#taskWelcomeHint").textContent = resumeCollapsed ? "Вы выбрали эту задачу раньше. Продолжите её или выберите другую." : "Выберите задачу — покажем только нужные шаги.";
    $("#openTaskPicker").textContent = resumeCollapsed ? "Другая задача" : "Выбрать задачу";
    if (!selected || resumeCollapsed) return;
    $("#taskGuideTitle").textContent = taskNames[selected];
    $("#taskAdvanced").textContent = "Открыть настройки вручную";
    $("#taskGuide .ai-chip").textContent = approach === "auto" ? "АВТО · ПОМОЩНИК" : "РУЧНОЙ РЕЖИМ";
    const source = state.source;
    const result = state.result;
    const guide = $("#taskGuideText");
    const primary = $("#taskPrimary");
    const secondary = $("#taskSecondary");
    primary.disabled = Boolean(state.busy || preparingLayout);
    secondary.disabled = Boolean(state.busy || preparingLayout); secondary.classList.add("hidden");
    primaryAction = null;
    secondaryAction = null;
    const objectField = $("#taskObjectField");
    objectField.classList.add("hidden");
    $("#taskBatchOptions").classList.toggle("hidden", selected !== "batch");

    if (selected === "batch") {
      const paths = batchInputPaths();
      guide.textContent = paths.length ? `Файлов: ${paths.length}. Применим один профиль ко всем. Выберите цвет пипеткой, область удаления и допуск либо используйте ИИ. Каждый файл получит отдельный прозрачный PNG и JSON.` : "Добавьте изображения деревьев, кустов или других объектов. Для всей серии выберите один профиль: удаление цвета, текущие настройки или локальный ИИ.";
      primary.textContent = paths.length ? batchReport ? "Обработать ещё раз" : "Подготовить все · PNG + JSON" : "Добавить изображения";
      primaryAction = paths.length ? taskBatchRun : taskBatchAdd;
      secondary.textContent = "Добавить ещё файлы"; secondary.classList.toggle("hidden", !paths.length); secondaryAction = taskBatchAdd;
    } else if (["layout", "clipping"].includes(selected) && source?.sheetPath === preparedLayout && result && !state.resultDirty) {
      guide.textContent = `Готово: ${result.frameCount} кадров. Новый атлас и JSON уже сохранены в ${state.lastExportDir}. Плотная часть объекта закреплена, выступы помещаются в ячейки.`;
      primary.textContent = "Открыть готовый атлас и JSON"; primaryAction = () => window.spriteLab.revealOutput(state.lastRevealPath);
      secondary.textContent = "Уточнить рамки вручную"; secondary.classList.remove("hidden"); secondaryAction = () => taskSet(selected, "manual");
    } else if (selected === "clipping") {
      const edgeIssue = result?.frameIssues?.find((issue) => /касается края исходного изображения|обрезан|выходит за пределы/i.test(issue.message || ""));
      if (!source) {
        guide.textContent = "Откройте лист или серию кадров. Помощник проверит край и проведёт к исправлению. Пиксели, которых нет в исходнике, восстановить простой сменой рамки нельзя.";
        primary.textContent = "1 · Открыть спрайт-лист";
        primaryAction = () => chooseSource("chooseSheet");
        secondary.textContent = "Открыть кадры или видео";
        secondary.classList.remove("hidden");
        secondaryAction = () => chooseSource("chooseSource");
      } else if (source.sheetPath && (!result || state.resultDirty)) {
        guide.textContent = "Помощник найдёт полный контур объектов, разнесёт их с запасом и соберёт новый лист. Сначала проверьте найденные рамки; исходный лист останется на месте.";
        primary.textContent = approach === "auto" ? "2 · Разнести с запасом" : "2 · Уточнить рамки вручную";
        primaryAction = approach === "auto" ? taskLayoutPreview : () => { $("#sheetSliceMode button[data-sheet-mode=manual]").click(); $("#sheetControls").scrollIntoView({ block: "start", behavior: "smooth" }); };
      } else if (!result || state.resultDirty) {
        guide.textContent = "Соберите предпросмотр: программа отметит кадры, где рисунок касается края исходника. Для восстановления уже отсутствующих пикселей потребуется исходник с запасом или ручная правка.";
        primary.textContent = "2 · Проверить края кадров";
        primaryAction = () => { void runBuild(true); };
      } else {
        guide.textContent = edgeIssue
          ? `Проверьте кадр ${Number(edgeIssue.frameIndex) + 1}: рисунок касается края. Для готового листа можно уточнить рамки; если край уже отсутствует в исходнике, откройте кадр в редакторе.`
          : "Проверьте края в предпросмотре. Если объект целиком помещается, сохраните новый лист и JSON; если часть уже отсутствовала в исходнике, исправьте кадр вручную.";
        primary.textContent = edgeIssue ? "3 · Показать проблемный кадр" : "3 · Сохранить лист и JSON";
        primaryAction = edgeIssue ? () => { setTab("process"); selectFrame(Number(edgeIssue.frameIndex)); } : taskExport;
        secondary.textContent = source.sheetPath ? "Уточнить рамки листа" : "Править кадр вручную";
        secondary.classList.remove("hidden");
        secondaryAction = source.sheetPath
          ? () => { setTab("source"); $("#sheetSliceMode button[data-sheet-mode=manual]").click(); $("#sheetControls").scrollIntoView({ block: "start", behavior: "smooth" }); }
          : () => { setTab("process"); if (edgeIssue) selectFrame(Number(edgeIssue.frameIndex)); $("#editFrame").click(); };
      }
    } else if (selected === "objectEdit") {
      if (!source?.sheetPath) {
        guide.textContent = "Откройте готовый лист с отдельными объектами. После выбора объекта доступны правка внутри программы, «Открыть с помощью…» и онлайн-редактор. Исправление попадёт в новый лист.";
        primary.textContent = "1 · Открыть лист";
        primaryAction = () => chooseSource("chooseSheet");
      } else if (!result || state.resultDirty) {
        guide.textContent = objectEditOpened ? "Правка подхвачена. Пересоберите атлас: изменённый объект займёт своё место, JSON координат обновится." : "Сначала соберите атлас для выбора и редактирования объекта.";
        primary.textContent = objectEditOpened ? "3 · Пересобрать с правкой" : "1 · Собрать предпросмотр";
        primaryAction = () => { void runBuild(true); };
      } else if (objectEditOpened) {
        guide.textContent = "Проверьте исправленный объект справа. Готовый лист и JSON можно сохранить, оригинал остаётся без изменений.";
        primary.textContent = state.outputFolder ? "4 · Сохранить лист и JSON" : "4 · Выбрать папку";
        primaryAction = taskExport;
        secondary.textContent = "Исправить ещё объект";
        secondary.classList.remove("hidden");
        secondaryAction = () => { objectEditOpened = false; taskRender(); };
      } else {
        guide.textContent = `На листе ${source.paths.length} объектов. Выберите объект. Внутри программы доступны карандаш, ластик, заливка и слои; внешний редактор открывает «Открыть с помощью…» и онлайн-сервисы. Размер, перенос и наклон доступны через «Все настройки».`;
        const select = $("#taskObjectSelect");
        if (select.options.length !== source.paths.length || select.dataset.sheetPath !== source.sheetPath) {
          select.replaceChildren(...source.paths.map((_, index) => new Option(`Объект ${index + 1}`, String(index))));
          select.dataset.sheetPath = source.sheetPath;
        }
        objectField.classList.remove("hidden");
        primary.textContent = "2 · Редактировать пиксели";
        primaryAction = () => { selectFrame(Number(select.value)); objectEditOpened = true; $("#editFrame").click(); };
        secondary.textContent = "Править внутри программы";
        secondary.classList.remove("hidden");
        secondaryAction = () => { selectFrame(Number(select.value)); objectEditOpened = true; $("#openPixelEditor").click(); };
      }
    } else if (selected === "match") {
      if (!source) {
        guide.textContent = "Откройте спрайт-лист или серию кадров объекта. Выберите эталон и выровняйте сопоставимые кадры по габариту контура.";
        primary.textContent = "1 · Открыть лист";
        primaryAction = () => chooseSource("chooseSheet");
        secondary.textContent = "Открыть кадры";
        secondary.classList.remove("hidden");
        secondaryAction = () => chooseSource("chooseSource");
      } else if (!result || state.resultDirty) {
        guide.textContent = "Соберите превью. Затем выберите опорный кадр и точку привязки: центр силуэта или низ. Масштаб не меняется до вашего подтверждения.";
        primary.textContent = "2 · Собрать и проверить";
        primaryAction = () => { void runBuild(true); };
      } else {
        guide.textContent = "Выберите опорный кадр ниже. Анализ предложит масштаб для похожих контуров и оставит другие позы для ручной проверки.";
        primary.textContent = "3 · Сравнить с эталоном";
        primaryAction = () => { setTab("process"); $("#consistencyPanel").open = true; $("#consistencyPanel").scrollIntoView({ block: "start", behavior: "smooth" }); $("#analyzeFrameSizes").click(); };
        secondary.textContent = "Сохранить результат";
        secondary.classList.remove("hidden");
        secondaryAction = taskExport;
      }
    } else if (selected === "extract") {
      if (source?.kind === "frames" && source.paths.length === 1 && source.paths[0] === extractedPath) {
        if (!result || state.resultDirty) {
          guide.textContent = "Выбранный объект отделён от листа. Соберите предпросмотр, проверьте контур и при необходимости настройте удаление фона.";
          primary.textContent = "3 · Проверить объект";
          primaryAction = () => { void runBuild(true); };
        } else {
          guide.textContent = "Готово: выбранный объект можно сохранить отдельным PNG. Исходный лист не изменён.";
          primary.textContent = state.outputFolder ? "4 · Сохранить PNG" : "4 · Выбрать папку";
          primaryAction = taskExport;
        }
      } else if (source?.sheetPath) {
        guide.textContent = `Найдено ${source.paths.length} объектов. Выберите один по номеру, проверьте его справа и сохраните отдельно. Для точных границ доступны «Свои рамки» ниже.`;
        const select = $("#taskObjectSelect");
        if (select.options.length !== source.paths.length || select.dataset.sheetPath !== source.sheetPath) {
          select.replaceChildren(...source.paths.map((_, index) => new Option(`Объект ${index + 1}`, String(index))));
          select.dataset.sheetPath = source.sheetPath;
        }
        objectField.classList.remove("hidden");
        primary.textContent = "2 · Отделить выбранный объект";
        primaryAction = async () => {
          try {
            const filePath = source.paths[Number(select.value)];
            const isolated = await window.spriteLab.useImageObject(filePath);
            extractedPath = isolated.paths[0];
            setSource(isolated);
            await runBuild(true);
          } catch (error) { showError(error?.message || "Не удалось отделить объект"); }
        };
      } else {
        guide.textContent = source?.kind === "frames" && source.paths.length === 1
          ? "Проверим PNG/JPG/WebP как лист: найдём отдельные объекты и покажем их рамки для выбора."
          : "Откройте изображение с несколькими объектами. Помощник выделит их, затем вы выберете нужный.";
        primary.textContent = source?.kind === "frames" && source.paths.length === 1 ? "1 · Найти объекты" : "1 · Открыть изображение";
        primaryAction = source?.kind === "frames" && source.paths.length === 1
          ? async () => { try { setSource(await window.spriteLab.resliceSheet({ sheetPath: source.paths[0], options: { mode: "objects" } })); } catch (error) { showError(error?.message); } }
          : () => chooseSource("chooseSheet");
      }
    } else if (selected === "combine" || selected === "animation") {
      const imageCount = source?.kind === "frames" ? source.paths.length : 0;
      if (!source || imageCount === 1) {
        guide.textContent = selected === "combine"
          ? "Добавьте несколько PNG, JPG или WebP с отдельными объектами. Помощник соберёт их в один атлас и JSON с координатами, чтобы уменьшить число файлов в игре."
          : "Для анимации добавьте несколько последовательных кадров PNG, JPG или WebP либо откройте видео/GIF. Порядок изображений определяется по именам с учётом чисел.";
        primary.textContent = imageCount ? "1 · Добавить ещё изображения" : "1 · Выбрать изображения";
        primaryAction = taskAddImages;
        if (selected === "animation") {
          secondary.textContent = "Открыть видео или GIF";
          secondary.classList.remove("hidden");
          secondaryAction = () => chooseSource("chooseSource");
        }
      } else if (!result || state.resultDirty) {
        guide.textContent = selected === "combine"
          ? `${imageCount} объектов. Каждый получит свою ячейку; размеры подберутся по самому большому. Проверьте выравнивание ниже, затем соберите общий атлас.`
          : `Добавлено ${imageCount || "несколько"} кадров. Помощник подберёт обработку и покажет анимацию; исходники останутся на месте.`;
        primary.textContent = approach === "auto" ? "2 · Собрать и проверить" : "2 · Настроить вручную";
        primaryAction = approach === "auto"
          ? async () => {
              setTab("process");
              if (selected === "combine") {
                $("#autoSize").checked = true;
                $("#autoColumns").checked = true;
                $("#padding").value = String(Math.max(4, Number($("#padding").value) || 0));
                setAnchor("center");
                await taskBuildAtlas();
              } else if (await taskApplyAutoPlan()) await taskBuildAtlas();
            }
          : () => { setTab("process"); $(selected === "combine" ? "#autoColumns" : "#fps").scrollIntoView({ block: "center", behavior: "smooth" }); };
        if (source.kind === "frames") {
          secondary.textContent = "Добавить ещё файлы";
          secondary.classList.remove("hidden");
          secondaryAction = taskAddImages;
        }
      } else {
        guide.textContent = selected === "combine"
          ? `Готово: ${result.frameCount} объектов в общем атласе.${state.lastExportDir ? " PNG и JSON уже сохранены." : " Проверьте поля и сохраните лист с JSON координатами."}`
          : `Готово: ${result.frameCount} кадров.${state.lastExportDir ? " PNG и JSON анимации уже сохранены." : " Проверьте движение и сохраните лист с JSON анимации."}`;
        primary.textContent = state.lastExportDir ? "Открыть PNG и JSON" : state.outputFolder ? "3 · Сохранить лист и JSON" : "3 · Выбрать папку для результата";
        primaryAction = state.lastExportDir ? () => window.spriteLab.revealOutput(state.lastRevealPath) : taskExport;
        if (source.kind === "frames") {
          secondary.textContent = "Добавить ещё файлы";
          secondary.classList.remove("hidden");
          secondaryAction = taskAddImages;
        }
      }
    } else if (selected === "layout") {
      if (!source?.sheetPath) {
        const oneImage = source?.kind === "frames" && source.paths.length === 1;
        guide.textContent = oneImage
          ? "Этот файл можно проверить как готовый лист: программа найдёт отдельные объекты и покажет их рамки. Оригинал останется без изменений."
          : "Откройте готовый спрайт-лист (PNG, JPG или WebP). Помощник найдёт отдельные объекты и покажет их рамки.";
        primary.textContent = oneImage ? "1 · Проверить этот файл как лист" : "1 · Открыть спрайт-лист";
        primaryAction = oneImage
          ? async () => { try { const found = await window.spriteLab.resliceSheet({ sheetPath: source.paths[0], options: { mode: "objects" } }); setSource(found); if (approach === "auto") await taskLayoutPreview(); } catch (error) { showError(error?.message); } }
          : () => chooseSource("chooseSheet");
      } else if (!result || state.resultDirty) {
        guide.textContent = approach === "auto"
          ? `Найдено ${source.paths.length} объектов. Программа отделит их, выровняет плотную часть каждого объекта и добавит поля для нити, хвоста и других выступов. Нить не смещает центр. Масштаб остаётся общим для всех кадров.`
          : `Найдено ${source.paths.length} объектов. Выберите «Свои рамки» ниже: рамки можно рисовать мышью или вводить координаты. Затем соберите новый лист.`;
        if (approach === "manual" && $("#sheetSliceMode button.selected")?.dataset.sheetMode !== "manual") {
          primary.textContent = "2 · Открыть ручные рамки";
          primaryAction = () => { $("#sheetSliceMode button[data-sheet-mode=manual]").click(); $("#sheetControls").scrollIntoView({ block: "start", behavior: "smooth" }); taskRender(); };
        } else {
          primary.textContent = approach === "auto" ? "2 · Разнести и сохранить PNG + JSON" : "3 · Собрать по моим рамкам";
          primaryAction = taskLayoutPreview;
        }
      } else {
        guide.textContent = `Готово: ${result.frameCount} кадров на новой сетке. Проверьте предпросмотр справа и сохраните лист вместе с JSON координатами.`;
        primary.textContent = state.outputFolder ? "3 · Сохранить лист и JSON" : "3 · Выбрать папку для результата";
        primaryAction = taskExport;
      }
    } else if (selected === "remove") {
      if (!source) {
        guide.textContent = "Откройте видео или готовый лист. Затем щёлкните по лишнему объекту один раз: он будет найден в остальных кадрах.";
        primary.textContent = "1 · Открыть видео или кадры";
        primaryAction = () => chooseSource("chooseSource");
        secondary.textContent = "Открыть спрайт-лист";
        secondary.classList.remove("hidden");
        secondaryAction = () => chooseSource("chooseSheet");
      } else if (!state.maskEdits.length) {
        guide.textContent = approach === "auto"
          ? "Выберите кадр справа и щёлкните по лишнему объекту. Умная область найдёт его в серии; проверьте результат перед сохранением."
          : "Откройте кадр и закрасьте лишний объект кистью. По умолчанию ручная правка относится к выбранному кадру.";
        primary.textContent = approach === "auto" ? "2 · Указать объект для слежения" : "2 · Открыть кисть удаления";
        primaryAction = () => { setTab("process"); if (approach === "manual") { $("#maskApplyAll").checked = false; setMaskTool("erase"); } else { $("#maskApplyAll").checked = true; setMaskTool("smart"); } $("#openMaskEditor").click(); };
      } else if (!result || state.resultDirty) {
        guide.textContent = `Правок: ${state.maskEdits.length}. Соберите превью и пролистайте кадры, чтобы проверить, что объект удалён в каждом из них.`;
        primary.textContent = "3 · Проверить все кадры";
        primaryAction = () => { void runBuild(true).then(() => setTab("source")); };
        secondary.textContent = "Исправить выделение";
        secondary.classList.remove("hidden");
        secondaryAction = () => { setTab("process"); $("#openMaskEditor").click(); };
      } else {
        guide.textContent = "Объект удалён из собранных кадров. Проверьте анимацию справа и сохраните новый лист с JSON.";
        primary.textContent = state.outputFolder ? "4 · Сохранить лист и JSON" : "4 · Выбрать папку для результата";
        primaryAction = taskExport;
        secondary.textContent = "Исправить выделение";
        secondary.classList.remove("hidden");
        secondaryAction = () => { setTab("process"); $("#openMaskEditor").click(); };
      }
    } else if (!source) {
      guide.textContent = "Добавьте видео, спрайт-лист или отдельные кадры. Помощник покажет следующий шаг после загрузки.";
      primary.textContent = "1 · Открыть файл";
      primaryAction = () => chooseSource("chooseSource");
      secondary.textContent = "Открыть спрайт-лист";
      secondary.classList.remove("hidden");
      secondaryAction = () => chooseSource("chooseSheet");
    } else if (selected === "background") {
      guide.textContent = approach === "auto"
        ? "Оркестратор измерит фон и край, подберёт точный контур либо установленную модель и покажет результат для проверки."
        : "Выберите тип фона и настройте силу удаления во вкладке обработки. Предпросмотр покажет результат без изменения исходника.";
      primary.textContent = approach === "auto" ? "2 · Подобрать ИИ и показать результат" : "2 · Открыть настройки фона";
      primaryAction = approach === "auto"
        ? async () => { setTab("process"); if (source.kind === "frames") { window.startImageEditing(); await window.saveIndependentImages({ all: true, automatic: true }); } else if (await taskApplyAutoPlan()) await runBuild(true); }
        : () => { setTab("process"); $("#keyMode").scrollIntoView({ block: "center", behavior: "smooth" }); };
    } else if (selected === "edit") {
      guide.textContent = "Выберите изображение в ленте. Обведите область, удалите её цвет пипеткой или уберите запечённые шахматы. Сохраняются отдельные PNG исходного размера. Автоочистка анализирует каждый файл и сама выбирает модель; исходники остаются на месте.";
      primary.textContent = "Выделить область и очистить фон";
      primaryAction = () => openMaskEditor({ tool: "select" }).catch(error => showError(error.message));
      secondary.textContent = approach === "auto" ? "Автоочистка всех · отдельные PNG" : "Сохранить все PNG"; secondary.classList.remove("hidden");
      secondaryAction = () => window.saveIndependentImages({ all: true, automatic: approach === "auto" });
    } else if (["cutout", "stylize", "depth", "upscale"].includes(selected)) {
      if (result && !state.resultDirty) {
        guide.textContent = selected === "depth"
          ? "Карта глубины готова. Откройте вкладку «Глубина» над предпросмотром и сохраните результат."
          : "Проверьте изображение справа: переключатели «До», «После» и «Сравнить» показывают эффект. Затем сохраните результат.";
        primary.textContent = state.outputFolder ? "3 · Сохранить результат" : "3 · Выбрать папку для результата";
        primaryAction = taskExport;
      } else if (selected === "cutout") {
        guide.textContent = approach === "auto"
          ? "Для JPG, PNG или WebP: оркестратор определит фон, выберет контур или модель выделения и покажет прозрачный результат."
          : "Для JPG, PNG или WebP: во вкладке обработки вручную выберите цвет фона или ИИ-выделение.";
        primary.textContent = approach === "auto" ? "2 · Вырезать и проверить" : "2 · Настроить вырезку";
        primaryAction = approach === "auto"
          ? async () => { setTab("process"); if (await taskApplyAutoPlan()) await runBuild(true); }
          : () => { setTab("process"); $("#keyMode").scrollIntoView({ block: "center", behavior: "smooth" }); };
      } else if (selected === "stylize") {
        guide.textContent = approach === "auto" ? "Оркестратор измерит рисунок, подберёт размер пикселя, палитру и стиль, затем покажет PNG-превью." : "Откройте настройки пиксель-арта: размер блока, палитра и дизеринг доступны вручную.";
        primary.textContent = approach === "auto" ? "2 · Подобрать стиль и показать" : "2 · Настроить стиль";
        primaryAction = approach === "auto"
          ? async () => { $("#pixelateEnabled").checked = true; setTab("process"); if (await taskApplyAutoPlan()) await runBuild(true); }
          : () => { setTab("process"); $("#pixelatePanel").open = true; $("#pixelatePanel").scrollIntoView({ block: "start", behavior: "smooth" }); };
      } else if (selected === "depth") {
        guide.textContent = approach === "auto" ? "Depth Anything V2 построит отдельную серую карту относительной глубины; её можно проверить в предпросмотре и сохранить как PNG." : "Включите карту глубины в ИИ-этапах и соберите превью вручную.";
        primary.textContent = approach === "auto" ? "2 · Построить глубину" : "2 · Открыть ИИ-этапы";
        primaryAction = approach === "auto"
          ? async () => { $("#auxDepth").checked = true; setTab("process"); if (await taskApplyAutoPlan()) { await runBuild(true); setPreviewMode("depth"); } }
          : () => { setTab("process"); $("#auxAITools").open = true; $("#auxAITools").scrollIntoView({ block: "start", behavior: "smooth" }); };
      } else {
        guide.textContent = approach === "auto" ? "Real-ESRGAN увеличит небольшой рисунок в 4 раза с сохранением прозрачности. Крупные кадры программа обрабатывает частями." : "Включите Real-ESRGAN в ИИ-этапах и соберите превью вручную.";
        primary.textContent = approach === "auto" ? "2 · Увеличить ×4" : "2 · Открыть ИИ-этапы";
        primaryAction = approach === "auto"
          ? async () => { try { await taskEnsureModel("real-esrgan"); $("#auxEsrgan").checked = true; setTab("process"); await runBuild(true); } catch (error) { showError(error?.message); } }
          : () => { setTab("process"); $("#auxAITools").open = true; $("#auxAITools").scrollIntoView({ block: "start", behavior: "smooth" }); };
      }
    } else {
      guide.textContent = result ? "Проверьте анимацию справа и сохраните атлас." : approach === "auto" ? "Оркестратор измерит кадры, выберет установленные модели и соберёт превью." : "Настройте частоту, ячейку и порядок кадров вручную.";
      primary.textContent = result ? "3 · Перейти к экспорту" : approach === "auto" ? "2 · Подобрать и собрать" : "2 · Открыть настройки анимации";
      primaryAction = result ? () => setTab("export") : approach === "auto"
        ? async () => { setTab("process"); if (await taskApplyAutoPlan()) await runBuild(true); }
        : () => { setTab("process"); $("#fps").scrollIntoView({ block: "center", behavior: "smooth" }); };
    }
  }

  $("#openTaskPicker").addEventListener("click", () => setCopilotPanel(true));
  $("#resumeTask").addEventListener("click", () => { resumeCollapsed = false; taskRender(); $("#taskGuide").scrollIntoView({ block: "start", behavior: "smooth" }); });
  $("#changeTask").addEventListener("click", () => setCopilotPanel(true));
  $("#taskPrimary").addEventListener("click", () => primaryAction?.());
  $("#taskSecondary").addEventListener("click", () => secondaryAction?.());
  $("#taskAdvanced").addEventListener("click", () => {
    if (selected === "layout") { setTab("source"); $("#sheetControls").scrollIntoView({ block: "start", behavior: "smooth" }); }
    else if (selected === "objectEdit") { selectFrame(Number($("#taskObjectSelect").value) || 0); setTab("process"); setTransformPanel(true); }
    else if (selected === "edit") void openMaskEditor({ tool: "select" }).catch(error => showError(error.message));
    else { setTab("process"); $(selected === "remove" ? "#openMaskEditor" : selected === "background" ? "#keyMode" : "#fps").scrollIntoView({ block: "center", behavior: "smooth" }); }
  });
  $("#taskObjectSelect").addEventListener("change", () => {
    const index = Number($("#taskObjectSelect").value);
    if (state.source?.kind === "sheet") {
      state.selectedFrameIndex = index;
      requestFramePreview(state.source.paths[index]);
    }
  });
  $("#batchPickColor").addEventListener("click", () => pickSourceColor(value => { $("#batchKeyColor").value = value; }));
  $("#batchImageProfile").addEventListener("change", () => $("#batchColorControls").classList.toggle("hidden", $("#batchImageProfile").value !== "color"));
  $("#batchTolerance").addEventListener("input", () => { $("#batchToleranceValue").value = $("#batchTolerance").value; });
  $("#batchKeyScope").addEventListener("change", () => { $("#batchScopeHint").textContent = $("#batchKeyScope").value === "all" ? "Будут удалены и детали объекта такого же цвета, например цветы или блики. Для них используйте режим фона или исправьте маску вручную." : "Внутренние детали сохраняются. Открытый контур может пропускать удаление внутрь объекта."; });
  $(".copilot-tasks").addEventListener("click", (event) => {
    const action = event.target.closest("button[data-approach]");
    const choice = action?.closest("article[data-task]");
    if (choice) window.taskChoose(choice.dataset.task, action.dataset.approach);
  });
  $(".copilot-quick").addEventListener("click", (event) => {
    const action = event.target.closest("button[data-quick-task]");
    if (action) taskQuick(action.dataset.quickTask);
  });
  window.taskRestore = name => taskSet(name, "manual");
  window.taskChoose = (name, nextApproach = "auto") => {
    taskSet(name, nextApproach);
    if (name === "edit" && state.source?.kind === "frames" && !state.busy) {
      if (nextApproach === "auto") void window.saveIndependentImages({ all: true, automatic: true });
      else void openMaskEditor({ tool: "select" }).catch(error => showError(error.message));
      return;
    }
    if (nextApproach !== "auto" || !state.source || state.busy) return;
    if (["layout", "clipping"].includes(name) && state.source.sheetPath) void taskLayoutPreview();
    else if ((name === "combine" && state.source.kind === "frames" && state.source.paths.length > 1)
      || (name === "animation" && (state.source.kind.startsWith("video") || state.source.paths.length > 1))) primaryAction?.();
  };
  window.taskRenderSuggestions = (scenarios = []) => {
    const container = $(".copilot-tasks");
    const cards = [...container.querySelectorAll("article[data-task]")];
    const rank = new Map(scenarios.map((item, index) => [item.task, index]));
    cards.sort((a, b) => (rank.get(a.dataset.task) ?? 99) - (rank.get(b.dataset.task) ?? 99));
    for (const card of cards) {
      const suggestion = scenarios.find((item) => item.task === card.dataset.task);
      card.classList.toggle("recommended", Boolean(suggestion?.recommended));
      const description = card.querySelector("small");
      card.dataset.defaultDescription ||= description.textContent;
      description.textContent = suggestion?.why || card.dataset.defaultDescription;
      container.append(card);
    }
  };
  $("#applyMaskEditor").addEventListener("click", () => {
    if (selected === "remove") setTimeout(() => { taskRender(); setTab("source"); }, 0);
  });
  window.taskOnSource = (source) => {
    $("#imageScenarioChoices").classList.toggle("hidden", source?.kind !== "frames");
    if (source?.kind === "frames") { selected = "edit"; state.intent = "images"; window.startImageEditing?.(); }
    batchReport = null; $("#batchImageResults").replaceChildren();
    if (!source?.sheetPath) objectEditOpened = false;
    if (source?.kind === "sheet" && (!selected || selected === "animation")) taskSet("layout");
    taskRender();
  };
  const earlierSetStatus = setStatus;
  setStatus = function taskObservedSetStatus(...args) {
    const value = earlierSetStatus(...args);
    queueMicrotask(taskRender);
    return value;
  };
  taskRender();
  // Startup greeting is shown by the desktop companion; the task list opens on request.
})();
