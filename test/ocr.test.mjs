import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { prepareOCRImage, selectedBounds, recognizeText } from '../src/ocr.mjs';
test('OCR uses selection bounds and excludes pixels outside the mask', async () => {
  const pixels = Buffer.alloc(8 * 6 * 4, 0), selection = new Uint8Array(48); selection[10] = selection[19] = 1;
  assert.deepEqual(selectedBounds(selection, 8, 6), { left: 2, top: 1, width: 2, height: 2 });
  const result = await prepareOCRImage({ pixels, width: 8, height: 6, selection });
  const info = await sharp(result.image).metadata(); assert.equal(info.width, 40); assert.equal(info.height, 40);
  assert.throws(() => selectedBounds(new Uint8Array(48), 8, 6), /Выделите/);
  await assert.rejects(prepareOCRImage({ pixels: Buffer.alloc(1), width: 8, height: 6, selection }), /размер/);
});
test('bundled OCR recognizes English and Cyrillic without a remote language path', { timeout: 45_000 }, async () => {
  const svg = Buffer.from('<svg width="900" height="170"><rect width="100%" height="100%" fill="white"/><text x="25" y="70" font-family="Arial" font-size="48" fill="black">SPRITE LAB 2026</text><text x="25" y="135" font-family="Arial" font-size="48" fill="black">Привет мир</text></svg>');
  const {data, info}=await sharp(svg).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const selection = new Uint8Array(info.width * info.height).fill(1);
  const result = await recognizeText({ pixels: data, width: info.width, height: info.height, selection, langPath: new URL('../vendor/ocr/', import.meta.url).pathname.replace(/^\/(\w:)/,'$1') });
  assert.match(result.text, /SPRITE LAB 2026/); assert.match(result.text, /Привет мир/); assert.ok(result.confidence > 60); assert.ok(result.words.length > 2); assert.equal(result.local,true);
  assert.ok(result.words.every(word => Number.isFinite(word.confidence)));
});
