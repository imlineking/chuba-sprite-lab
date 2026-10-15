// Declarative capability map: input type -> tools that make sense for it. The "Конвейер"
// window shows only these tools, so e.g. "Разложить на кадры" never appears for a PNG or PDF.
// Tool ids map to existing features (see `feature`); nothing here runs processing itself.

export const tools = Object.freeze({
  "do-all":            { label: "Сделать всё", group: "main", feature: "conveyor:run (нарезка, фон, упаковка, проверка, экспорт)" },
  "quick":             { label: "Быстрый результат рядом с файлом", group: "main", feature: "conveyor:quick" },
  "split-frames":      { label: "Разложить на кадры", group: "cut", feature: "processor.inspectSource video / animated-images" },
  "trim-time":         { label: "Обрезать по времени", group: "cut", feature: "trimStart / trimEnd" },
  "slice-sheet":       { label: "Нарезать спрайт-лист", group: "cut", feature: "sheet-slicer.sliceSpriteSheet" },
  "import-atlas":      { label: "Импортировать атлас (JSON)", group: "cut", feature: "sheet-metadata.importSheetManifest" },
  "import-aseprite":   { label: "Импортировать слои и теги Aseprite", group: "cut", feature: "aseprite-import.extractAseprite" },
  "remove-background": { label: "Убрать фон", group: "clean", feature: "processor.keyFrame (цвет, авто)" },
  "ai-mask":           { label: "ИИ-маска (BiRefNet / ToonOut)", group: "clean", feature: "ai-segmentation" },
  "edge-cleanup":      { label: "Очистить края", group: "clean", feature: "contour-alpha, edge-cleanup, edge-decontaminate" },
  "inpaint":           { label: "Удалить лишнее (LaMa)", group: "clean", feature: "aux-ai inpaint" },
  "align-frames":      { label: "Выровнять кадры", group: "clean", feature: "frame-consistency, body-anchor" },
  "pixelate":          { label: "Пиксель-арт", group: "style", feature: "pixelate" },
  "color-style":       { label: "Цвет и тонирование", group: "style", feature: "color-adjust, toning" },
  "upscale":           { label: "Увеличить (Real-ESRGAN)", group: "style", feature: "aux-ai upscale" },
  "interpolate":       { label: "Промежуточные кадры (RIFE)", group: "style", feature: "aux-ai interpolate" },
  "depth":             { label: "Карта глубины", group: "style", feature: "aux-ai depth" },
  "pixel-editor":      { label: "Редактор кадра", group: "edit", feature: "sprite-editor, editor-session" },
  "ocr":               { label: "Распознать текст (OCR)", group: "edit", feature: "ocr" },
  "pack-atlas":        { label: "Упаковать в атлас", group: "pack", feature: "pipeline/build, maxrects" },
  "review":            { label: "Проверка (Приёмка)", group: "check", feature: "critic" },
  "export-png":        { label: "Сохранить PNG", group: "export", feature: "processSprites (кадры)" },
  "export-engines":    { label: "Экспорт для движков", group: "export", feature: "pipeline/exporters (Phaser, Godot, Unity, TexturePacker, three)" },
  "export-animated":   { label: "Экспорт GIF / APNG", group: "export", feature: "animated-images" },
  "batch":             { label: "Пакетная очередь", group: "main", feature: "conveyor queue / image-batch" },
  "open-project":      { label: "Открыть проект", group: "main", feature: "project:load-path" },
});

export const toolGroups = Object.freeze({ main: "Главное", cut: "Нарезка", clean: "Очистка", style: "Стиль", edit: "Правка", pack: "Упаковка", check: "Проверка", export: "Экспорт" });

const animation = ["do-all", "quick", "remove-background", "ai-mask", "edge-cleanup", "align-frames", "pixelate", "color-style", "upscale", "interpolate", "depth", "pixel-editor", "pack-atlas", "review", "export-png", "export-engines", "export-animated"];

