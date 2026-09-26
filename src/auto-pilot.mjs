// The auto mode: look at the actual frames, then choose the tool for each job.
//
// This is a rule engine, not a neural network, and that is a deliberate choice: the choice has to be
// explainable ("фон однотонный, модель не нужна"), reproducible, and it has to work with no network.
// Every rule reads a measurement that was taken from the pixels, and every step carries the reason it
// was chosen. A step whose model is missing is reported as blocked rather than silently skipped.
//
// Two halves, both testable without a window:
//   analyseFrame()  — pure measurements over one RGBA buffer;
//   planAutoPilot() — measurements + what is installed -> an ordered plan.

import sharp from "sharp";
import { aiModelCatalog, modelById, modelTotalBytes } from "./ai-models.mjs";
import { checkerMask } from "./region-color.mjs";
import { analyseBorderBackground } from "./background-analysis.mjs";

export const SOFT_ALPHA_LOW = 6;
export const SOFT_ALPHA_HIGH = 249;

// A frame is a photo-like gradient when neighbouring pixels differ a little almost everywhere, and
// drawn art when large areas are exactly equal. Fine detail — fur, hair, thin straps — shows up as a
// large share of pixels sitting on a strong edge, which is what tells the planner to use a matting
// model instead of a plain contour.
const DETAIL_DELTA = 60;
const GRADIENT_PAIR_MAX = 12;

function neighbourStats(data, info) {
  const { width, height } = info;
  let pairs = 0;
  let flat = 0;
  let gradient = 0;
  let visible = 0;
  let detailed = 0;
  const channelDelta = (a, b) => Math.max(
    Math.abs(data[a] - data[b]),
    Math.abs(data[a + 1] - data[b + 1]),
    Math.abs(data[a + 2] - data[b + 2]),
  );
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      if (data[offset + 3] < SOFT_ALPHA_LOW) continue;
      visible += 1;
      let strong = false;
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= width || ny >= height) continue;
        const next = (ny * width + nx) * 4;
        if (data[next + 3] < SOFT_ALPHA_LOW) continue;
        const delta = channelDelta(offset, next);
        pairs += 1;
        if (delta === 0) flat += 1;
        else if (delta <= GRADIENT_PAIR_MAX) gradient += 1;
        if (delta > DETAIL_DELTA) strong = true;
      }
      if (strong) detailed += 1;
    }
  }
  return {
    flatShare: pairs ? flat / pairs : 0,
    gradientShare: pairs ? gradient / pairs : 0,
    detailDensity: visible ? detailed / visible : 0,
  };
}

// One frame, reduced to the numbers the plan needs. Deliberately small and boring: shapes, colour
// variety and the three things that decide the tool — is the background solid, is the edge hairy, and
// is the picture drawn or photographic.
export function analyseFrame(data, info) {
  const { width, height } = info;
  const total = Math.max(1, width * height);
  let opaque = 0;
  let soft = 0;
  let lightSoft = 0;
  let boundary = 0;
  const colours = new Set();
  const borderColours = new Set();
  let borderPixels = 0;
  let borderOpaque = 0;

  // Outside the frame counts as opaque: a frame that is opaque to its own edge is one flat picture,
  // not a shape with a huge perimeter.
  const isOpaque = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return true;
    return data[(y * width + x) * 4 + 3] >= SOFT_ALPHA_HIGH;
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const alpha = data[offset + 3];
      if (alpha >= SOFT_ALPHA_HIGH) {
        opaque += 1;
        colours.add((data[offset] >> 3 << 10) | (data[offset + 1] >> 3 << 5) | (data[offset + 2] >> 3));
        // Perimeter over area: a smooth blob has a small edge, fur and spikes have a large one.
        if (!isOpaque(x - 1, y) || !isOpaque(x + 1, y) || !isOpaque(x, y - 1) || !isOpaque(x, y + 1)) boundary += 1;
      } else if (alpha > SOFT_ALPHA_LOW) {
        soft += 1;
        // The classic keying artefact: a light, almost transparent rim around the sprite.
        if (Math.min(data[offset], data[offset + 1], data[offset + 2]) > 200) lightSoft += 1;
      }
      const onBorder = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      if (onBorder) {
        borderPixels += 1;
        if (alpha >= SOFT_ALPHA_HIGH) {
          borderOpaque += 1;
          borderColours.add((data[offset] >> 3 << 10) | (data[offset + 1] >> 3 << 5) | (data[offset + 2] >> 3));
        }
      }
    }
  }

  const stats = neighbourStats(data, info);
  const border = analyseBorderBackground(data, info);
  return {
    width,
    height,
    opaqueShare: opaque / total,
    softShare: soft / total,
    transparentShare: Math.max(0, total - opaque - soft) / total,
    borderOpaqueRatio: borderPixels ? borderOpaque / borderPixels : 0,
    borderColourCount: borderColours.size,
    colourCount: colours.size,
    thinStructure: opaque ? boundary / opaque : 0,
    outlineComplexity: opaque ? boundary / Math.sqrt(opaque) : 0,
    borderSolidRatio: border.solidRatio,
    borderNoise: border.noise,
    borderColour: border.colour,
    solidBackground: border.solid,
    detailDensity: stats.detailDensity,
    fringeScore: soft ? lightSoft / soft : 0,
    flatShare: stats.flatShare,
    gradientShare: stats.gradientShare,
    hasTransparency: soft + (total - opaque - soft) > 0,
  };
}

