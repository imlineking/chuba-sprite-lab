// Local AI models the tool can use, and the rules for getting them.
//
// The application includes one cutout engine and the distinct working auxiliary functions. Source URLs, exact sizes and available digests are recorded
// per export; loading and running a file is checked separately from downloading its bytes.

import { createHash } from "node:crypto";
import path from "node:path";
import { loadAuxSession, validateAuxSession } from "./aux-ai.mjs";
import { segmentationInput } from "./ai-tensors.mjs";

export const downloadHosts = [  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "huggingface.co",
  "cdn-lfs.huggingface.co",
  "cdn-lfs-us-1.huggingface.co",
  "cdn.hf.co",
  "xethub.hf.co",
];


// How a family expects its input. The input size is a fallback: when a downloaded file is inspected,
// the size declared by the model itself wins, so a different export still runs.
export const modelFamilies = {
  birefnet: { inputSize: 1024, normalisation: "imagenet", output: "alpha-plane", note: "ToonOut: одна карта прозрачности по всему изображению." },
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
    id: "toonout", name: "ToonOut", family: "birefnet",
    tasks: ["matting", "matting-art", "matting-checker"], readiness: "ready",
    file: "toonout.onnx", sizeBytes: 929574435,
    sha256: "b9eec8cc66541c9a55a69986d3b0ca44150cf19ed399f42022ee81edf528f48a",
    page: "https://huggingface.co/joelseytre/toonout",
    source: "https://huggingface.co/joelseytre/toonout/blob/cbf720eca394edcde66b861a8a8c20fbabe9c748/birefnet_finetuned_toonout.pth",
    localExport: true, probabilityOutput: true, wholeImage: true, flattenBackground: "#ffffff",
    licence: { name: "MIT", commercial: true, note: "ToonOut / BiRefNet; официальный checkpoint, локальный ONNX-export; см. docs/TOONOUT.md" },
    speed: "slow", quality: "high",
    note: "Сложная рисованная графика и растительность с запечённой подложкой. Один проход по всему изображению; результат нужно проверить. Не заменяет лёгкую вырезку простого фона и не рисует портреты.",
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
    name: "Увеличение изображения · Real-ESRGAN",
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

// Old projects keep working without reviving retired segmentation engines.
export const retiredMattingModelIds = Object.freeze(["u2netp", "silueta", "u2net", "u2net-portrait", "isnet-general", "isnet-anime", "birefnet-tiny", "birefnet-general", "birefnet-hr-matting", "birefnet-portrait", "vitmatte-small", "vitmatte-base", "mobile-sam", "sam-vit-b"]);
export function resolveMattingModelId(id) {
  if (!id || id === "toonout" || retiredMattingModelIds.includes(id)) return "toonout";
  throw new Error(`Неизвестный способ вырезки: ${id}. Выберите вырезку объекта ToonOut.`);
}

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


// A stored file is not a working model. This builds the tensor the family expects, runs one pass on a
// synthetic image and checks the answer is a usable alpha map: right size, finite values, and not one
// flat number. Anything else is reported as a failure with the runtime's own message.
export async function validateModelFile(filePath, { family = "birefnet", provider = "cpu" } = {}) {
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
  const rgb = Buffer.alloc(plane * 3);
  const normalise = modelFamilies[family]?.normalisation !== "raw";
  const model = aiModelCatalog.find(entry => entry.file === path.basename(filePath));
  for (let index = 0; index < plane; index += 1) {
    const x = index % size;
    const y = Math.floor(index / size);
    // A white square in the middle of a dark field: every matting model answers with two levels.
    const inside = x > size * 0.25 && x < size * 0.75 && y > size * 0.25 && y < size * 0.75;
    const value = inside ? 1 : 0.1;
    for (let channel = 0; channel < 3; channel += 1) {
      rgb[index * 3 + channel] = Math.round(value * 255);
    }
  }
  const data = normalise ? segmentationInput(rgb, model || { family })
    : Float32Array.from({ length: rgb.length }, (_, index) => rgb[(index % plane) * 3 + Math.floor(index / plane)] / 255);
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
