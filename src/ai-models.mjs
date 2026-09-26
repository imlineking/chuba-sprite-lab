// Local AI models the tool can use, and the rules for getting them.
//
// Portable folders include all runnable segmentation and auxiliary models. Future stages
// remain in the catalogue. Source URLs, exact sizes and available digests are recorded
// per export; loading and running a file is checked separately from downloading its bytes.

import { createHash } from "node:crypto";
import { loadAuxSession, validateAuxSession } from "./aux-ai.mjs";

export const downloadHosts = [  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "huggingface.co",
  "cdn-lfs.huggingface.co",
  "cdn-lfs-us-1.huggingface.co",
  "cdn.hf.co",
  "xethub.hf.co",
];

const REMBG_RELEASE = "https://github.com/danielgatis/rembg/releases/download/v0.0.0";

// How a family expects its input. The input size is a fallback: when a downloaded file is inspected,
// the size declared by the model itself wins, so a different export still runs.
export const modelFamilies = {
  u2net: { inputSize: 320, normalisation: "imagenet", output: "alpha-plane", note: "U²-Net: одна карта прозрачности 320×320." },
  isnet: { inputSize: 1024, normalisation: "imagenet", output: "alpha-plane", note: "IS-Net: та же карта, но крупнее вход." },
  birefnet: { inputSize: 1024, normalisation: "imagenet", output: "alpha-plane", note: "BiRefNet: лучшее качество волос и меха, тяжёлая." },
  vitmatte: { inputSize: 1024, normalisation: "imagenet", output: "alpha-plane", note: "ViTMatte: уточняет готовую карту по тримапу." },
  sam: { inputSize: 1024, normalisation: "raw", output: "prompt-mask", note: "SAM: вырезает объект по клику или рамке." },
  lama: { inputSize: 512, normalisation: "raw", output: "image", note: "LaMa: дорисовывает фон вместо убранного объекта." },
  rife: { inputSize: 0, normalisation: "raw", output: "image", note: "RIFE: добавляет промежуточные кадры." },
  esrgan: { inputSize: 0, normalisation: "raw", output: "image", note: "Real-ESRGAN: увеличивает и восстанавливает мелкий источник." },
  depth: { inputSize: 518, normalisation: "raw", output: "depth", note: "Depth Anything: карта глубины для параллакса." },
};

