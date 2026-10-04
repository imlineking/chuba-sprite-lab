import { deflateSync, inflateSync } from 'node:zlib';
import './text-layer.js';
import { createDocument, addLayer, ensureCel, blendModes } from './sprite-document.mjs';
const { normalize } = globalThis.SpriteLabText;
const maxBytes = 256 * 1024 * 1024;
export function encodeEditorDocument(document, frameIndex) {
  return { format: 'chuba-editable-frame', version: 1, width: document.width, height: document.height,
    layers: document.layers.filter(layer => layer.frameScope == null || layer.frameScope === frameIndex).map(layer => ({ ...layer, frameScope: undefined, pixels: deflateSync(ensureCel(document, layer.id, frameIndex)).toString('base64') })) };
}
export function decodeEditorDocument(value, { width, height, frameIndex = 0 }) {
  if (value?.format !== 'chuba-editable-frame' || value.version !== 1 || value.width !== width || value.height !== height || !Array.isArray(value.layers) || !value.layers.length || value.layers.length > 128 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height * 4 * value.layers.length > maxBytes) throw new Error('Документ слоёв повреждён или не соответствует размеру кадра.');
  const document = createDocument({ width, height, frames: frameIndex + 1 });
  document.layers = []; document.cels.clear();
  for (const record of value.layers) {
    if (typeof record.pixels !== 'string' || record.pixels.length > maxBytes * 2) throw new Error('Повреждён слой кадра.');
    const pixels = inflateSync(Buffer.from(record.pixels, 'base64'), { maxOutputLength: width * height * 4 });
    if (pixels.length !== width * height * 4) throw new Error('Неверный размер пикселей слоя.');
    const layer = addLayer(document, String(record.name || 'Слой').slice(0, 80));
    Object.assign(layer, { visible: record.visible !== false, locked: Boolean(record.locked), opacity: Math.max(0, Math.min(255, Number(record.opacity) || 0)), blendMode: blendModes.includes(record.blendMode) ? record.blendMode : 'normal' });
    if (record.kind === 'text') { layer.kind = 'text'; layer.text = normalize(record.text); if(typeof record.seriesTextId==='string')layer.seriesTextId=record.seriesTextId.slice(0,128); }
    ensureCel(document, layer.id, frameIndex).set(pixels);
  }
  return document;
}
