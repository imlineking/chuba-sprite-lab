import sharp from 'sharp';
import { inpaintLama, loadAuxSession } from './aux-ai.mjs';
import { resolveAuxModel } from './model-paths.mjs';

export function repairMask(pixels, mask, width, height) {
  if (pixels?.length !== width * height * 4 || mask?.length !== width * height) throw new Error('Размер маски надписи не совпадает с кадром.');
  const selected = Uint8Array.from(mask, (v, i) => v && pixels[i * 4 + 3] > 0 ? 1 : 0);
  const count = selected.reduce((a, b) => a + b, 0);
  if (!count || count >= width * height * .8) throw new Error('Выделите только старые буквы: маска должна оставлять фон для восстановления.');
  return selected;
}

// Nearest boundary fill then constrained diffusion. Transparent/background pixels outside
// the explicit lettering mask are never modified and never used as black colour donors.
export function fillLettering(pixels, width, height, mask) {
  const selected = repairMask(pixels, mask, width, height), result = Buffer.from(pixels), known = Uint8Array.from(selected, (v, i) => !v && pixels[i * 4 + 3] > 0 ? 1 : 0);
  const queue = new Int32Array(width * height); let head = 0, tail = 0;
  for (let i = 0; i < known.length; i++) if (known[i]) queue[tail++] = i;
  const neighbors = i => { const x = i % width, y = Math.floor(i / width); return [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1].filter(j => j >= 0); };
  while (head < tail) { const i = queue[head++]; for (const j of neighbors(i)) if (selected[j] && !known[j]) { result.set(result.subarray(i * 4, i * 4 + 3), j * 4); known[j] = 1; queue[tail++] = j; } }
  for (let i = 0; i < selected.length; i++) if (selected[i] && !known[i]) throw new Error('У выделенных букв нет соседнего непрозрачного фона. Уточните маску.');
  const indices = [...selected.keys()].filter(i => selected[i]);
  for (let pass = 0; pass < 60; pass++) {
    const previous = Buffer.from(result);
    for (const i of indices) { const donors = neighbors(i).filter(j => known[j]); for (let k = 0; k < 3; k++) result[i * 4 + k] = Math.round(donors.reduce((sum, j) => sum + previous[j * 4 + k], 0) / donors.length); }
  }
  return result;
}

export async function repairLettering({ pixels, width, height, selection, method = 'neighbors', appRoot, aiModelDirs, resourcesPath, signal }) {
  const mask = repairMask(pixels, selection, width, height); signal?.throwIfAborted();
  if (method === 'neighbors') return { pixels: fillLettering(pixels, width, height, mask), method };
  if (method !== 'lama') throw new Error('Неизвестный способ восстановления надписи.');
  const file = await resolveAuxModel('lama', { appRoot, aiModelDirs, resourcesPath });
  const session = await loadAuxSession(file);
  try {
    const input = await sharp(Buffer.from(pixels), { raw: { width, height, channels: 4 } }).png().toBuffer();
    const maskPNG = await sharp(Buffer.from(mask.map(v => v ? 255 : 0)), { raw: { width, height, channels: 1 } }).png().toBuffer();
    const output = await inpaintLama(session, input, maskPNG);
    signal?.throwIfAborted();
    const repaired = await sharp(output.buffer).ensureAlpha().raw().toBuffer();
    const result = Buffer.from(pixels);
    for (let i = 0; i < mask.length; i++) if (mask[i]) result.set(repaired.subarray(i * 4, i * 4 + 3), i * 4);
    return { pixels: result, method };
  } finally { await session.release(); }
}
