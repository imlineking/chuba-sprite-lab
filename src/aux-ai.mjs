import * as ort from "onnxruntime-node";
import sharp from "sharp";

// These four models have different contracts. Keep their tensor conversion in one place
// and reject an unexpected export before it can replace a user's frame.
const clampByte = (value) => Math.max(0, Math.min(255, Math.round(value)));
const tensor = (values, shape) => new ort.Tensor("float32", values, shape);

function assertOutput(output, channels, width, height) {
  if (!output?.data || output.data.length !== channels * width * height) {
    throw new Error(`Модель вернула неожиданный размер: ожидалось ${channels}×${width}×${height}.`);
  }
  for (const value of output.data) if (!Number.isFinite(value)) throw new Error("Модель вернула нечисловые пиксели.");
  return output.data;
}

function rgbPlanes(rgba, width, height, { imagenet = false } = {}) {
  const plane = width * height;
  const values = new Float32Array(plane * 3);
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  for (let index = 0; index < plane; index += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      const colour = rgba[index * 4 + channel] / 255;
      values[channel * plane + index] = imagenet ? (colour - mean[channel]) / std[channel] : colour;
    }
  }
  return values;
}

function rgbaFromPlanes(values, width, height, { range = 1, alpha = null } = {}) {
  const plane = width * height;
  const rgba = Buffer.alloc(plane * 4);
  for (let index = 0; index < plane; index += 1) {
    for (let channel = 0; channel < 3; channel += 1) rgba[index * 4 + channel] = clampByte(values[channel * plane + index] * 255 / range);
    rgba[index * 4 + 3] = alpha ? alpha[index] : 255;
  }
  return rgba;
}

async function readRgba(input, width, height, fit = "fill") {
  const pipeline = sharp(input).ensureAlpha();
  if (width && height) pipeline.resize(width, height, { fit, kernel: "lanczos3" });
  return pipeline.raw().toBuffer({ resolveWithObject: true });
}

