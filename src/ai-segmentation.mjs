import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as ort from "onnxruntime-node";
import sharp from "sharp";

const INPUT_SIZE = 320;
const MODEL_NAME = "u2netp.onnx";
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
let loadedSession = null;
let loadedModelPath = null;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

async function exists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function resolveAIModel(appRoot) {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, "models", MODEL_NAME) : null,
    path.join(appRoot, "models", MODEL_NAME),
  ].filter(Boolean);
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  throw new Error("Локальная ИИ-модель не найдена. Переустановите Chuba Sprite Lab.");
}

async function getSession(appRoot) {
  const modelPath = await resolveAIModel(appRoot);
  if (loadedSession && loadedModelPath === modelPath) return loadedSession;
  loadedSession = await ort.InferenceSession.create(modelPath, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
    executionMode: "sequential",
    intraOpNumThreads: Math.max(1, Math.min(2, os.cpus().length - 1)),
    interOpNumThreads: 1,
  });
  loadedModelPath = modelPath;
  return loadedSession;
}

export async function segmentSubject(inputPath, { appRoot, cutoff = 50, softness = 0 } = {}) {
  if (!appRoot) throw new Error("Не указан путь к локальной ИИ-модели.");
  const session = await getSession(appRoot);
  const { data: source, info } = await sharp(inputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgb = await sharp(inputPath)
    .removeAlpha()
    .resize(INPUT_SIZE, INPUT_SIZE, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .raw()
    .toBuffer();
  const plane = INPUT_SIZE * INPUT_SIZE;
  const tensorData = new Float32Array(plane * 3);
  for (let index = 0; index < plane; index += 1) {
    tensorData[index] = (rgb[index * 3] / 255 - MEAN[0]) / STD[0];
    tensorData[plane + index] = (rgb[index * 3 + 1] / 255 - MEAN[1]) / STD[1];
    tensorData[plane * 2 + index] = (rgb[index * 3 + 2] / 255 - MEAN[2]) / STD[2];
  }
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const outputs = await session.run({ [inputName]: new ort.Tensor("float32", tensorData, [1, 3, INPUT_SIZE, INPUT_SIZE]) });
  const prediction = outputs[outputName].data;
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const value of prediction) {
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
  }
  const range = Math.max(1e-6, maximum - minimum);
  const smallMask = Buffer.alloc(plane);
  for (let index = 0; index < plane; index += 1) smallMask[index] = Math.round(clamp((prediction[index] - minimum) / range, 0, 1) * 255);
  const { data: mask, info: maskInfo } = await sharp(smallMask, { raw: { width: INPUT_SIZE, height: INPUT_SIZE, channels: 1 } })
    .resize(info.width, info.height, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .extractChannel(0)
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (maskInfo.channels !== 1 || mask.length !== info.width * info.height) {
    throw new Error("ИИ-маска имеет неверный формат. Обработка остановлена без изменения кадра.");
  }

  const alpha = new Uint8Array(info.width * info.height);
  const parsedCutoff = Number(cutoff);
  const threshold = clamp(Number.isFinite(parsedCutoff) ? parsedCutoff : 50, 1, 99) / 100;
  const parsedSoftness = Number(softness);
  const edgeSoftness = clamp(Number.isFinite(parsedSoftness) ? parsedSoftness : 0, 0, 4);
  const hardMask = Buffer.alloc(alpha.length);
  for (let index = 0; index < alpha.length; index += 1) hardMask[index] = mask[index] / 255 >= threshold ? 255 : 0;
  const matteMask = edgeSoftness > 0
    ? await sharp(hardMask, { raw: { width: info.width, height: info.height, channels: 1 } })
      .blur(Math.max(0.3, edgeSoftness * 0.55))
      .extractChannel(0)
      .raw()
      .toBuffer()
    : hardMask;
  for (let index = 0; index < alpha.length; index += 1) {
    const original = source[index * info.channels + 3];
    alpha[index] = Math.round(original * matteMask[index] / 255);
  }
  for (let index = 0; index < alpha.length; index += 1) source[index * info.channels + 3] = alpha[index];
  return { data: source, info };
}

export function resetAISessionForTests() {
  loadedSession = null;
  loadedModelPath = null;
}
