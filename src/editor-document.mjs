import { deflateSync, inflateSync } from 'node:zlib';
import './text-layer.js';
import { createDocument, addLayer, ensureCel, blendModes } from './sprite-document.mjs';
import { quantize, expandIndices,validatePalette } from './document-palette.mjs';
const { normalize } = globalThis.SpriteLabText;
const maxBytes = 256 * 1024 * 1024;
export function encodeEditorDocument(document, frameIndex) {
  return { format: 'chuba-editable-frame', version: 1, width: document.width, height: document.height, colorMode:document.colorMode,palette:document.palette,
    layers: document.layers.filter(layer => layer.frameScope == null || layer.frameScope === frameIndex).map(layer => {const pixels=ensureCel(document,layer.id,frameIndex);return{...layer,frameScope:undefined,...(document.colorMode==='indexed'?{indices:deflateSync(quantize(pixels,document.palette).indices).toString('base64')}:{pixels:deflateSync(pixels).toString('base64')})};}) };
}
export function decodeEditorDocument(value, { width, height, frameIndex = 0 }) {
  if (value?.format !== 'chuba-editable-frame' || value.version !== 1 || value.width !== width || value.height !== height || !Array.isArray(value.layers) || !value.layers.length || value.layers.length > 128 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height * 4 * value.layers.length > maxBytes) throw new Error('Документ слоёв повреждён или не соответствует размеру кадра.');
  const document = createDocument({ width, height, frames: frameIndex + 1 });
  document.colorMode=value.colorMode==='indexed'?'indexed':'rgba';document.palette=value.palette?.length?validatePalette(value.palette):[];
  document.layers = []; document.cels.clear();
  for (const record of value.layers) {
    const encoded=document.colorMode==='indexed'?record.indices:record.pixels;
    if (typeof encoded !== 'string' || encoded.length > maxBytes * 2) throw new Error('Повреждён слой кадра.');
    const raw=inflateSync(Buffer.from(encoded,'base64'),{maxOutputLength:width*height*(document.colorMode==='indexed'?1:4)});
    const pixels = document.colorMode==='indexed'?expandIndices(raw,document.palette):raw;
    if (pixels.length !== width * height * 4) throw new Error('Неверный размер пикселей слоя.');
    const layer = addLayer(document, String(record.name || 'Слой').slice(0, 80));
    Object.assign(layer, { visible: record.visible !== false, locked: Boolean(record.locked), opacity: Math.max(0, Math.min(255, Number(record.opacity) || 0)), blendMode: blendModes.includes(record.blendMode) ? record.blendMode : 'normal' });
    if (record.kind === 'text') { layer.kind = 'text'; layer.text = normalize(record.text); if(typeof record.seriesTextId==='string')layer.seriesTextId=record.seriesTextId.slice(0,128); }
    ensureCel(document, layer.id, frameIndex).set(pixels);
  }
  return document;
}
