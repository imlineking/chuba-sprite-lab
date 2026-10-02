import sharp from "sharp";

export function validateImageGeometry(value) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Размер изображения: ожидается объект настроек.");
  for (const key of Object.keys(value)) {
    if (!["mode", "width", "height", "kernel", "trimToObject"].includes(key)) throw new Error("Размер изображения: неизвестная настройка " + key + ".");
  }
  const mode = value.mode || "original";
  if (!["original", "trim", "contain", "cover", "stretch"].includes(mode)) throw new Error("Выберите исходный размер, обрезку полей, вписывание, заполнение или растяжение.");
  if (value.trimToObject !== undefined && typeof value.trimToObject !== "boolean") throw new Error("Обрезка прозрачных полей: ожидается true или false.");
  const kernel = value.kernel || "nearest";
  if (!["nearest", "lanczos3"].includes(kernel)) throw new Error("Выберите пиксельный режим без сглаживания или плавное масштабирование.");
  if (["contain", "cover", "stretch"].includes(mode)) {
    for (const dimension of ["width", "height"]) {
      if (!Number.isInteger(value[dimension]) || value[dimension] < 1 || value[dimension] > 4096) throw new Error("Размер изображения: ширина и высота должны быть целыми 1–4096 px.");
    }
  }
  return { mode, kernel, trimToObject: value.trimToObject ?? true, ...(["contain", "cover", "stretch"].includes(mode) ? { width: value.width, height: value.height } : {}) };
}

function contentBounds(data, info) {
  let left = info.width, top = info.height, right = -1, bottom = -1;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    if (!data[(y * info.width + x) * 4 + 3]) continue;
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  return right < 0 ? null : { left, top, width: right - left + 1, height: bottom - top + 1 };
}

// The accepted PNG is the contract: geometry runs before pixelation, on the
// final grid, and the same function serves quick preview and full processing.
export async function applyImageGeometry(keyed, value) {
  const options = validateImageGeometry(value);
  if (!options || options.mode === "original") return keyed;
  const source = await sharp(keyed.buffer).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const bounds = contentBounds(source.data, source.info);
  if (!bounds) throw new Error("Нет непрозрачных пикселей для обрезки или подгонки.");
  const rect = options.mode === "trim" || options.trimToObject ? bounds
    : { left: 0, top: 0, width: source.info.width, height: source.info.height };
  let image = sharp(keyed.buffer).extract(rect);
  if (options.mode !== "trim") {
    image = image.resize(options.width, options.height, {
      fit: options.mode === "stretch" ? "fill" : options.mode,
      position: "centre", kernel: sharp.kernel[options.kernel],
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    });
  }
  const buffer = await image.png().toBuffer();
  const { data, info } = await sharp(buffer).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const scale = options.mode === "trim" ? 1 : (options.mode === "cover" ? Math.max : Math.min)(info.width / rect.width, info.height / rect.height);
  const scaledWidth = options.mode === "stretch" ? info.width : Math.round(rect.width * scale), scaledHeight = options.mode === "stretch" ? info.height : Math.round(rect.height * scale);
  return { ...keyed, buffer, info, bounds: contentBounds(data, info), geometryReport: {
    mode: options.mode, kernel: options.kernel, sourceSize: { width: source.info.width, height: source.info.height },
    pointTransform: { scaleX: scaledWidth / rect.width, scaleY: scaledHeight / rect.height, offsetX: Math.floor((info.width - scaledWidth) / 2) - rect.left * scaledWidth / rect.width, offsetY: Math.floor((info.height - scaledHeight) / 2) - rect.top * scaledHeight / rect.height },
    sourceRect: rect, outputSize: { width: info.width, height: info.height },
    cropped: options.mode === "cover" && rect.width * options.height !== rect.height * options.width,
    stretched: options.mode === "stretch" && rect.width * options.height !== rect.height * options.width,
  } };
}
