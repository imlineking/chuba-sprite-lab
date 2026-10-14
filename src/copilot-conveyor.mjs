// Copilot guide for the conveyor, quick mode, queue/watch, presets and «Приёмка».
// Pure function: (what the copilot sees) -> { say, chips, honest }. The copilot cloud
// renders chips as clickable choices; ids are routed back to conveyor.js. Tool chips are
// only produced for tools that the capability map allows for the detected input type.

import { capabilitiesFor } from "./capabilities.mjs";

const fixable = new Set(["padding", "extrude", "maxSize", "background"]);
// Critic fixes that need a human eye map to the tool where they are finished by hand.
const manualTool = { slice: "slice-sheet", trim: "align-frames", pivot: "align-frames", anchor: "align-frames", order: "pixel-editor", sortBy: "pixel-editor" };
const toolHints = { "remove-background": "если фон сложный", "ai-mask": "для фото и мягких краёв", "edge-cleanup": "светлая кайма по контуру", "split-frames": "проверить кадры до упаковки", "slice-sheet": "если сетка определилась неверно", "align-frames": "если персонаж «прыгает»", "pixelate": "стиль пиксель-арт", "pixel-editor": "доправить пиксели вручную", "review": "вердикт и правки", "trim-time": "взять только нужный кусок", "import-aseprite": "слои и теги", "import-atlas": "готовые кадры из JSON" };

export function autoFixFor(fix) {
  if (!fix || typeof fix !== "object") return null;
  const keys = Object.keys(fix).filter((k) => fixable.has(k));
  if (!keys.length) return null;
  const out = {};
  if (Number.isFinite(fix.padding)) out.padding = Math.max(0, Math.min(16, Math.round(fix.padding)));
  if (Number.isFinite(fix.extrude)) out.extrude = Math.max(0, Math.min(8, Math.round(fix.extrude)));
  if (Number.isFinite(fix.maxSize)) out.maxSize = Math.max(256, Math.min(8192, Math.round(fix.maxSize)));
  if (fix.background) out.background = "auto";
  return Object.keys(out).length ? out : null;
}

export function applyFixToPreset(preset, fix) {
  const safe = autoFixFor(fix);
  if (!preset || !safe) return preset;
  const atlas = { ...preset.atlas };
  for (const k of ["padding", "extrude", "maxSize"]) if (k in safe) atlas[k] = safe[k];
  return { ...preset, atlas, ...(safe.background ? { background: "auto", edgeCleanup: true } : {}) };
}

function manualFor(fix, allowed) {
  if (!fix || typeof fix !== "object") return null;
  for (const key of Object.keys(fix)) { const tool = manualTool[key]; if (tool && allowed.has(tool)) return tool; }
  return null;
}

const describeFix = (f) => [f.padding != null && `отступ ${f.padding}px`, f.extrude != null && `экструзия ${f.extrude}px`, f.maxSize != null && `страница ${f.maxSize}px`, f.background && "снова убрать фон"].filter(Boolean).join(", ");

