// Deterministic suggestions for the assistant. No model is involved: every hint is
// derived from data the application already computed, so it appears instantly, works
// offline and never proposes something it cannot justify. A model can be added later on
// top of the same vocabulary of steps.
//
// The module is pure and takes a plain snapshot, which keeps the renderer a classic
// script and keeps these rules testable.

// Steps the interface knows how to apply. Anything outside this list is ignored, so a
// future model cannot invent an action the application cannot validate.
import { hasIssue } from "./diagnostics.mjs";

export const stepOperations = [
  "option", "check", "keyMode", "anchor", "loopMode", "tab", "rebuild", "openConsistency", "openLoopEditor", "chooseOutput", "openModels",
];

const severityRank = { warn: 0, info: 1 };

// The task picker uses the same measured source data as auto mode. A score orders
// plausible workflows; it never claims to know which object the user wants removed.
export function planTaskScenarios(snapshot = {}) {
  const source = snapshot.source || {};
  if (!source.kind) return [];
  const built = snapshot.built || {};
  const ui = snapshot.ui || {};
  const measured = snapshot.aiPlan?.measurements || {};
  const count = Number(source.frameCount || built.frameCount || source.estimatedFrames || 0);
  const opaque = !source.maskPrepared && (Number(source.opaqueImages || 0) > 0 || measured.borderOpaqueRatio > 0.72);
  const inconsistent = Boolean(source.mixedSizes) || hasIssue(built, "silhouette-width-spread", "silhouette-height-spread");
  const clipped = hasIssue(built, "source-edge-touching")
    || (built.atlasIssues || []).some((issue) => /frame-outside|frame-trim-box|hitbox-outside/.test(issue?.code || ""));
  const oneImage = source.kind === "frames" && count === 1;
  const photoLike = measured.gradientShare > 0.16 && measured.flatShare < 0.35;
  const smallDrawing = measured.flatShare > 0.4 && Math.max(Number(measured.width) || 0, Number(measured.height) || 0) < 512;
  const candidates = [];
  const offer = (task, score, why) => candidates.push({ task, score, why });
  if (source.kind === "sheet") {
    offer("layout", 100, `Открыт готовый лист; найдено ${count || "несколько"} объектов. Их можно разнести в отдельные ячейки и записать новые координаты в JSON.`);
    offer("extract", 88, "На листе несколько объектов: выберите один и сохраните его отдельным PNG.");
    offer("objectEdit", 83, "Выберите объект на листе, поправьте его внутри программы или в редакторе и верните в новый атлас.");
    offer("animation", 73, "Если объекты на листе — фазы одного движения, соберите из них анимацию и JSON тайминга.");
    offer("combine", 68, "Если это разные предметы, соберите общий атлас и JSON координат для игры.");
    offer("remove", ui.maskEdits ? 110 : 64, "На готовом листе можно указать лишний объект и убрать его из всей серии после проверки кадров.");
    if (opaque) offer("background", 76, "У края листа найден непрозрачный фон; его можно отделить перед новой раскладкой.");
  } else if (source.kind === "video" || source.kind === "video-batch") {
    offer("animation", 100, "Видео уже содержит последовательность кадров; программа может подготовить атлас и анимацию.");
    offer("remove", ui.maskEdits ? 110 : 72, "В кадре можно указать лишний объект; слежение перенесёт правку на остальные кадры.");
    if (opaque) offer("background", 86, "Кадры непрозрачные; фон нужно отделить, если требуется прозрачный спрайт.");
  } else if (oneImage) {
    offer("edit", 105, "Правьте один файл: очистите фон, запечённую клетку или цвет в выделении и сохраните отдельный PNG исходного размера.");
    if (opaque) offer("cutout", 100, "Один непрозрачный JPG, PNG или WebP: можно отделить главный объект и сохранить прозрачный PNG.");
    offer("stylize", photoLike ? 95 : 86, "Одно изображение можно перевести в пиксель-арт с подобранной палитрой и размером пикселя.");
    if (photoLike) offer("depth", 78, "Фото содержит плавные переходы; отдельная карта глубины пригодится для параллакса.");
    if (smallDrawing && !snapshot.options?.pixelPerfect) offer("upscale", 82, "Небольшой рисунок можно увеличить в 4 раза моделью Real-ESRGAN.");
    if (Math.max(Number(measured.width) || 0, Number(measured.height) || 0) >= 512) {
      offer("layout", 64, "Если файл на самом деле спрайт-лист, можно найти его объекты и разнести по сетке.");
    }
    offer("animation", 70, "Это один кадр. Добавьте другие изображения или видео, если хотите собрать анимацию.");
    offer("combine", 69, "Добавьте изображения других предметов, чтобы собрать один атлас с JSON и уменьшить число файлов.");
    offer("extract", 65, "Если на PNG несколько отдельных объектов, выберите один и сохраните отдельным файлом.");
  } else {
    offer("edit", 120, "Правка изображений: обрезка, цвет в выделении и фон; каждый PNG сохраняется отдельно, без анимации и изменения размеров.");
    offer("batch", 84, "Несколько изображений можно очистить по одному профилю: каждый файл получит отдельный PNG и JSON; исходники останутся на месте.");
    offer("animation", 100, "Анимация — последовательные фазы движения одного объекта или персонажа; получите спрайт-лист и JSON тайминга.");
    offer("combine", 110, "Атлас объектов — разные изображения в одном PNG + JSON с координатами; проигрывание не требуется.");
    offer("remove", ui.maskEdits ? 110 : 55, "Лишний объект можно выделить один раз и найти в соседних кадрах.");
    if (opaque) offer("background", 84, "Часть изображений непрозрачна; стоит проверить удаление фона.");
  }
  if (inconsistent && source.kind !== "frames") offer("edit", 96, "Проверьте контуры и размеры выбранного изображения перед экспортом.");
  if (!snapshot.options?.pixelPerfect && ((inconsistent && source.kind !== "frames") || (source.kind === "sheet" && count > 1))) offer("match", inconsistent ? 97 : 66, "Выберите опорный кадр и точку привязки; помощник предложит масштаб для похожих контуров.");
  if (clipped) offer("clipping", 115, source.kind === "sheet"
    ? "На листе найден кадр у края: проверьте полный контур и пересоберите ячейки с запасом."
    : "Кадр касается края исходника: проверьте его и при необходимости исправьте вручную.");
  const requested = candidates.find(candidate => candidate.task === ui.goal);
  if (requested) requested.score = 1000; // Explicit intent always beats an inferred scenario.
  return candidates.sort((a, b) => b.score - a.score).slice(0, 8).map(({ task, why }, index) => ({ task, why, recommended: index === 0 }));
}