export const capabilityMap = Object.freeze({
  "video":          { label: "Видео", supported: true, conveyor: ["cut", "clean", "pack", "check", "export"], tools: ["split-frames", "trim-time", ...animation] },
  "video-batch":    { label: "Несколько видео", supported: true, conveyor: ["cut", "clean", "pack", "check", "export"], tools: ["do-all", "batch", "split-frames", "remove-background", "ai-mask", "edge-cleanup", "pixelate", "pack-atlas", "review", "export-png", "export-engines"] },
  "animated-image": { label: "Анимированное изображение (GIF / APNG / WebP)", supported: true, conveyor: ["cut", "clean", "pack", "check", "export"], tools: ["split-frames", ...animation] },
  "image":          { label: "Изображение", supported: true, conveyor: ["clean", "check", "export"], tools: ["review", "do-all", "quick", "remove-background", "ai-mask", "edge-cleanup", "inpaint", "pixelate", "color-style", "upscale", "depth", "pixel-editor", "ocr", "export-png"] },
  "sprite-sheet":   { label: "Спрайт-лист", supported: true, conveyor: ["cut", "clean", "pack", "check", "export"], tools: ["slice-sheet", ...animation, "ocr"] },
  "image-set":      { label: "Несколько изображений", supported: true, conveyor: ["clean", "pack", "check", "export"], tools: ["do-all", "batch", "remove-background", "ai-mask", "edge-cleanup", "align-frames", "pixelate", "color-style", "upscale", "interpolate", "pixel-editor", "pack-atlas", "review", "export-png", "export-engines", "export-animated"] },
  "frames-folder":  { label: "Папка кадров", supported: true, conveyor: ["clean", "pack", "check", "export"], tools: ["do-all", "batch", "remove-background", "ai-mask", "edge-cleanup", "align-frames", "pixelate", "color-style", "upscale", "interpolate", "depth", "pixel-editor", "pack-atlas", "review", "export-png", "export-engines", "export-animated"] },
  "aseprite":       { label: "Документ Aseprite", supported: true, conveyor: ["cut", "pack", "check", "export"], tools: ["do-all", "quick", "import-aseprite", "edge-cleanup", "pixelate", "color-style", "pixel-editor", "pack-atlas", "review", "export-png", "export-engines", "export-animated"] },
  "atlas-json":     { label: "Атлас (JSON)", supported: true, conveyor: ["cut", "pack", "check", "export"], tools: ["do-all", "import-atlas", "pixelate", "pixel-editor", "pack-atlas", "review", "export-png", "export-engines"] },
  "project":        { label: "Проект Sprite Lab", supported: true, conveyor: [], tools: ["open-project"] },
  "pdf":            { label: "PDF", supported: false, conveyor: [], tools: [], message: "PDF пока не поддерживается. Экспортируйте нужные страницы в PNG и перетащите их сюда." },
  "svg":            { label: "SVG", supported: false, conveyor: [], tools: [], message: "Векторный SVG пока не поддерживается. Сохраните его в PNG нужного размера." },
  "psd":            { label: "Photoshop PSD", supported: false, conveyor: [], tools: [], message: "PSD пока не поддерживается. Экспортируйте слои в PNG (Файл > Экспорт > Слои в файлы)." },
  "heic":           { label: "HEIC", supported: false, conveyor: [], tools: [], message: "HEIC пока не поддерживается. Сохраните фото в PNG или JPG." },
  "bmp":            { label: "BMP", supported: false, conveyor: [], tools: [], message: "BMP пока не поддерживается. Сохраните изображение в PNG." },
  "mixed":          { label: "Смешанный набор", supported: false, conveyor: [], tools: [], message: "Видео, изображения и папки нельзя смешивать в одной пачке. Перетащите файлы одного типа или добавьте их в очередь по отдельности." },
  "empty-folder":   { label: "Папка без кадров", supported: false, conveyor: [], tools: [], message: "В папке нет изображений PNG, JPG, WebP, TIFF или AVIF." },
  "unknown":        { label: "Неизвестный файл", supported: false, conveyor: [], tools: [], message: "Не удалось распознать файл. Поддерживаются видео, GIF, APNG, PNG, JPG, WebP, TIFF, AVIF, спрайт-листы, папки кадров, Aseprite и JSON атласов." },
});

export const conveyorStages = Object.freeze([
  { id: "cut", label: "Нарезка" },
  { id: "clean", label: "Очистка фона" },
  { id: "pack", label: "Упаковка" },
  { id: "check", label: "Проверка" },
  { id: "export", label: "Экспорт" },
]);

export function capabilitiesFor(type) {
  const entry = capabilityMap[type] || capabilityMap.unknown;
  const list = entry.tools.map((id) => ({ id, ...tools[id] }));
  const groups = Object.entries(toolGroups).map(([id, label]) => ({ id, label, tools: list.filter((t) => t.group === id) })).filter((g) => g.tools.length);
  const stages = conveyorStages.map((s) => ({ ...s, applies: entry.conveyor.includes(s.id) }));
  return { type: capabilityMap[type] ? type : "unknown", label: entry.label, supported: entry.supported, message: entry.message || null, tools: list, groups, stages };
}

export function hasTool(type, toolId) { return (capabilityMap[type] || capabilityMap.unknown).tools.includes(toolId); }