export function planConveyorGuide(view = {}) {
  const { mode = "conveyor", capabilities: caps = null, detection = null, preset = null, presets = [], result = null, queue = null, watch = null, busy = false, quick = null } = view;
  const chips = []; let say = ""; let honest = null;
  const allowed = new Set((caps?.tools || []).map((t) => t.id));
  const chip = (id, title, detail) => chips.push({ id, title, detail });
  const toolChip = (toolId) => { if (!allowed.has(toolId)) return; const tool = caps.tools.find((t) => t.id === toolId); chip(`tool:${toolId}`, tool.label, toolHints[toolId] || "открыть инструмент"); };

  if (busy) return { say: "Конвейер работает. Скажу, что получилось, когда закончит.", chips: [{ id: "cancel", title: "Остановить", detail: "Прервать текущий запуск" }], honest: null };

  if (mode === "queue") {
    const items = queue?.items || [];
    const active = items.filter((i) => i.status === "pending" || i.status === "running").length;
    const failed = items.filter((i) => i.status === "failed").length;
    say = items.length ? `В очереди ${items.length}: в работе ${active}, ошибок ${failed}.` : "Очередь пуста. Файлы можно добавить из конвейера или поручить папке наблюдения.";
    if (watch?.dir) say += ` Слежу за папкой ${watch.dir}.`;
    if (queue?.paused) chip("queue-resume", "Продолжить очередь", "Сейчас на паузе"); else if (active) chip("queue-pause", "Пауза", "Остановить после текущего файла");
    if (items.length - active > 0) chip("queue-clear", "Убрать завершённые", "Очистить список");
    chip(watch?.dir ? "watch-stop" : "watch-pick", watch?.dir ? "Остановить наблюдение" : "Выбрать папку наблюдения", watch?.dir ? "Новые файлы перестанут попадать в очередь" : "Новые файлы будут обрабатываться сами");
    if (failed) honest = "Часть файлов не обработалась. Их лучше открыть по одному в «Конвейере» и посмотреть, на каком этапе остановилось.";
    chip("view:conveyor", "К конвейеру", "Добавить новые файлы");
    return { say, chips, honest };
  }

  if (mode === "quick") {
    if (quick?.error) { say = `Быстрый режим не справился: ${quick.error}`; honest = "Откройте файл в «Конвейере»: там видно, какой этап не прошёл, и можно доделать вручную."; chip("view:conveyor", "Открыть в конвейере", "Пошагово, с выбором пресета"); return { say, chips, honest }; }
    if (quick?.outputDir) { say = `Готово: результат лежит в ${quick.outputDir}.`; chip("reveal", "Показать в папке", quick.outputDir); chip("view:conveyor", "Нужно точнее", "Конвейер с пресетом и проверкой"); return { say, chips, honest }; }
    say = "Быстрый режим: один файл, результат рядом с ним в папке «имя-spritelab». Без проверки и выбора пресета.";
    chip("quick-pick", "Выбрать файл", "Фон уберу сам, атлас соберу, если кадров несколько");
    chip("view:conveyor", "Нужен контроль", "Конвейер с пресетом и Приёмкой");
    return { say, chips, honest };
  }

  // conveyor
  if (!caps) {
    say = "Перетащите файл или папку. Я определю тип по содержимому и покажу только подходящие инструменты.";
    chip("pick-file", "Выбрать файлы", "Видео, GIF, PNG, спрайт-лист, Aseprite, JSON атласа");
    chip("pick-folder", "Выбрать папку кадров", "Каждый файл станет кадром");
    chip("view:quick", "Быстрый режим", "Один файл, без настроек");
    chip("view:queue", "Очередь и наблюдение", "Много файлов или папка, которая пополняется");
    return { say, chips, honest };
  }
  if (!caps.supported) {
    return { say: `Вижу: ${caps.label}.`, chips: [{ id: "pick-file", title: "Выбрать другой файл", detail: "Видео, PNG, GIF, спрайт-лист…" }], honest: caps.message || "С этим типом программа пока не справится." };
  }
  const what = detection?.format === "folder" ? `${caps.label}, ${detection.files?.length || 0} кадров` : caps.label;
  const warn = (detection?.warnings || []).length ? ` Замечу: ${detection.warnings[0]}` : "";

  if (result) {
    if (!result.ok) {
      say = `Конвейер остановился${result.failedStage ? ` на этапе «${result.failedStage}»` : ""}: ${result.error || "ошибка"}.`;
      honest = "Автоматически дальше не пройти. Лучше открыть нужный инструмент и доделать вручную.";
      for (const t of ["split-frames", "slice-sheet", "remove-background", "pack-atlas"]) toolChip(t);
      chip("run", "Повторить", "Тот же пресет");
      return { say, chips: chips.slice(0, 5), honest };
    }
    const review = result.review;
    if (!review) { say = `Готово: ${what}. Результат в ${result.outputDir}. Проверка в этом пресете выключена.`; chip("reveal", "Показать в папке", result.outputDir); toolChip("review"); return { say, chips, honest }; }
    const issues = review.issues || [];
    say = `Готово: ${what}. Приёмка: ${review.verdictLabel || review.verdict}${Number.isFinite(review.score) ? `, ${review.score}/100` : ""}. ${issues.length ? `Замечаний: ${issues.length}.` : "Замечаний нет."}`;
    const manual = [];
    issues.slice(0, 6).forEach((issue, index) => {
      const auto = autoFixFor(issue.fix);
      if (auto) chip(`fix:${index}`, `Исправить: ${issue.reason}`.slice(0, 90), `Пересоберу: ${describeFix(auto)}`);
      else { const tool = manualFor(issue.fix, allowed) || (issue.code === "missing_frame" || issue.code === "near_duplicate" ? (allowed.has("pixel-editor") ? "pixel-editor" : null) : null); manual.push({ issue, tool }); }
    });
    for (const { issue, tool } of manual.slice(0, 2)) {
      if (tool) chip(`tool:${tool}`, `Лучше вручную: ${caps.tools.find((t) => t.id === tool).label}`, issue.reason.slice(0, 90));
    }
    if (manual.length) honest = `${manual.length === 1 ? "Одно замечание" : `${manual.length} замечания`} автоматически не исправлю честно: ${manual[0].issue.reason} Лучше доделать руками.`;
    chip("reveal", "Показать в папке", result.outputDir);
    if (issues.length) chip("review", "Открыть Приёмку", "Все замечания и «Принять всё равно»");
    return { say, chips, honest };
  }

  say = `Вижу: ${what}. «Сделать всё» пройдёт этапы ${caps.stages.filter((s) => s.applies).map((s) => s.label.toLowerCase()).join(" → ")} с пресетом «${preset?.label || "—"}».${warn}`;
  chip("run", "Сделать всё", `Пресет ${preset?.label || ""}, результат рядом с файлом`);
  for (const p of presets.filter((x) => x.id !== "quick" && x.id !== preset?.id).slice(0, 2)) chip(`preset:${p.id}`, `Пресет ${p.label}`, p.pixelArt ? "без сглаживания, отступ 1px" : `форматы: ${(p.atlas?.formats || []).join(", ")}`);
  if (allowed.has("quick")) chip("view:quick", "Быстро, без настроек", "Результат рядом с файлом");
  if (allowed.has("batch")) chip("enqueue", "В очередь", "Каждый файл отдельно, в фоне");
  for (const t of ["split-frames", "slice-sheet", "import-aseprite", "remove-background"]) if (chips.length < 7) toolChip(t);
  if (caps.type === "image") honest = "Одна картинка без кадров: атлас и Приёмку не делаю, только фон, края и экспорт PNG.";
  return { say, chips, honest };
}