export function planSuggestions(snapshot = {}) {
  const source = snapshot.source || {};
  const built = snapshot.built || null;
  const options = snapshot.options || {};
  const ui = snapshot.ui || {};
  const suggestions = [];
  if (snapshot.ui?.intent === "images") return suggestions;
  const add = (suggestion) => suggestions.push({ severity: "info", ...suggestion });

  // Nothing is built yet: the only useful next step is to see the result.
  if (!built && source.kind) {
    add({
      id: "build-preview",
      title: "Собрать предпросмотр",
      why: "Настройки ещё не применены — результат не с чем сравнить.",
      effect: "Обработает кадры текущими настройками.",
      steps: [{ op: "rebuild" }],
    });
  }

  if (built && ui.resultDirty) {
    add({
      id: "rebuild-stale",
      title: "Пересобрать с новыми настройками",
      why: "После последней сборки настройки менялись, показанное устарело.",
      effect: "Обновит превью и размер листа.",
      steps: [{ op: "rebuild" }],
    });
  }

  const atlas = built?.atlas;
  if (atlas?.exceeds && atlas.applied === "warn") {
    add({
      id: "atlas-over-limit",
      severity: "warn",
      title: "Подогнать лист под лимит",
      why: `Лист ${atlas.naturalWidth}×${atlas.naturalHeight} больше лимита ${atlas.limit} px: часть видеокарт и движков такой атлас не загрузит.`,
      effect: options.pixelPerfect ? "Разделит атлас на страницы, сохранив исходные пиксели." : `Уменьшит кадры до лимита ${atlas.limit} px.`,
      steps: [{ op: "option", control: "atlasOverflow", value: options.pixelPerfect ? "split" : "scale" }, { op: "rebuild" }],
    });
  }

  if (source.kind === "frames" && Number(source.opaqueImages) > 0 && options.keyMode === "alpha") {
    add({
      id: "opaque-images",
      severity: "warn",
      title: "Включить удаление фона",
      why: `${source.opaqueImages} файл(ов) без прозрачности — фон останется в кадре.`,
      effect: "Включит удаление фона и пересоберёт превью.",
      steps: [{ op: "keyMode", value: source.suggestedKeyMode || "auto" }, { op: "rebuild" }],
    });
  }

  if (source.kind === "video" && Number(options.fps) > 16 && Number(source.estimatedFrames) > 240) {
    add({
      id: "video-fps",
      title: "Снизить частоту кадров",
      why: `При ${options.fps} fps ролик даёт около ${source.estimatedFrames} кадров — для игровой анимации это обычно избыточно.`,
      effect: "Поставит 12 fps и пересоберёт.",
      steps: [{ op: "option", control: "fps", value: 12 }, { op: "rebuild" }],
    });
  }

  if (hasIssue(built, "silhouette-width-spread", "silhouette-height-spread") && !options.pixelPerfect) {
    add({
      id: "size-spread",
      title: "Согласовать размер кадров",
      why: "Силуэты в серии отличаются по размеру — объект будет заметно менять масштаб при проигрывании.",
      effect: "Откроет анализ силуэтов и предложенный масштаб.",
      steps: [{ op: "openConsistency" }],
    });
  }

  if (hasIssue(built, "loop-seam")) {
    add({
      id: "loop-seam",
      severity: "warn",
      title: "Проверить стык цикла",
      why: "Соседние кадры на стыке цикла заметно отличаются — при повторе будет рывок.",
      effect: "Покажет тайминг и границы цикла. Для ходьбы обратное проигрывание обычно неверно; режим цикла не меняется.",
      steps: [{ op: "openLoopEditor" }],
    });
  }

  const blocking = (built?.atlasIssues || []).filter((issue) => issue?.severity === "error");
  if (blocking.length) {
    add({
      id: "atlas-issues",
      severity: "warn",
      title: "Разобрать проверку набора",
      why: `${blocking.length} расхождение(й) между JSON и листом: ${blocking[0].message}`,
      effect: "Откроет вкладку экспорта с полным списком.",
      steps: [{ op: "tab", value: "export" }],
    });
  }

  if (options.packing === "grid" && Number(atlas?.width) > 2048) {
    add({
      id: "tight-packing",
      title: "Уплотнить лист",
      why: `Лист ${atlas.width}×${atlas.height} при сеточной упаковке — плотная упаковка обрежет пустые поля.`,
      effect: "Переключит упаковку на плотную и пересоберёт.",
      steps: [{ op: "option", control: "atlasPacking", value: "tight" }, { op: "rebuild" }],
    });
  }

  if (source.kind === "sheet" && options.fitEachFrame) {
    add({
      id: "sheet-fit-each",
      title: "Выключить растягивание кадров",
      why: "Каждый кадр растягивается на всю ячейку, поэтому маленький кадр раздувается сильнее соседних.",
      effect: "Выключит растягивание и пересоберёт.",
      steps: [{ op: "check", control: "sheetFitEach", value: false }, { op: "rebuild" }],
    });
  }

  if (hasIssue(built, "mask-tracking-uncertain")) {
    add({
      id: "mask-uncertain",
      severity: "warn",
      title: "Проверить удаление объекта",
      why: "Умная область не найдена уверенно в части кадров — там мог остаться лишний фрагмент.",
      effect: "Откроет список проблемных кадров.",
      steps: [{ op: "tab", value: "process" }],
    });
  }

  if (built && ui.hasOutputFolder === false) {
    add({
      id: "no-destination",
      title: "Выбрать папку назначения",
      why: "Экспорт невозможен, пока папка не выбрана.",
      effect: "Откроет выбор папки на вкладке экспорта.",
      steps: [{ op: "tab", value: "export" }, { op: "chooseOutput" }],
    });
  }

  const aiControls = { upscale: "auxEsrgan", interpolate: "auxRife", depth: "auxDepth" };
  for (const step of snapshot.aiPlan?.steps || []) {
    if (!step.modelId || !["upscale", "interpolate", "depth", "inpaint"].includes(step.stage)) continue;
    if (options.pixelPerfect && ["upscale", "interpolate"].includes(step.stage)) continue;
    const control = aiControls[step.stage];
    if (step.status === "ready" && control && !options.auxAI?.[{ upscale: "upscale", interpolate: "interpolate", depth: "depth" }[step.stage]]) {
      add({
        id: `ai-${step.stage}`,
        title: step.title,
        why: step.why,
        effect: "Включит этап для следующей сборки. Исходные файлы останутся прежними.",
        steps: [{ op: "tab", value: "process" }, { op: "check", control, value: true }],
      });
    } else if (step.status === "blocked") {
      add({
        id: `ai-install-${step.stage}`,
        title: `Установить ${step.modelId}`,
        why: `${step.why} Модели пока нет на этом компьютере.`,
        effect: "Откроет проверенный каталог моделей.",
        steps: [{ op: "openModels" }],
      });
    }
  }

  return suggestions.sort((left, right) => severityRank[left.severity] - severityRank[right.severity]);
}
