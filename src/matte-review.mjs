import sharp from "sharp";

// Inspect the saved RGBA values, never the composited preview. Counts are
// observations, not a decision to erase pale artwork or flatten soft alpha.
export function reviewMatteRgba(data, { width, height, channels }) {
  if (channels !== 4 || data.length !== width * height * 4) throw new Error("Для проверки прозрачности нужен RGBA-кадр.");
  let clear = 0, opaque = 0, partial = 0, palePartial = 0, innerPartial = 0;
  let left = width, top = height, right = -1, bottom = -1, touchesCanvas = false;
  const alpha = (x, y) => data[(y * width + x) * 4 + 3];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = (y * width + x) * 4, value = data[index + 3];
    if (value === 0) { clear++; continue; }
    if (value === 255) opaque++;
    else {
      partial++;
      if (Math.min(data[index], data[index + 1], data[index + 2]) >= 200) palePartial++;
      if (x > 0 && y > 0 && x < width - 1 && y < height - 1 &&
        alpha(x - 1, y) >= 240 && alpha(x + 1, y) >= 240 && alpha(x, y - 1) >= 240 && alpha(x, y + 1) >= 240) innerPartial++;
    }
    if (value >= 8) {
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
      touchesCanvas ||= x === 0 || y === 0 || x === width - 1 || y === height - 1;
    }
  }
  const bounds = right < left ? null : { left, top, width: right - left + 1, height: bottom - top + 1 };
  const contentFraction = bounds ? Math.round((bounds.width * bounds.height / (width * height)) * 100) : 0;
  return { width, height, clear, opaque, partial, palePartial, innerPartial, touchesCanvas, bounds, contentFraction };
}

export async function reviewMatteFile(file) {
  const { data, info } = await sharp(file).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return reviewMatteRgba(data, info);
}