// Studio (original tabs): the copilot greets the loaded file and offers what can be done
// with it. Every chip names the capability-map tool it needs; chips for tools that the
// detected type does not have are dropped.

export function studioType(source) {
  if (!source) return null;
  if (source.kind === "video") return "video";
  if (source.kind === "video-batch") return "video-batch";
  if (source.kind === "sheet") return "sprite-sheet";
  const count = source.frameCount || source.paths?.length || 0;
  return count > 1 ? "image-set" : "image";
}

const videoChips = [
  ["vf:split", "split-frames", "Раскадровка", "Каждый кадр — отдельный PNG-спрайт"],
  ["task:background", "remove-background", "Убрать фоны", "Во всех кадрах, с предпросмотром"],
  ["vf:pick", "split-frames", "Вынуть конкретный кадр", "Выбрать кадр ползунком"],
  ["vf:edit", "pixel-editor", "Редактировать кадр", "В Sprite Lab или в Photoshop, Figma, другой программе"],
  ["task:animation", "pack-atlas", "Спрайт-лист целиком", "Все кадры в один лист PNG + JSON"],
  ["vf:cutout", "remove-background", "Кадр с персонажем без фона", "PNG в папку проекта"],
  ["vf:export-frame", "export-png", "Экспортировать 1 кадр", "PNG как есть, без обработки"],
  ["vf:as-is", "export-png", "Сохранить весь файл как есть", "Все кадры одним листом, без удаления фона"],
  ["cv:run", "do-all", "Сделать всё", "Нарезка, фон, атлас, Приёмка, экспорт"],
];