async function png(raw, width, height) {
  return sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

export async function loadAuxSession(filePath) {
  return ort.InferenceSession.create(filePath, {
    executionProviders: ["cpu"], graphOptimizationLevel: "all", executionMode: "sequential",
  });
}

export function modelContract(modelId, session) {
  const inputs = session.inputNames || [];
  const outputs = session.outputNames || [];
  const expected = {
    lama: [["image", "mask"], ["output"]],
    rife: [["input", "timestep"], ["output"]],
    "real-esrgan": [["input"], ["output"]],
    "depth-anything-v2": [["pixel_values"], ["predicted_depth"]],
  }[modelId];
  if (!expected || expected[0].some((name) => !inputs.includes(name)) || expected[1].some((name) => !outputs.includes(name))) {
    throw new Error(`Неподдерживаемый ONNX-экспорт ${modelId}: входы ${inputs.join(", ")}, выходы ${outputs.join(", ")}.`);
  }
  return { inputs, outputs };
}

export async function validateAuxSession(modelId, session) {
  modelContract(modelId, session);
  const size = modelId === "lama" ? 512 : modelId === "depth-anything-v2" ? 518 : 32;
  const plane = size * size;
  const image = new Float32Array(plane * (modelId === "rife" ? 6 : 3));
  for (let index = 0; index < plane; index += 1) {
    const value = (index % size) / size;
    for (let channel = 0; channel < image.length / plane; channel += 1) image[channel * plane + index] = value;
  }
  const input = modelId === "lama"
    ? { image: tensor(image, [1, 3, size, size]), mask: tensor(Float32Array.from({ length: plane }, (_, index) => index % size < size / 2 ? 1 : 0), [1, 1, size, size]) }
    : modelId === "rife"
      ? { input: tensor(image, [1, 6, size, size]), timestep: tensor(new Float32Array([0.5]), []) }
      : modelId === "real-esrgan"
        ? { input: tensor(image, [1, 3, size, size]) }
        : { pixel_values: tensor(image, [1, 3, size, size]) };
  const started = Date.now();
  const output = await session.run(input);
  const outputName = modelId === "depth-anything-v2" ? "predicted_depth" : "output";
  const channels = modelId === "depth-anything-v2" ? 1 : 3;
  const outSize = modelId === "real-esrgan" ? size * 4 : size;
  assertOutput(output[outputName], channels, outSize, outSize);
  return { ok: true, inputSize: size, inputName: Object.keys(input).join(" + "), output: outputName, outputLength: output[outputName].data.length, ms: Date.now() - started };
}

// RIFE adds one frame strictly between two original frames. Alpha is blended separately
// because the public model operates on RGB only.
export async function interpolateRife(session, firstPath, secondPath, { phase = 0.5 } = {}) {
  modelContract("rife", session);
  if (!(phase > 0 && phase < 1)) throw new Error("Положение промежуточного кадра должно быть между 0 и 1.");
  const firstInfo = await sharp(firstPath).metadata();
  const width = firstInfo.width; const height = firstInfo.height;
  if (!width || !height || width * height > 1024 * 1024) throw new Error("RIFE поддерживает кадры не крупнее 1024×1024 px.");
  const first = (await readRgba(firstPath, width, height)).data;
  const second = (await readRgba(secondPath, width, height)).data;
  const plane = width * height;
  const data = new Float32Array(plane * 6);
  data.set(rgbPlanes(first, width, height));
  data.set(rgbPlanes(second, width, height), plane * 3);
  const result = await session.run({ input: tensor(data, [1, 6, height, width]), timestep: tensor(new Float32Array([phase]), []) });
  const values = assertOutput(result.output, 3, width, height);
  const alpha = new Uint8Array(plane);
  for (let index = 0; index < plane; index += 1) alpha[index] = clampByte(first[index * 4 + 3] * (1 - phase) + second[index * 4 + 3] * phase);
  return { buffer: await png(rgbaFromPlanes(values, width, height, { alpha }), width, height), width, height };
}

// The compact anime 6B export is dynamic and outputs exactly 4× the input size.
// Overlapping tiles keep each inference bounded. Only the centre of each tile is
// copied into the output, which hides seams at tile boundaries.
export async function upscaleEsrgan(session, inputPath) {
  modelContract("real-esrgan", session);
  const meta = await sharp(inputPath).metadata();
  const width = meta.width; const height = meta.height;
  if (!width || !height || width * height > 1024 * 1024) throw new Error("Real-ESRGAN поддерживает кадры до 1 млн пикселей (выход в 4 раза крупнее).");
  const outWidth = width * 4; const outHeight = height * 4;
  const source = (await readRgba(inputPath, width, height)).data;
  const pieces = [];
  const core = 224; const overlap = 16;
  for (let y = 0; y < height; y += core) for (let x = 0; x < width; x += core) {
    const left = Math.max(0, x - overlap); const top = Math.max(0, y - overlap);
    const right = Math.min(width, x + core + overlap); const bottom = Math.min(height, y + core + overlap);
    const tileWidth = right - left; const tileHeight = bottom - top;
    const tile = await sharp(source, { raw: { width, height, channels: 4 } })
      .extract({ left, top, width: tileWidth, height: tileHeight }).raw().toBuffer();
    const result = await session.run({ input: tensor(rgbPlanes(tile, tileWidth, tileHeight), [1, 3, tileHeight, tileWidth]) });
    const values = assertOutput(result.output, 3, tileWidth * 4, tileHeight * 4);
    const alpha = await sharp(tile, { raw: { width: tileWidth, height: tileHeight, channels: 4 } })
      .extractChannel(3).resize(tileWidth * 4, tileHeight * 4, { kernel: "nearest" }).raw().toBuffer();
    const tilePng = await png(rgbaFromPlanes(values, tileWidth * 4, tileHeight * 4, { alpha }), tileWidth * 4, tileHeight * 4);
    const coreWidth = Math.min(core, width - x) * 4; const coreHeight = Math.min(core, height - y) * 4;
    const cropped = await sharp(tilePng).extract({ left: (x - left) * 4, top: (y - top) * 4, width: coreWidth, height: coreHeight }).png().toBuffer();
    pieces.push({ input: cropped, left: x * 4, top: y * 4 });
  }
  const buffer = await sharp({ create: { width: outWidth, height: outHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(pieces).png().toBuffer();
  return { buffer, width: outWidth, height: outHeight };
}

export async function estimateDepth(session, inputPath) {
  modelContract("depth-anything-v2", session);
  const meta = await sharp(inputPath).metadata();
  const width = meta.width; const height = meta.height;
  if (!width || !height) throw new Error("Не удалось прочитать кадр для карты глубины.");
  const size = 518;
  const source = (await readRgba(inputPath, size, size)).data;
  const result = await session.run({ pixel_values: tensor(rgbPlanes(source, size, size, { imagenet: true }), [1, 3, size, size]) });
  const values = assertOutput(result.predicted_depth, 1, size, size);
  let min = Infinity; let max = -Infinity;
  for (const value of values) { min = Math.min(min, value); max = Math.max(max, value); }
  if (max - min < 1e-6) throw new Error("Модель глубины вернула однотонную карту.");
  const raw = Buffer.alloc(size * size * 4);
  for (let index = 0; index < size * size; index += 1) {
    const gray = clampByte((values[index] - min) / (max - min) * 255);
    raw[index * 4] = gray; raw[index * 4 + 1] = gray; raw[index * 4 + 2] = gray; raw[index * 4 + 3] = 255;
  }
  const map = await sharp(raw, { raw: { width: size, height: size, channels: 4 } }).resize(width, height).png().toBuffer();
  return { buffer: map, width, height, range: [min, max] };
}

// The mask's white pixels are filled; all other pixels stay byte-for-byte from the input.
// An explicit mask is required so a transparent sprite background is never filled by accident.
export async function inpaintLama(session, inputPath, maskPath) {
  modelContract("lama", session);
  if (!maskPath) throw new Error("Для LaMa сначала укажите маску области, которую нужно дорисовать.");
  const meta = await sharp(inputPath).metadata();
  const width = meta.width; const height = meta.height;
  if (!width || !height) throw new Error("Не удалось прочитать кадр для дорисовки.");
  const size = 512;
  const original = (await readRgba(inputPath, width, height)).data;
  const source = (await readRgba(inputPath, size, size)).data;
  const maskNative = await sharp(maskPath).removeAlpha().greyscale().resize(width, height, { fit: "fill", kernel: "nearest" }).raw().toBuffer();
  const maskSmall = await sharp(maskPath).removeAlpha().greyscale().resize(size, size, { fit: "fill", kernel: "nearest" }).raw().toBuffer();
  const maskPlane = Float32Array.from(maskSmall, (value) => value >= 128 ? 1 : 0);
  const pixels = maskPlane.reduce((sum, value) => sum + value, 0);
  if (!pixels || pixels === size * size) throw new Error("Маска LaMa должна выделять часть кадра белым цветом.");
  const result = await session.run({ image: tensor(rgbPlanes(source, size, size), [1, 3, size, size]), mask: tensor(maskPlane, [1, 1, size, size]) });
  const values = assertOutput(result.output, 3, size, size);
  const generated = await sharp(rgbaFromPlanes(values, size, size, { range: 255 }), { raw: { width: size, height: size, channels: 4 } })
    .resize(width, height).raw().toBuffer();
  for (let index = 0; index < width * height; index += 1) {
    if (maskNative[index] < 128) continue;
    const offset = index * 4;
    original[offset] = generated[offset]; original[offset + 1] = generated[offset + 1]; original[offset + 2] = generated[offset + 2]; original[offset + 3] = 255;
  }
  return { buffer: await png(original, width, height), width, height };
}