function averageNumbers(list, key) {
  const values = list.map((entry) => entry[key]).filter((value) => Number.isFinite(value));
  if (!values.length) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function mergeFrameAnalyses(list) {
  const frames = list.filter(Boolean);
  if (!frames.length) return null;
  const merged = {};
  for (const key of Object.keys(frames[0])) {
    if (typeof frames[0][key] === "boolean") merged[key] = frames.some((frame) => frame[key]);
    else if (key === "width") merged[key] = Math.max(...frames.map((frame) => frame.width));
    else if (key === "height") merged[key] = Math.max(...frames.map((frame) => frame.height));
    else if (key === "colourCount" || key === "borderColourCount") merged[key] = Math.max(...frames.map((frame) => frame[key]));
    else if (key === "borderColour") merged[key] = frames[0][key];
    else if (key === "edgeMeasurement") merged[key] = frames.every(frame => frame[key] === "native") ? "native" : "thumbnail";
    else if (key === "outlineComplexity" && frames.some(frame => frame[key] == null)) merged[key] = null;
    else if (key === "borderSolidRatio") merged[key] = Math.min(...frames.map(frame => frame[key]));
    else merged[key] = averageNumbers(frames, key);
  }
  merged.sampled = frames.length;
  return merged;
}

// Reading a few real frames is what separates this from a guess. The sample is small on purpose: the
// plan only needs shapes and the border, and the user is waiting for it. The *size*, however, must be
// the real one — a 2000 px frame reduced to 192 px for measuring must not look like a small frame, or
// the plan would suggest upscaling something that is already big.
export async function measureSource(paths, { limit = 3, sampleSize = 192 } = {}) {
  const files = (paths || []).filter(Boolean);
  if (!files.length) return null;
  const step = Math.max(1, Math.floor(files.length / limit));
  const chosen = [];
  for (let index = 0; index < files.length && chosen.length < limit; index += step) chosen.push(files[index]);
  const analyses = [];
  const failures = [];
  let fullWidth = 0;
  let fullHeight = 0;
  for (const file of chosen) {
    try {
      const metadata = await sharp(file).metadata();
      if (metadata.width) fullWidth = Math.max(fullWidth, metadata.width);
      if (metadata.height) fullHeight = Math.max(fullHeight, metadata.height);
      const { data, info } = await sharp(file)
        .ensureAlpha()
        .resize({ width: sampleSize, height: sampleSize, fit: "inside", withoutEnlargement: true })
        .raw()
        .toBuffer({ resolveWithObject: true });
      analyses.push(analyseFrame(data, info));
      if (metadata.width * metadata.height <= 16000000) {
        const raw = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        analyses.at(-1).checkerPixels = checkerMask(raw.data, raw.info).count;
        const native = analyseFrame(raw.data, raw.info);
        // Edge decisions use native pixels. Thumbnail resampling creates artificial soft/detail edges.
        for (const metric of ["thinStructure", "outlineComplexity", "softShare", "detailDensity", "fringeScore", "borderSolidRatio", "borderNoise", "borderColour", "solidBackground"]) analyses.at(-1)[metric] = native[metric];
        analyses.at(-1).edgeMeasurement = "native";
      } else {
        analyses.at(-1).edgeMeasurement = "thumbnail";
        analyses.at(-1).outlineComplexity = null;
      }
    } catch (error) {
      failures.push({ file, message: error?.message || "не удалось прочитать кадр" });
    }
  }
  const merged = mergeFrameAnalyses(analyses);
  if (!merged) return null;
  if (fullWidth) merged.width = fullWidth;
  if (fullHeight) merged.height = fullHeight;
  merged.sampledWidth = analyses[0]?.width || 0;
  merged.sampledHeight = analyses[0]?.height || 0;
  merged.frameCount = files.length;
  merged.failures = failures;
  return merged;
}

/* ------------------------------------------------------------------ planning */

// Best first. The first installed entry wins; when nothing is installed the list still names the tool
// the plan would use, so the interface can offer exactly that download.
export const mattingPreference = {
  fine: ["birefnet-hr-matting", "birefnet-general", "birefnet-portrait", "birefnet-tiny", "isnet-general", "isnet-anime", "u2net", "silueta", "u2netp"],
  art: ["isnet-anime", "birefnet-tiny", "isnet-general", "u2net", "silueta", "u2netp"],
  general: ["isnet-general", "birefnet-tiny", "isnet-anime", "u2net", "silueta", "u2netp"],
};

const SOLID_BORDER_RATIO = 0.72;
const SOLID_BORDER_COLOURS = 3;
const HAIRY_STRUCTURE = 0.34;
const HAIRY_SOFT_SHARE = 0.07;
const HAIRY_DETAIL_DENSITY = 0.12;
const FRINGE_SHARE = 0.02;
const ART_FLAT_SHARE = 0.45;
const GRADIENT_DITHER_SHARE = 0.22;

function pickTool(order, installed) {
  const list = order.map((id) => modelById(id)).filter(Boolean);
  return list.find((model) => installed.includes(model.id)) || list[0] || null;
}

// A model on disk is not the same as a step that runs: models whose stage is not wired up yet are
// reported as staged, so the interface never promises work that would not happen.
function statusFor(model, installed) {
  if (!model) return "blocked";
  if (model.readiness !== "ready") return "staged";
  return installed.includes(model.id) ? "ready" : "blocked";
}

function modelStep(model, { installed, title, why, confidence }) {
  return {
    stage: "matting",
    kind: "model",
    tool: model?.id || "u2netp",
    modelId: model?.id || null,
    title: title || `Снять фон моделью ${model?.name || "U²-Net small"}`,
    why,
    confidence,
    status: statusFor(model, installed),
    bytes: model ? modelTotalBytes(model) : 0,
  };
}

function pixelateSettings(measurements, target) {
  const cell = Math.max(8, Math.min(Number(target.cellWidth) || 64, Number(target.cellHeight) || 64));
  const size = Math.max(2, Math.min(8, Math.round(cell / 24)));
  const colors = Math.max(8, Math.min(48, Math.round(measurements.colourCount || 16)));
  const photo = measurements.gradientShare > GRADIENT_DITHER_SHARE;
  const drawn = measurements.flatShare > ART_FLAT_SHARE;
  const mode = drawn ? "clean" : photo ? "shaded" : "outline";
  const dither = photo ? "bayer4" : "none";
  return {
    size,
    colors,
    mode,
    dither,
    palette: "custom",
    why: drawn
      ? `Много ровных заливок (${Math.round(measurements.flatShare * 100)}% соседних пикселей совпадают): стиль «чистый», без дизеринга.`
      : photo
        ? `Плавные переходы (${Math.round(measurements.gradientShare * 100)}%): стиль «плоский тон» с упорядоченным дизерингом, иначе градиент рассыпается.`
        : "Контур важнее заливки: стиль с обводкой.",
    sizeWhy: `Ячейка ${cell} px: блок ${size} px читается как пиксель-арт и не рассыпается.`,
    colorsWhy: `В кадре около ${measurements.colourCount || "—"} цветов — столько и оставляем, без чужой палитры.`,
  };
}

export function planAutoPilot({ measurements, target = {}, source = {}, installed = [] } = {}) {
  if (!measurements) {
    return {
      mode: "auto",
      steps: [],
      needed: [],
      notes: ["Нет кадров для замера: сначала добавьте источник."],
      settings: { provider: "auto", quality: "balanced", modelId: "u2netp" },
    };
  }
  const steps = [];
  const needed = [];
  const notes = [];
  const see = (model, why, kind = "improve") => {
    if (!model || installed.includes(model.id)) return;
    if (needed.some((entry) => entry.id === model.id)) return;
    needed.push({
      id: model.id,
      name: model.name,
      why,
      kind,
      required: kind === "required",
      readiness: model.readiness,
      canDownload: Boolean(model.url),
      page: model.page || null,
      bytes: modelTotalBytes(model),
      licences: model.licence?.name || "",
      commercial: Boolean(model.licence?.commercial),
      note: model.note || "",
    });
  };

  /* 1. Preserve an existing alpha channel before considering background removal. */
  const alreadyTransparent = source.maskPrepared === true || (measurements.transparentShare > 0.15 && measurements.borderOpaqueRatio < 0.2);
  const independent = target.intent === "images" || (source.kind === "images" && !target.cellWidth);
  const checker = Number(measurements.checkerPixels) >= 64;
  const solid = measurements.solidBackground !== undefined
    ? measurements.solidBackground && Number(measurements.borderSolidRatio) >= 0.92
    : measurements.borderOpaqueRatio > SOLID_BORDER_RATIO && measurements.borderColourCount <= SOLID_BORDER_COLOURS;
  if (alreadyTransparent) {
    steps.push({
      stage: "key",
      kind: "builtin",
      tool: "alpha",
      title: "Сохранить прозрачность исходника",
      why: `${Math.round(measurements.transparentShare * 100)}% кадра уже прозрачны, по краям нет сплошного фона. Повторное выделение моделью может испортить готовый контур.`,
      confidence: "high",
      status: "ready",
    });
  } else if (checker) {
    steps.push({ stage: "key", kind: "builtin", tool: "alpha", title: "Сохранить детали изображения", why: "Обнаружена запечённая шахматная подложка: одно удаление белого заденет светлые детали.", confidence: "medium", status: "ready" });
  } else if (solid) {
    steps.push({
      stage: "key",
      kind: "builtin",
      tool: "key",
      title: "Убрать однотонный фон контуром",
      why: `Фон у края почти постоянный${measurements.borderSolidRatio !== undefined ? ` (${Math.round(measurements.borderSolidRatio * 100)}% близких цветов, шум ${Math.round(measurements.borderNoise || 0)})` : ""}. Контурное удаление сохраняет внутренние детали и не требует модели.`,
      confidence: "high",
      status: "ready",
    });
  } else {
    const hairy = measurements.edgeMeasurement !== "thumbnail" && ((measurements.outlineComplexity != null ? measurements.outlineComplexity > 14 : measurements.thinStructure > HAIRY_STRUCTURE)
      || measurements.softShare > HAIRY_SOFT_SHARE
      || measurements.detailDensity > HAIRY_DETAIL_DENSITY);
    const order = independent
      ? ["birefnet-tiny", "isnet-general", "isnet-anime", "u2net", "silueta", "u2netp"]
      : hairy ? mattingPreference.fine : measurements.flatShare > ART_FLAT_SHARE ? mattingPreference.art : mattingPreference.general;
    const chosen = pickTool(order, installed);
    const why = independent
      ? "Фон неоднородный. Для очистки отдельных изображений выбираем компактную установленную модель: она сохраняет исходный холст и не требует загрузки тяжёлой модели для всей очереди."
      : hairy
      ? `Край сложный: длина границы ${measurements.thinStructure.toFixed(2)} от площади, ${Math.round(measurements.softShare * 100)}% полупрозрачных пикселей и плотность мелких деталей ${Math.round(measurements.detailDensity * 100)}% — это мех, волосы или тонкие детали. Нужна модель, обученная на матировании.`
      : `Фон не однотонный (${measurements.borderColourCount} цветов у края) — нужна модель выделения.`;
    steps.push(modelStep(chosen, { installed, why, confidence: hairy ? "high" : "medium" }));
    for (const id of order.slice(0, 3)) see(modelById(id), hairy ? "Лучше держит мех и волосы" : "Ровнее контур, чем у модели в комплекте");
  }

  if (checker && (target.cleanupRequested || independent)) steps.push({ stage: "checker", kind: "builtin", tool: "checker", title: "Убрать псевдопрозрачность", why: "Найдена повторяющаяся светлая клетка в двух направлениях. Удаляем подтверждённый узор; сложные остатки можно ограничить выделением и поправить маску.", confidence: "medium", status: "ready" });
  if (alreadyTransparent) notes.push("Наличие альфа-канала не гарантирует чистый фон: проверьте внутренние просветы на чёрной и зелёной подложке.");

  /* 2. The edge that the model leaves behind. */
  if (measurements.fringeScore > FRINGE_SHARE) {
    steps.push({
      stage: "fringe",
      kind: "builtin",
      tool: "edge-decontaminate",
      title: "Снять ореол фона с мягкого края",
      why: `${Math.round(measurements.fringeScore * 100)}% полупрозрачных пикселей светлые — это остаток фона на кромке. Цвет снимается разложением C = a·F + (1−a)·B.`,
      confidence: "high",
      status: "ready",
    });
  }

  /* 3. A source smaller than its own cell is stretched into mush without an upscaler. */
  const cellWidth = Number(target.cellWidth) || 0;
  const smaller = cellWidth > 0 && Math.max(measurements.width, measurements.height) < cellWidth * 1.25;
  if (smaller && !independent && !target.pixelPerfect) {
    steps.push({
      stage: "upscale",
      kind: "model",
      tool: "real-esrgan",
      modelId: "real-esrgan",
      title: "Увеличить мелкий источник",
      why: `Кадр ${measurements.width}×${measurements.height} меньше ячейки ${cellWidth} px: растяжение размывает край, увеличение с восстановлением сохраняет его.`,
      confidence: "medium",
      status: statusFor(modelById("real-esrgan"), installed),
    });
    see(modelById("real-esrgan"), "Мелкий кадр лучше увеличить до нормализации", "required");
  }

  /* 4. A short video reads as a slideshow. */
  const frameCount = Number(source.frameCount ?? measurements.frameCount ?? 0);
  if (!independent && !target.pixelPerfect && source.kind === "video" && frameCount > 0 && frameCount < 8) {
    steps.push({
      stage: "interpolate",
      kind: "model",
      tool: "rife",
      modelId: "rife",
      title: "Добавить промежуточные кадры",
      why: `В ролике ${frameCount} кадров: движение будет рваным. Интерполяция удваивает их без съёмки заново.`,
      confidence: "medium",
      status: statusFor(modelById("rife"), installed),
    });
    see(modelById("rife"), "Короткому ролику нужны промежуточные кадры", "required");
  }

  if (target.inpaintMaskPath) {
    steps.push({
      stage: "inpaint", kind: "model", tool: "lama", modelId: "lama",
      title: "Дорисовать область по PNG-маске",
      why: "Белая область выбранной маски задаёт точное место правки; остальные пиксели исходника не меняются.",
      confidence: "high", status: statusFor(modelById("lama"), installed),
    });
    see(modelById("lama"), "Для выбранной PNG-маски нужна модель дорисовки", "required");
  }

  if (target.depthRequested) {
    steps.push({
      stage: "depth", kind: "model", tool: "depth-anything-v2", modelId: "depth-anything-v2",
      title: "Сохранить карты глубины",
      why: "Пользователь включил карты глубины для параллакса; они сохраняются отдельными PNG и перечислены в JSON.",
      confidence: "high", status: statusFor(modelById("depth-anything-v2"), installed),
    });
    see(modelById("depth-anything-v2"), "Для карт глубины нужна локальная модель", "required");
  }

  /* 5. Attachments are tracked, not guessed. */
  if (Number(target.attachments) > 0) {
    steps.push({
      stage: "track",
      kind: "builtin",
      tool: "attachment-tracker",
      title: "Отследить привязанные PNG",
      why: `${target.attachments} привязанных файлов: положение ищется по кадру, а не берётся из одного места.`,
      confidence: "high",
      status: "ready",
    });
  }

  /* 6. Pixel art: the style follows what is in the frame, not a preset. */
  if (target.pixelArt) {
    const settings = pixelateSettings(measurements, target);
    steps.push({
      stage: "pixelate",
      kind: "builtin",
      tool: "pixelate",
      title: `Перевести в пиксель-арт: блок ${settings.size} px, ${settings.colors} цветов`,
      why: `${settings.sizeWhy} ${settings.why} ${settings.colorsWhy}`,
      confidence: "medium",
      status: "ready",
      settings: { size: settings.size, colors: settings.colors, mode: settings.mode, dither: settings.dither, palette: settings.palette },
    });
  }

  /* 7. Pages, not one impossible sheet. */
  const count = Math.max(1, frameCount || measurements.frameCount || 1);
  const columns = target.autoColumns === false ? Math.max(1, Math.min(count, Number(target.columns) || 1)) : Math.ceil(Math.sqrt(count));
  const estimated = Math.max(cellWidth * columns, (Number(target.cellHeight) || cellWidth) * Math.ceil(count / columns));
  if (!independent && estimated > Number(target.atlasMaxSize || 0) && Number(target.atlasMaxSize || 0) > 0) {
    steps.push({
      stage: "atlas",
      kind: "builtin",
      tool: "atlas-pages",
      title: "Разложить атлас на страницы",
      why: `Оценка сетки ${columns}×${Math.ceil(count / columns)}: сторона до ${estimated} px при лимите ${target.atlasMaxSize} px. Итоговую раскладку проверим при сборке.`,
      confidence: "high",
      status: "ready",
    });
  }

  /* 8. Always check the result: the inspector is the last word. */
  steps.push({
    stage: "inspect",
    kind: "builtin",
    tool: "atlas-inspector",
    title: independent ? "Проверить размеры отдельных PNG" : "Проверить готовый набор",
    why: independent ? "Сохраняем исходные размеры холста и отдельный PNG для каждого файла. Просветы и светлые детали проверьте на контрастной подложке." : "Координаты, хитбоксы, опора, теги и страницы сверяются с атласом перед записью.",
    confidence: "high",
    status: "ready",
  });

  const heavy = steps.some((step) => ["birefnet-hr-matting", "birefnet-general", "birefnet-portrait"].includes(step.modelId));
  const quality = measurements.width <= 640 && measurements.height <= 640 && !heavy ? "fast" : heavy ? "max" : "balanced";
  const mattingStep = steps.find((step) => step.stage === "matting");
  if (heavy) notes.push("Выбранная модель занимает около 1 ГБ и требует 3–4 ГБ свободной памяти при запуске.");

  return {
    mode: "auto",
    measurements,
    steps,
    needed,
    notes,
    settings: { provider: "auto", quality, modelId: mattingStep?.modelId || "u2netp" },
    summary: checker && (target.cleanupRequested || independent)
      ? "Найдена запечённая клетка: удалим подтверждённый узор, затем проверьте просветы и светлые детали."
      : alreadyTransparent
      ? "Прозрачность уже есть: сохраним исходный контур без повторного выделения моделью."
      : solid
      ? "Фон однотонный: обойдёмся без модели, остальное — очистка края и проверка."
      : `Выбрана модель ${modelById(mattingStep?.modelId)?.name || "U²-Net small"}, качество «${quality}».`,
  };
}

// What the interface needs to draw the model list without asking the main process for every entry.
export function catalogSummary() {
  return aiModelCatalog.map((model) => ({
    id: model.id,
    name: model.name,
    tasks: model.tasks,
    readiness: model.readiness,
    bundled: Boolean(model.bundled),
    file: model.file,
    sizeBytes: model.sizeBytes,
    totalBytes: modelTotalBytes(model),
    url: model.url || null,
    page: model.page || null,
    sha256: model.sha256 || null,
    licence: model.licence,
    speed: model.speed,
    quality: model.quality,
    note: model.note,
  }));
}