// readiness:
//   ready  — the pipeline can use it today (one image in, one alpha map out);
//   staged — the file installs and validates, the pipeline stage comes later;
//   manual — no verified direct file: the official page is offered instead.
export const aiModelCatalog = [
  {
    id: "u2netp",
    name: "U²-Net small",
    family: "u2net",
    tasks: ["matting"],
    readiness: "ready",
    bundled: true,
    file: "u2netp.onnx",
    sizeBytes: 4574861,
    licence: { name: "Apache-2.0", commercial: true },
    speed: "fast",
    quality: "base",
    note: "В комплекте. Быстрая маска для простого фона, слабее на волосах и мехе.",
  },
  {
    id: "silueta",
    name: "Silueta",
    family: "u2net",
    tasks: ["matting"],
    readiness: "ready",
    file: "silueta.onnx",
    sizeBytes: 44173029,
    url: `${REMBG_RELEASE}/silueta.onnx`,
    licence: { name: "Apache-2.0", commercial: true, note: "производная U²-Net" },
    speed: "fast",
    quality: "base",
    note: "Та же семья, что u2netp, но заметно аккуратнее по краю.",
  },
  {
    id: "u2net",
    name: "U²-Net",
    family: "u2net",
    tasks: ["matting"],
    readiness: "ready",
    file: "u2net.onnx",
    sizeBytes: 175997641,
    url: `${REMBG_RELEASE}/u2net.onnx`,
    licence: { name: "Apache-2.0", commercial: true },
    speed: "medium",
    quality: "good",
    note: "Полная версия: ровнее держит тонкие детали, чем u2netp, при том же входе.",
  },
  {
    id: "u2net-portrait",
    name: "U²-Net portrait matting",
    family: "u2net",
    tasks: ["matting", "matting-portrait"],
    readiness: "ready",
    file: "u2net-portrait-matting.onnx",
    sizeBytes: 175994013,
    url: `${REMBG_RELEASE}/u2net-portrait-matting.onnx`,
    licence: { name: "Apache-2.0", commercial: true },
    speed: "medium",
    quality: "good",
    note: "Обучена на портретах: хороша для лица и плеч персонажа, хуже для предметов.",
  },
  {
    id: "isnet-general",
    name: "IS-Net general",
    family: "isnet",
    tasks: ["matting"],
    readiness: "ready",
    file: "isnet-general-use.onnx",
    sizeBytes: 178648008,
    url: `${REMBG_RELEASE}/isnet-general-use.onnx`,
    licence: { name: "MIT / Apache-2.0", commercial: true, note: "DIS, Xuebin Qin; обе лицензии разрешают коммерческое использование" },
    speed: "medium",
    quality: "high",
    note: "Заметно чище по контуру, чем U²-Net, и лучше держит мелкие отдельные части.",
  },
  {
    id: "isnet-anime",
    name: "IS-Net anime",
    family: "isnet",
    tasks: ["matting", "matting-art"],
    readiness: "ready",
    file: "isnet-anime.onnx",
    sizeBytes: 176069933,
    url: `${REMBG_RELEASE}/isnet-anime.onnx`,
    licence: { name: "MIT / Apache-2.0", commercial: true, note: "DIS, Xuebin Qin" },
    speed: "medium",
    quality: "high",
    note: "Обучена на рисованных кадрах: ровный край на контуре и заливках, без «фотографичного» шума.",
  },
  {
    id: "birefnet-tiny",
    name: "BiRefNet tiny",
    family: "birefnet",
    tasks: ["matting", "matting-fine"],
    readiness: "ready",
    file: "BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx",
    sizeBytes: 224005088,
    url: `${REMBG_RELEASE}/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx`,
    licence: { name: "MIT", commercial: true },
    speed: "medium",
    quality: "high",
    note: "BiRefNet в облегчённом варианте: лучшее соотношение качества и размера среди тяжёлых.",
  },
  {
    id: "birefnet-general",
    name: "BiRefNet general",
    family: "birefnet",
    tasks: ["matting", "matting-fine"],
    readiness: "ready",
    file: "BiRefNet-general-epoch_244.onnx",
    sizeBytes: 972666916,
    url: `${REMBG_RELEASE}/BiRefNet-general-epoch_244.onnx`,
    licence: { name: "MIT", commercial: true },
    speed: "slow",
    quality: "best",
    note: "Лучшая универсальная маска: мех, волосы, тонкие шнуры. Нужно около 3 ГБ свободной памяти.",
  },
  {
    id: "birefnet-hr-matting",
    name: "BiRefNet HR matting",
    family: "birefnet",
    tasks: ["matting-fine"],
    readiness: "ready",
    file: "BiRefNet_HR-matting-epoch_135.onnx",
    sizeBytes: 1098928867,
    url: `${REMBG_RELEASE}/BiRefNet_HR-matting-epoch_135.onnx`,
    licence: { name: "MIT", commercial: true },
    speed: "slow",
    quality: "best",
    note: "Специально для матирования: снимает полупрозрачную кайму по меху и волосам лучше всех в списке.",
  },
  {
    id: "birefnet-portrait",
    name: "BiRefNet portrait",
    family: "birefnet",
    tasks: ["matting-fine", "matting-portrait"],
    readiness: "ready",
    file: "BiRefNet-portrait-epoch_150.onnx",
    sizeBytes: 972666916,
    url: `${REMBG_RELEASE}/BiRefNet-portrait-epoch_150.onnx`,
    licence: { name: "MIT", commercial: true },
    speed: "slow",
    quality: "best",
    note: "Портретный вариант: лицо, шея, плечи, волосы.",
  },
  {
    id: "vitmatte-small",
    name: "ViTMatte small",
    family: "vitmatte",
    tasks: ["matting-fine"],
    readiness: "staged",
    file: "vitmatte-small-composition-1k.onnx",
    sizeBytes: 114423212,
    url: `${REMBG_RELEASE}/vitmatte-small-composition-1k.onnx`,
    sha256: "659b9bb2870f80cffbe20dae4c7f18417fbdf68c0195861d24e9082c28373a24",
    licence: { name: "Apache-2.0", commercial: true },
    speed: "fast",
    quality: "high",
    note: "Уточняет уже готовую маску по тримапу. Этап в конвейере появится после очереди редактора.",
  },
  {
    id: "vitmatte-base",
    name: "ViTMatte base",
    family: "vitmatte",
    tasks: ["matting-fine"],
    readiness: "staged",
    file: "vitmatte-base-composition-1k.onnx",
    sizeBytes: 397910545,
    url: `${REMBG_RELEASE}/vitmatte-base-composition-1k.onnx`,
    sha256: "87bb10979f816061497ba6867b338c65a05cebd7d1507f6dde92a86382dec1f2",
    licence: { name: "Apache-2.0", commercial: true },
    speed: "medium",
    quality: "best",
    note: "Точнее мелкой версии, вдвое тяжелее. Тот же тримап-подход.",
  },
  {
    id: "mobile-sam",
    name: "MobileSAM",
    family: "sam",
    tasks: ["cutout"],
    readiness: "staged",
    file: "mobile_sam.encoder.quant.onnx",
    extraFiles: [{ file: "sam_vit_b_01ec64.decoder.quant.onnx", sizeBytes: 8742591, url: `${REMBG_RELEASE}/sam_vit_b_01ec64.decoder.quant.onnx` }],
    sizeBytes: 11050106,
    url: `${REMBG_RELEASE}/mobile_sam.encoder.quant.onnx`,
    licence: { name: "Apache-2.0", commercial: true },
    speed: "fast",
    quality: "good",
    note: "Вырезает объект по клику: два файла — кодировщик и декодер, всего 20 МБ.",
  },
  {
    id: "sam-vit-b",
    name: "SAM ViT-B",
    family: "sam",
    tasks: ["cutout"],
    readiness: "staged",
    file: "vit_b-encoder-quant.onnx",
    extraFiles: [{ file: "vit_b-decoder-quant.onnx", sizeBytes: 8742591, url: `${REMBG_RELEASE}/vit_b-decoder-quant.onnx` }],
    sizeBytes: 99827815,
    url: `${REMBG_RELEASE}/vit_b-encoder-quant.onnx`,
    licence: { name: "Apache-2.0", commercial: true },
    speed: "medium",
    quality: "best",
    note: "Полноразмерная SAM: точнее на пересечениях объектов, тяжелее и медленнее MobileSAM.",
  },
  {
    id: "lama",
    bundled: true,
    name: "LaMa",
    family: "lama",
    tasks: ["inpaint"],
    readiness: "ready",
    file: "lama_fp32.onnx",
    sizeBytes: 208044816,
    sha256: "1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6",
    url: "https://huggingface.co/sapienkit/LaMa-ONNX/resolve/main/lama_fp32.onnx",
    page: "https://huggingface.co/sapienkit/LaMa-ONNX",
    licence: { name: "Apache-2.0", commercial: true },
    speed: "medium",
    quality: "best",
    note: "В комплекте, работает офлайн. Дорисовывает область, нарисованную белым на маске; исходный кадр сохраняется.",
  },
  {
    id: "rife",
    bundled: true,
    name: "RIFE",
    family: "rife",
    tasks: ["interpolate"],
    readiness: "ready",
    file: "RIFE_fp32_timestep.onnx",
    sizeBytes: 21604567,
    sha256: "4da60c1f20d42dba4f21503140940aa48a488585ead977532bf22e95a0319327",
    url: "https://huggingface.co/walterlow/RIFE_fp32_timestep/resolve/main/RIFE_fp32_timestep.onnx",
    page: "https://huggingface.co/walterlow/RIFE_fp32_timestep",
    licence: { name: "MIT", commercial: true },
    speed: "fast",
    quality: "good",
    note: "Строит промежуточный кадр между соседними кадрами; учитывает выбранный момент между ними.",
  },
  {
    id: "real-esrgan",
    bundled: true,
    name: "Real-ESRGAN anime 6B",
    family: "esrgan",
    tasks: ["upscale"],
    readiness: "ready",
    file: "realesrgan-x4plus.onnx",
    sizeBytes: 18406820,
    sha256: "82f458db35dd94f2200f9a32fd0232c581da861c1b2e5c956d5574b0e9c5aea2",
    url: "https://huggingface.co/mhmtaufiq/realesrgan-onnx/resolve/main/RealESRGAN_x4plus_anime_6B.onnx",
    page: "https://huggingface.co/mhmtaufiq/realesrgan-onnx",
    licence: { name: "BSD-3-Clause", commercial: true, note: "веса x4plus; аниме-вариант имеет свою лицензию" },
    speed: "medium",
    quality: "high",
    note: "Увеличивает рисованный кадр в 4 раза перед сборкой; компактная аниме-версия модели.",
  },
  {
    id: "depth-anything-v2",
    bundled: true,
    name: "Depth Anything V2 small",
    family: "depth",
    tasks: ["depth"],
    readiness: "ready",
    file: "depth-anything-v2-small.onnx",
    sizeBytes: 27258801,
    sha256: "fcf51f1b230362b28690bb9d1809bf0431f29cad20534e3f589bd7285547f20d",
    url: "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model_quantized.onnx",
    page: "https://huggingface.co/onnx-community/depth-anything-v2-small",
    licence: { name: "Apache-2.0", commercial: true },
    speed: "medium",
    quality: "good",
    note: "Создаёт серую карту относительной глубины выбранного кадра для параллакса.",
  },
].map((model) => ({ ...model, bundled: model.readiness === "ready" }));