export function planStudioGuide({ source = null, name = "", frame = null, last = null, editors = [] } = {}) {
  const type = studioType(source);
  if (type !== "video" && !frame && !last) return null; // other types keep the original copilot scenarios
  const caps = capabilitiesFor("video");
  const allowed = new Set(caps.tools.map((t) => t.id));
  const keep = (list) => list.filter(([, tool]) => allowed.has(tool)).map(([id, tool, title, detail]) => ({ id, tool, title, detail }));
  const chips = []; let honest = null; let say;
  if (last?.error) { say = `Не получилось: ${last.error}`; honest = last.hint || "Это лучше доделать вручную: откройте вкладку «Обработка» и проверьте настройки."; }
  else if (last?.kind === "baked") { say = `Готово: исправленный кадр ${last.index + 1} вшит в видео ${last.path}.`; if (last.notes?.length) honest = last.notes.join(" "); chips.push({ id: "vf:reveal", tool: "export-png", title: "Показать в папке", detail: last.path }); }
  else if (last?.kind === "cutout") { say = `Сохранил кадр ${last.index + 1} без фона: ${last.path}.`; if (last.empty) honest = "Персонаж почти не виден после удаления фона — фон, похоже, сложный. Лучше открыть кадр в «Обработке» и выбрать ИИ-маску или подправить вручную."; chips.push({ id: "vf:reveal", tool: "export-png", title: "Показать в папке", detail: last.path }); }
  else if (last?.kind === "exported") { say = `Кадр ${last.index + 1} сохранён как есть: ${last.path}.`; chips.push({ id: "vf:reveal", tool: "export-png", title: "Показать в папке", detail: last.path }); }
  if (frame) {
    say ||= frame.savedAt ? `Вижу сохранение кадра ${frame.index + 1}${frame.editor && frame.editor !== "sprite-lab" ? ` из ${frame.editorLabel || frame.editor}` : ""}. Вшить его обратно в видео?` : `Кадр ${frame.index + 1} вынут. Что с ним сделать?`;
    chips.push(...keep([
      ["vf:bake", "split-frames", "Вшить кадр обратно в видео", "Перекодирую, fps и звук сохраню"],
      ["vf:edit-internal", "pixel-editor", "Редактировать в Sprite Lab", "Встроенный редактор кадра"],
    ]));
    for (const e of editors.filter((x) => x.id !== "system")) if (allowed.has("pixel-editor")) chips.push({ id: `vf:edit-external:${e.id}`, tool: "pixel-editor", title: e.id === "custom" ? "Открыть в другой программе" : `Открыть в ${e.label}`, detail: e.configured ? "Слежу за сохранением и заберу кадр" : "Сначала укажу, где программа" });
    if (allowed.has("pixel-editor")) chips.push({ id: "vf:edit-external:system", tool: "pixel-editor", title: "Открыть программой по умолчанию", detail: "Как двойной щелчок по PNG" });
    chips.push(...keep([["vf:cutout", "remove-background", "Сохранить без фона", "PNG в папку проекта"], ["vf:export-frame", "export-png", "Сохранить как есть", "PNG в папку"], ["vf:pick", "split-frames", "Другой кадр", "Вернуться к ползунку"]]));
    if (frame.editor === "figma") honest ||= "Figma не открывает PNG с диска как документ: перетащите кадр в Figma и экспортируйте PNG поверх того же файла — я его подхвачу.";
    return { type: "video", say, chips: chips.slice(0, 9), honest };
  }
  say ||= `Вижу видео${name ? ` (${name})` : ""}. Что сделать?`;
  chips.push(...keep(videoChips));
  return { type, say, chips, honest };
}
