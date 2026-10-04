import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { createWorker, PSM } from 'tesseract.js';

const languages = ['eng', 'rus', 'eng+rus'];
export function selectedBounds(selection, width, height) {
  if (!selection || selection.length !== width * height || !selection.some(Boolean)) throw new Error('Выделите прямоугольником или лассо надпись, которую нужно распознать.');
  let left = width, top = height, right = -1, bottom = -1;
  for (let i = 0; i < selection.length; i++) if (selection[i]) { const x = i % width, y = Math.floor(i / width); left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

export async function prepareOCRImage({ pixels, width, height, selection }) {
  width = Number(width); height = Number(height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 16_777_216 || pixels?.length !== width * height * 4) throw new Error('Недопустимый размер изображения для распознавания.');
  const bounds = selectedBounds(selection, width, height);
  const data = Buffer.from(pixels);
  for (let i = 0; i < selection.length; i++) if (!selection[i]) data.set([255, 255, 255, 255], i * 4);
  const scale = Math.max(1, Math.min(4, 1800 / Math.max(bounds.width, bounds.height)));
  const image = await sharp(data, { raw: { width, height, channels: 4 } }).extract(bounds).flatten({ background: '#ffffff' }).resize(Math.round(bounds.width * scale), Math.round(bounds.height * scale), { kernel: 'lanczos3' }).extend({ top: 16, bottom: 16, left: 16, right: 16, background: '#ffffff' }).png().toBuffer();
  return { image, bounds, scale };
}

export async function recognizeText({ pixels, width, height, selection, language = 'eng+rus', langPath, signal, onProgress }) {
  if (!languages.includes(language)) throw new Error('Выберите русский, английский или оба языка.');
  const manifest = JSON.parse(await fs.readFile(path.join(langPath, 'manifest.json'), 'utf8'));
  for (const lang of language.split('+')) {
    let data;
    try { data = await fs.readFile(path.join(langPath, lang + '.traineddata')); } catch { throw new Error('Локальные данные OCR отсутствуют. Подготовьте языки распознавания.'); }
    if (crypto.createHash('sha256').update(data).digest('hex') !== manifest.sha256[lang]) throw new Error('Данные OCR повреждены. Повторите подготовку языков.');
  }
  signal?.throwIfAborted();
  const prepared = await prepareOCRImage({ pixels, width, height, selection });
  const worker = await createWorker(language, 1, { langPath: path.resolve(langPath), gzip: false, cacheMethod: 'none', logger: progress => onProgress?.({ stage: 'ocr', progress: progress.progress }), errorHandler: () => {} });
  const abort = () => { void worker.terminate(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
    const { data } = await worker.recognize(prepared.image, {}, { text: true, blocks: true });
    signal?.throwIfAborted();
    const words = (data.blocks || []).flatMap(block => block.paragraphs || []).flatMap(paragraph => paragraph.lines || []).flatMap(line => line.words || []).map(word => ({ text: word.text, confidence: word.confidence, bbox: word.bbox }));
    return { text: String(data.text || '').trim(), confidence: Number(data.confidence) || 0, words, bounds: prepared.bounds, language, local: true };
  } finally { signal?.removeEventListener('abort', abort); await worker.terminate(); }
}