// Models that were considered and left out. Keeping the reason in the code is what stops the question
// from being reopened every few months.
export const rejectedModels = [
  {
    id: "rmbg-2.0",
    name: "BRIA RMBG-2.0",
    reason: "Веса под лицензией BRIA: коммерческое использование не разрешено. Приложение распространяется вместе с игрой.",
  },
  {
    id: "codeformer",
    name: "CodeFormer",
    reason: "Лицензия S-Lab разрешает только некоммерческое использование.",
  },
  {
    id: "gfpgan",
    name: "GFPGAN",
    reason: "Лицензия свободная, но модель дорисовывает лицо по-своему. У персонажа утверждённый эталон внешности, поэтому подмена черт недопустима.",
  },
];

export function modelById(id) {
  return aiModelCatalog.find((model) => model.id === id) || null;
}

export function runnableModels() {
  return aiModelCatalog.filter((model) => model.readiness === "ready");
}

export function modelsForTask(task, { onlyRunnable = false } = {}) {
  return aiModelCatalog.filter((model) => model.tasks.includes(task) && (!onlyRunnable || model.readiness === "ready"));
}

// Every file an entry needs, the main one first.
export function modelFiles(model) {
  const files = [{ file: model.file, sizeBytes: model.sizeBytes || 0, url: model.url || null, sha256: model.sha256 || null }];
  for (const extra of model.extraFiles || []) files.push({ ...extra, sha256: extra.sha256 || null });
  return files;
}

export function modelTotalBytes(model) {
  return modelFiles(model).reduce((total, file) => total + (file.sizeBytes || 0), 0);
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} ГБ`;
  if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} МБ`;
  if (value >= 1024) return `${Math.round(value / 1024)} КБ`;
  return `${value} Б`;
}

export function canDownload(model) {
  return Boolean(model && model.readiness === "ready" && !model.bundled && model.url && modelFiles(model).every((file) => file.url));
}

// Only HTTPS from a known host, and only the file types this list actually publishes. A catalogue
// entry is data, but it must not become a way to fetch something else.
export function assertDownloadUrl(url, { redirect = false } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error("Некорректная ссылка на модель.");
  }
  if (parsed.protocol !== "https:") throw new Error("Модель можно скачать только по HTTPS.");
  const host = parsed.hostname.toLowerCase();
  if (!downloadHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
    throw new Error(`Недоверенный источник модели: ${parsed.hostname}.`);
  }
  if (!redirect && !/\.(onnx|bin|pth|safetensors|zip)$/i.test(parsed.pathname)) throw new Error("Ссылка не похожа на файл модели.");
  return parsed.href;
}

export function sha256Of(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// Never invent a hash: a published digest is verified, anything else is recorded on this machine and
// labelled as such, so the interface can tell the two apart.
export function verificationOf(file, { recorded = null } = {}) {
  if (file?.sha256) return { level: "published", sha256: file.sha256 };
  if (recorded) return { level: "recorded", sha256: recorded };
  return { level: "size", sha256: null };
}

/* ------------------------------------------------- inspection and validation */

// The model file itself is the authority on its input size: an export that resizes to 768 instead of
// 1024 must keep working, and a family default must never override what the file declares.
function metadataEntry(metadata, name) {
  if (!metadata) return null;
  if (Array.isArray(metadata)) return metadata.find((entry) => entry?.name === name) || metadata[0] || null;
  return metadata[name] || null;
}

export function readSessionShapes(session) {
  const inputName = session?.inputNames?.[0] || null;
  const outputNames = [...(session?.outputNames || [])];
  const inputMetadata = metadataEntry(session?.inputMetadata, inputName);
  const dimensions = (inputMetadata?.dimensions || inputMetadata?.shape || []).map((value) => Number(value));
  const numeric = dimensions.filter((value) => Number.isFinite(value) && value > 1);
  return {
    inputName,
    outputNames,
    dimensions,
    inputSize: numeric.length >= 2 ? numeric[numeric.length - 1] : null,
  };
}

export function familyInputSize(family) {
  return modelFamilies[family]?.inputSize || 320;
}

const VALIDATION_MEAN = [0.485, 0.456, 0.406];
const VALIDATION_STD = [0.229, 0.224, 0.225];

// A stored file is not a working model. This builds the tensor the family expects, runs one pass on a
// synthetic image and checks the answer is a usable alpha map: right size, finite values, and not one
// flat number. Anything else is reported as a failure with the runtime's own message.
export async function validateModelFile(filePath, { family = "u2net", provider = "cpu" } = {}) {
  const auxiliaryId = { lama: "lama", rife: "rife", esrgan: "real-esrgan", depth: "depth-anything-v2" }[family];
  if (auxiliaryId) {
    const session = await loadAuxSession(filePath);
    try { return await validateAuxSession(auxiliaryId, session); }
    finally { await session.release?.(); }
  }
  const started = Date.now();
  const ort = await import("onnxruntime-node");
  const session = await ort.InferenceSession.create(filePath, {
    executionProviders: [provider],
    graphOptimizationLevel: "all",
    executionMode: "sequential",
  });
  const shapes = readSessionShapes(session);
  const size = shapes.inputSize || familyInputSize(family);
  if (!shapes.inputName) throw new Error("В модели не найден входной тензор.");
  const plane = size * size;
  const data = new Float32Array(plane * 3);
  const normalise = modelFamilies[family]?.normalisation !== "raw";
  for (let index = 0; index < plane; index += 1) {
    const x = index % size;
    const y = Math.floor(index / size);
    // A white square in the middle of a dark field: every matting model answers with two levels.
    const inside = x > size * 0.25 && x < size * 0.75 && y > size * 0.25 && y < size * 0.75;
    const value = inside ? 1 : 0.1;
    for (let channel = 0; channel < 3; channel += 1) {
      const raw = value * 255;
      data[channel * plane + index] = normalise ? (raw / 255 - VALIDATION_MEAN[channel]) / VALIDATION_STD[channel] : raw / 255;
    }
  }
  const tensor = new ort.Tensor("float32", data, [1, 3, size, size]);
  const outputs = await session.run({ [shapes.inputName]: tensor });
  // Pick by shape, not by name: an export may expose d0, output_image or nothing recognisable.
  let chosen = null;
  for (const name of shapes.outputNames.length ? shapes.outputNames : Object.keys(outputs)) {
    const output = outputs[name];
    if (!output || typeof output.data?.length !== "number") continue;
    if (output.data.length === plane) { chosen = { name, data: output.data }; break; }
    if (!chosen || Math.abs(output.data.length - plane) < Math.abs(chosen.data.length - plane)) chosen = { name, data: output.data };
  }
  if (!chosen) throw new Error("Модель не вернула карту размером с кадр.");
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const value of chosen.data) {
    if (!Number.isFinite(value)) throw new Error("Модель вернула нечисловые значения.");
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
  }
  const range = maximum - minimum;
  if (range < 1e-4) throw new Error("Модель вернула одинаковые значения: вероятно, вход не соответствует модели.");
  await session.release?.();
  return {
    ok: true,
    inputSize: size,
    inputName: shapes.inputName,
    output: chosen.name,
    outputLength: chosen.data.length,
    range: [minimum, maximum],
    ms: Date.now() - started,
  };
}
