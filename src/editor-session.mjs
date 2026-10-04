// Editing sessions for the built-in pixel editor.
//
// The document itself lives here, in the main process, rather than in the window. Two reasons:
// the window cannot import the .mjs model (the app is loaded over file://, where module scripts are
// blocked), and keeping the pixels on one side means a stroke crosses the process boundary as a
// small rectangle instead of a full canvas copy. The interface only ever holds the composite it
// paints and the list of layers it shows.
//
// Every mutating call answers with the same state shape, so the interface can redraw from one place.

import { randomUUID } from "node:crypto";
import './text-layer.js';
import './brush-engine.js';
import './drawing-shapes.js';
import { transformPixels } from './pixel-transform.mjs';
import { makePalette,quantize,validatePalette } from './document-palette.mjs';
import { encodeEditorDocument, decodeEditorDocument } from './editor-document.mjs';
const textSettings = globalThis.SpriteLabText.normalize;
import {
  addLayer,
  compositeFrame,
  createDocument,
  createHistory,
  ensureCel,
  findLayer,
  floodFill,
  patchFromSnapshot,
  pushPatch,
  readPixel,
  redoPatch,
  removeLayer,
  snapshotCel,
  undoPatch,
} from "./sprite-document.mjs";

import { frameColorPatch, frameAdjustmentPatch } from "./frame-color.mjs";

import { makePixelSelection, moveSelectedPixels } from "./pixel-selection.mjs";
const sessions = new Map();

export const maxEditorSessions = 4;
export const editorHistoryLimit = 80;

function requireSession(sessionId) {
  const session = sessions.get(String(sessionId || ""));
  if (!session) throw new Error("Редактор кадра закрыт или недоступен. Откройте кадр заново.");
  return session;
}

function activeLayer(session) {
  return findLayer(session.document, session.activeLayerId) || session.document.layers.at(-1);
}

function describeLayers(document, frameIndex) {
  return document.layers.filter(layer => layer.frameScope == null || layer.frameScope === frameIndex).map((layer) => ({
    id: layer.id,
    name: layer.name,
    visible: layer.visible,
    locked: layer.locked,
    opacity: layer.opacity,
    blendMode: layer.blendMode,
    kind: layer.kind,
    text: layer.kind === 'text' ? structuredClone(layer.text) : undefined,
    seriesTextId: layer.seriesTextId,
  }));
}

// One state shape for open, paint, fill, undo and layer changes: the window draws the composite and
// rebuilds the panels from the rest, so no operation needs its own update path.
function sessionState(session, extra = {}) {
  if(session.document.colorMode==='indexed')for(const layer of session.document.layers){const cel=session.document.cels.get(layer.id+'#'+session.frameIndex);if(cel)cel.set(quantize(cel,session.document.palette).pixels);}
  const composite = compositeFrame(session.document, session.frameIndex);
  if (session.savedFrames) {
    for(const index of session.checkAllFrames ? (session.frameIndices||[session.frameIndex]) : [session.frameIndex]) {
      const saved = session.savedFrames.get(index), settings = JSON.stringify([describeLayers(session.document,index),session.document.colorMode,session.document.palette]),pixels=index===session.frameIndex?composite:compositeFrame(session.document,index);
      if (!saved || !Buffer.from(pixels).equals(saved.pixels) || settings !== saved.settings || session.document.frames[index].durationMs !== saved.durationMs) session.dirtyFrames.add(index);
      else session.dirtyFrames.delete(index);
    }
    session.checkAllFrames=false;
  }
  return {
    sessionId: session.id,
    name: session.name,
    frameIndex: session.frameIndex,
    width: session.document.width,
    height: session.document.height,
    colorMode:session.document.colorMode,documentPalette:session.document.palette,
    layers: describeLayers(session.document,session.frameIndex),
    activeLayerId: session.activeLayerId,
    selection: session.selection || null,
    canUndo: session.history.undoStack.length > 0,
    canRedo: session.history.redoStack.length > 0,
    composite,
    frameIndices: session.frameIndices || [session.frameIndex],
    durationMs: session.document.frames[session.frameIndex].durationMs,
    dirty: session.dirtyFrames?.size > 0,
    onion: session.onion ? (session.frameIndices || []).filter(i => Math.abs((session.frameIndices || []).indexOf(i) - (session.frameIndices || []).indexOf(session.frameIndex)) === 1).map(i => ({ index: i, composite: compositeFrame(session.document,i) })) : [],
    ...extra,
  };
}

function normalizePoint(value) {
  if (Array.isArray(value) && value.length >= 2) {
    const x = Math.round(Number(value[0]));
    const y = Math.round(Number(value[1]));
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
  }
  if (value && typeof value === "object") return normalizePoint([value.x, value.y]);
  return null;
}

function normalizeColor(value) {
  const source = Array.isArray(value) ? value : [];
  const channels = [0, 1, 2, 3].map((index) => {
    const channel = Number(source[index]);
    return Number.isFinite(channel) ? Math.max(0, Math.min(255, Math.round(channel))) : null;
  });
  return [
    channels[0] ?? 0,
    channels[1] ?? 0,
    channels[2] ?? 0,
    channels[3] ?? 255,
  ];
}

function normalizeBrushSize(value) {
  const size = Math.round(Number(value));
  if (!Number.isFinite(size)) return 1;
  return Math.max(1, Math.min(64, size));
}

function normalizeTolerance(value) {
  const tolerance = Math.round(Number(value));
  if (!Number.isFinite(tolerance)) return 0;
  return Math.max(0, Math.min(255, tolerance));
}

// Runs one drawing command and records the difference it made as a single undo step. The snapshot is
// taken before the command, so a whole mouse stroke collapses into one patch.
function applyCommand(session, label, command, constrain = true) {
  const layer = activeLayer(session);
  if (!layer) return sessionState(session);
  if (layer.locked) return sessionState(session, { blocked: `Слой «${layer.name}» заблокирован.` });
  if (layer.kind === 'text') return sessionState(session, { blocked: 'Это текстовый слой. Измените надпись или нажмите «В пиксели» перед рисованием.' });
  const before = snapshotCel(session.document, layer.id, session.frameIndex);
  const selectionBefore = session.selection ? Uint8Array.from(session.selection) : null;
  const touched = command(layer);
  if (constrain && selectionBefore) {
    const cel = ensureCel(session.document, layer.id, session.frameIndex);
    for (let i = 0; i < selectionBefore.length; i++) if (!selectionBefore[i]) cel.set(before.subarray(i * 4, i * 4 + 4), i * 4);
  }
  if (!touched) return sessionState(session);
  const patch = patchFromSnapshot(session.document, layer.id, session.frameIndex, before, label);
  if (patch) {
    patch.selectionBefore = selectionBefore; patch.selectionAfter = session.selection ? Uint8Array.from(session.selection) : null;
    pushPatch(session.history, session.document, patch);
  }
  return sessionState(session, { label });
}

export function openSession({ width, height, name = "Кадр", frameIndex = 0, pixels = null, editableDocument = null } = {}) {
  // The document uses the source frame number as its own frame index, so a later version can hold
  // several frames of one character without moving any pixels around.
  const frameNumber = Math.max(0, Math.round(Number(frameIndex) || 0));
  const document = editableDocument ? decodeEditorDocument(editableDocument, { width, height, frameIndex: frameNumber }) : createDocument({ width, height, frames: frameNumber + 1 });
  const base = document.layers[0];
  if (!editableDocument) base.name = "Кадр";
  if (editableDocument && pixels && !Buffer.from(compositeFrame(document, frameNumber)).equals(Buffer.from(pixels))) throw new Error('Пиксели файла изменились после сохранения слоёв. Откройте изменённый PNG как новый кадр.');
  if (pixels && !editableDocument) {
    const cel = ensureCel(document, base.id, frameNumber);
    const source = pixels instanceof Uint8ClampedArray ? pixels : new Uint8ClampedArray(pixels);
    cel.set(source.subarray(0, Math.min(cel.length, source.length)));
  }
  const session = {
    id: randomUUID(),
    name: String(name || "Кадр"),
    frameIndex: frameNumber,
    document,
    history: createHistory({ limit: editorHistoryLimit }),
    activeLayerId: document.layers.at(-1).id,
    createdAt: Date.now(),
  };
  sessions.set(session.id, session);
  while (sessions.size > maxEditorSessions) sessions.delete(sessions.keys().next().value);
  return sessionState(session);
}

export function markSessionSaved(sessionId) {
  const session = requireSession(sessionId); session.savedFrames = new Map(); session.dirtyFrames = new Set();
  for (const i of session.frameIndices || [session.frameIndex]) session.savedFrames.set(i, { pixels: Buffer.from(compositeFrame(session.document,i)), settings: JSON.stringify([describeLayers(session.document,i),session.document.colorMode,session.document.palette]), durationMs: session.document.frames[i].durationMs });
  return sessionState(session);
}
export function openSeries({ frames, frameIndex = 0, name = 'Серия' }) {
  if (!Array.isArray(frames) || !frames.length || frames.length > 512) throw new Error('Редактор серии принимает от 1 до 512 кадров.');
  const indices = frames.map(f=>Number(f.index));
  if (new Set(indices).size !== indices.length || indices.some(i=>!Number.isInteger(i)||i<0||i>19999)) throw new Error('Недопустимые номера кадров.');
  const width=Math.max(...frames.map(f=>f.width)),height=Math.max(...frames.map(f=>f.height));
  if (width*height*4*frames.length>256*1024*1024) throw new Error('Серия превышает 256 МБ пикселей. Разделите её на несколько анимаций.');
  const state=openSession({width,height,frameIndex:indices.includes(frameIndex)?frameIndex:indices[0],name}),session=requireSession(state.sessionId),document=session.document;
  document.layers=[];document.cels.clear();document.frames=Array.from({length:Math.max(...indices)+1},()=>({durationMs:100}));session.frameIndices=indices;
  for (const frame of frames) {
    if(frame.pixels?.length!==frame.width*frame.height*4)throw new Error('Повреждены пиксели кадра.');
    const decoded=frame.editableDocument?decodeEditorDocument(frame.editableDocument,{width:frame.width,height:frame.height,frameIndex:frame.index}):null;
    if(decoded&&!Buffer.from(compositeFrame(decoded,frame.index)).equals(Buffer.from(frame.pixels)))throw new Error('PNG изменился после сохранения слоёв.');
    const layers=decoded?decoded.layers:[{name:'Кадр '+(frame.index+1),visible:true,locked:false,opacity:255,blendMode:'normal',kind:'normal'}];
    for(const original of layers){const layer=original.seriesTextId?document.layers.find(l=>l.seriesTextId===original.seriesTextId)||addLayer(document,original.name):addLayer(document,original.name);const id=layer.id;Object.assign(layer,structuredClone(original),{id,frameScope:original.seriesTextId?null:frame.index});const source=decoded?ensureCel(decoded,original.id,frame.index):frame.pixels,cel=ensureCel(document,id,frame.index);for(let y=0;y<frame.height;y++)cel.set(source.subarray(y*frame.width*4,(y+1)*frame.width*4),y*width*4);}
    document.frames[frame.index].durationMs=Math.max(10,Math.min(10000,Math.round(Number(frame.durationMs)||100)));
  }
  const indexed=frames.every(f=>f.editableDocument?.colorMode==='indexed'&&JSON.stringify(f.editableDocument.palette)===JSON.stringify(frames[0].editableDocument.palette));
  if(indexed){document.colorMode='indexed';document.palette=validatePalette(frames[0].editableDocument.palette);}
  document.layers.sort((a,b)=>Number(Boolean(a.seriesTextId))-Number(Boolean(b.seriesTextId)));
  session.activeLayerId=describeLayers(document,session.frameIndex).at(-1).id; return markSessionSaved(session.id);
}
export function switchFrame(sessionId, { frameIndex, durationMs, onion } = {}) {
  const session=requireSession(sessionId);finishStroke(sessionId);
  if(onion!=null)session.onion=Boolean(onion);
  if(frameIndex!=null){if(!(session.frameIndices||[session.frameIndex]).includes(Number(frameIndex)))throw new Error('Кадр серии не найден.');session.frameIndex=Number(frameIndex);session.selection=null;session.activeLayerId=describeLayers(session.document,session.frameIndex).at(-1).id;}
  if(durationMs!=null){const duration=Math.round(Number(durationMs));if(!Number.isFinite(duration)||duration<10||duration>10000)throw new Error('Длительность кадра: от 10 до 10000 мс.');const before=session.document.frames[session.frameIndex].durationMs;if(before!==duration){session.document.frames[session.frameIndex].durationMs=duration;pushPatch(session.history,session.document,{label:'Длительность кадра',parts:[],frameDurations:[{index:session.frameIndex,before,after:duration}]});}}
  return sessionState(session);
}
export function exportSeries(sessionId) {
  const session=requireSession(sessionId);finishStroke(sessionId);
  return (session.frameIndices||[session.frameIndex]).map(index=>({frameIndex:index,width:session.document.width,height:session.document.height,composite:compositeFrame(session.document,index),durationMs:session.document.frames[index].durationMs,editableDocument:encodeEditorDocument(session.document,index)}));
}
export function paletteDocument(sessionId,options={}){
  const session=requireSession(sessionId),before=structuredClone(session.document),after=structuredClone(before);let changed=0;
  if(options.mode==='rgba')after.colorMode='rgba';
  else if(options.replaceIndex!=null){
    if(before.colorMode!=='indexed')throw new Error('Сначала преобразуйте документ в индексированный режим.');
    const index=Number(options.replaceIndex);if(!Number.isInteger(index)||index<0||index>=after.palette.length)throw new Error('Цвет палитры не найден.');
    const palette=validatePalette(after.palette),replacement=normalizeColor(options.color);palette[index]=replacement;
    for(const [key,cel]of after.cels){const result=quantize(cel,before.palette);for(let i=0;i<result.indices.length;i++)if(result.indices[i]===index){cel.set(replacement,i*4);changed++;}after.cels.set(key,cel);}after.palette=palette;
  }else{
    after.palette=options.palette?validatePalette(options.palette):makePalette([...after.cels.values()],options.limit||32);after.colorMode='indexed';
    for(const [key,cel]of after.cels){const result=quantize(cel,after.palette);changed+=result.changed;after.cels.set(key,result.pixels);}
    for(const layer of after.layers)if(layer.kind==='text'){layer.kind='normal';delete layer.text;delete layer.seriesTextId;}
  }
  if(options.preview)return{composite:compositeFrame(after,session.frameIndex),palette:after.palette,colorMode:after.colorMode,changed};
  pushPatch(session.history,session.document,{label:'Палитра документа',frameIndex:session.frameIndex,documentStates:{before,after}});session.checkAllFrames=true;return sessionState(session);
}
export function textAcrossFrames(sessionId) {
  const session=requireSession(sessionId),layer=activeLayer(session);
  if(layer.kind!=='text'||layer.locked)throw new Error('Выберите незаблокированный текстовый слой.');
  const beforeLayer=structuredClone(layer),pixels=snapshotCel(session.document,layer.id,session.frameIndex),parts=[];
  for(const index of session.frameIndices||[session.frameIndex]){const before=snapshotCel(session.document,layer.id,index);ensureCel(session.document,layer.id,index).set(pixels);const part=patchFromSnapshot(session.document,layer.id,index,before);if(part)parts.push(part);session.dirtyFrames?.add(index);}
  layer.frameScope=null;layer.seriesTextId ||= randomUUID();session.checkAllFrames=true;pushPatch(session.history,session.document,{label:'Надпись на всей серии',parts,frameIndex:session.frameIndex,layerUpdates:[{id:layer.id,before:beforeLayer,after:structuredClone(layer)}]});return sessionState(session);
}

export function finishStroke(sessionId) {
  const session = requireSession(sessionId), stroke = session.stroke;
  if (!stroke) return sessionState(session);
  const patch = patchFromSnapshot(session.document, stroke.layerId, stroke.frameIndex, stroke.before, stroke.options.erase ? 'Ластик' : 'Карандаш');
  if (patch) { patch.selectionBefore = stroke.selection; patch.selectionAfter = stroke.selection; pushPatch(session.history, session.document, patch); }
  session.stroke = null; return sessionState(session, { label: patch?.label });
}
function shapePixels(sessionId,options) {
  const source=exportActivePixels(sessionId),from=normalizePoint(options.from),to=normalizePoint(options.to);
  if(!from||!to)throw new Error('Укажите начало и конец фигуры.');
  for(const p of[from,to]){p[0]=Math.max(0,Math.min(source.width-1,p[0]));p[1]=Math.max(0,Math.min(source.height-1,p[1]));}
  const points=globalThis.SpriteLabShapes.points(options.kind,from,to,Boolean(options.filled)),pixels=globalThis.SpriteLabBrush.stroke(source.pixels,source.width,source.height,{...options,points,color:normalizeColor(options.color),size:normalizeBrushSize(options.size)});
  if(source.selection)for(let i=0;i<source.selection.length;i++)if(!source.selection[i])pixels.set(source.pixels.subarray(i*4,i*4+4),i*4);
  return{pixels,layerId:source.layerId};
}
export function shape(sessionId,options={}) {
  const result=shapePixels(sessionId,options);
  if(options.preview)return previewActivePixels(sessionId,result);
  return applyCommand(requireSession(sessionId),'Нарисована фигура',layer=>{ensureCel(requireSession(sessionId).document,layer.id,requireSession(sessionId).frameIndex).set(result.pixels);return true;});
}
export function rotateSelection(sessionId,options={}) {
  const session=requireSession(sessionId),source=exportActivePixels(sessionId),result=transformPixels(source.pixels,source.width,source.height,source.selection,options.mode);
  return applyCommand(session,'Преобразовано выделение',layer=>{ensureCel(session.document,layer.id,session.frameIndex).set(result.pixels);session.selection=result.selection;return true;},false);
}
export function paint(sessionId, options = {}) {
  const session = requireSession(sessionId), layer = activeLayer(session), from = normalizePoint(options.from);
  if (!from) return sessionState(session);
  if (layer.locked || layer.kind === 'text') return sessionState(session, { blocked: layer.locked ? 'Слой заблокирован.' : 'Это текстовый слой. Нажмите «В пиксели» перед рисованием.' });
  if (options.beginStroke || session.stroke && (session.stroke.layerId !== layer.id || session.stroke.frameIndex !== session.frameIndex)) finishStroke(sessionId);
  if (!session.stroke) session.stroke = { layerId: layer.id, frameIndex: session.frameIndex, before: snapshotCel(session.document, layer.id, session.frameIndex), selection: session.selection ? Uint8Array.from(session.selection) : null, points: [from], options: { ...options, color: normalizeColor(options.color), size: normalizeBrushSize(options.size) } };
  const stroke = session.stroke; stroke.points.push(normalizePoint(options.to) || from);
  const result = globalThis.SpriteLabBrush.stroke(stroke.before, session.document.width, session.document.height, { ...stroke.options, points: stroke.points });
  if (stroke.selection) for (let i=0;i<stroke.selection.length;i++) if(!stroke.selection[i])result.set(stroke.before.subarray(i*4,i*4+4),i*4);
  ensureCel(session.document, layer.id, session.frameIndex).set(result);
  if (!options.continueStroke) return finishStroke(sessionId);
  return sessionState(session);
}

export function fill(sessionId, options = {}) {
  const session = requireSession(sessionId);
  const point = normalizePoint(options);
  if (!point) return sessionState(session);
  return applyCommand(session, "Заливка", (layer) => floodFill(
    session.document,
    layer.id,
    session.frameIndex,
    point[0],
    point[1],
    normalizeColor(options.color),
    { tolerance: normalizeTolerance(options.tolerance) },
  ));
}

// The pipeline keeps soft edges: a keyed background usually leaves a halo of almost transparent
// pixels that a zero-tolerance fill would stop at. This clears that halo in one step, which is what
// makes "fill the background" usable on a real frame.
export function eraseTransparent(sessionId, options = {}) {
  const session = requireSession(sessionId);
  const threshold = normalizeTolerance(options.threshold ?? 24);
  return applyCommand(session, "Стёрта прозрачная кайма", (layer) => {
    const cel = ensureCel(session.document, layer.id, session.frameIndex);
    let cleared = 0;
    for (let offset = 0; offset + 3 < cel.length; offset += 4) {
      const alpha = cel[offset + 3];
      if (alpha === 0 || alpha > threshold) continue;
      cel[offset] = 0;
      cel[offset + 1] = 0;
      cel[offset + 2] = 0;
      cel[offset + 3] = 0;
      cleared += 1;
    }
    return cleared ? { cleared } : null;
  });
}

// The eyedropper reads the flattened frame, because that is what the user sees on the canvas.
export function pick(sessionId, options = {}) {
  const session = requireSession(sessionId);
  const point = normalizePoint(options);
  if (!point) return { color: null };
  const { width, height } = session.document;
  if (point[0] < 0 || point[1] < 0 || point[0] >= width || point[1] >= height) return { color: null };
  const composite = compositeFrame(session.document, session.frameIndex);
  const offset = (point[1] * width + point[0]) * 4;
  return { color: [composite[offset], composite[offset + 1], composite[offset + 2], composite[offset + 3]] };
}

function applyFramePatch(session, patch) {
  if (!patch) return sessionState(session, { changedPixels: 0, label: "Цвета не изменились" });
  patch.activeLayerBefore = session.activeLayerId;
  patch.activeLayerAfter = patch.addedLayer?.id || session.activeLayerId;
  pushPatch(session.history, session.document, patch);
  session.activeLayerId = patch.activeLayerAfter;
  return sessionState(session, { changedPixels: patch.changedPixels, label: patch.label });
}

export function changeFrameColor(sessionId, options = {}) {
  const session = requireSession(sessionId);
  return applyFramePatch(session, frameColorPatch(session.document, session.frameIndex, options.source, options.replacement, options));
}

export function adjustFrame(sessionId, options = {}) {
  const session = requireSession(sessionId);
  return applyFramePatch(session, frameAdjustmentPatch(session.document, session.frameIndex, options.adjustments));
}

export function stepHistory(sessionId, direction = "undo") {
  const session = requireSession(sessionId);
  const patch = direction === "redo"
    ? redoPatch(session.history, session.document)
    : undoPatch(session.history, session.document);
  if (patch && Object.hasOwn(patch, "selectionBefore")) session.selection = direction === "redo" ? patch.selectionAfter : patch.selectionBefore;
  if (patch?.activeLayerBefore) session.activeLayerId = direction === "redo" ? patch.activeLayerAfter : patch.activeLayerBefore;
  const owner = patch?.frameIndex ?? patch?.parts?.[0]?.frameIndex ?? patch?.frameDurations?.[0]?.index;
  if (session.frameIndices?.includes(owner)) session.frameIndex = owner;
  if(patch?.layerUpdates||patch?.removedLayer||patch?.addedLayer||patch?.documentStates)session.checkAllFrames=true;
  if (!findLayer(session.document, session.activeLayerId)) session.activeLayerId = session.document.layers.at(-1).id;
  return sessionState(session, { label: patch ? patch.label || null : null, empty: !patch });
}

export function addEmptyLayer(sessionId, options = {}) {
  const session = requireSession(sessionId);
  const previous = session.activeLayerId;
  const layer = addLayer(session.document, options.name || null);
  if (session.frameIndices?.length > 1) layer.frameScope = session.frameIndex;
  session.activeLayerId = layer.id;
  pushPatch(session.history, session.document, { label: 'Добавлен слой', parts: [], addedLayer: { ...layer }, layerIndex: session.document.layers.length - 1, activeLayerBefore: previous, activeLayerAfter: layer.id });
  return sessionState(session, { label: `Слой «${layer.name}» добавлен` });
}

export function deleteLayer(sessionId, options = {}) {
  const session = requireSession(sessionId);
  const layerId = String(options.layerId || session.activeLayerId);
  const layer = findLayer(session.document, layerId), layerIndex = session.document.layers.indexOf(layer);
  if (!layer || describeLayers(session.document,session.frameIndex).length <= 1) return sessionState(session, { blocked: 'Нельзя удалить последний слой кадра.' });
  const previous = session.activeLayerId;
  const parts = (session.frameIndices || [session.frameIndex]).filter(i=>layer.frameScope==null||layer.frameScope===i).map(i=>({layerId,frameIndex:i,rect:{x:0,y:0,width:session.document.width,height:session.document.height},before:snapshotCel(session.document,layerId,i),after:new Uint8ClampedArray(session.document.width*session.document.height*4)}));
  if (!removeLayer(session.document, layerId)) {
    return sessionState(session, { blocked: "Нельзя удалить последний слой." });
  }
  if (session.activeLayerId === layerId) session.activeLayerId = describeLayers(session.document,session.frameIndex).at(-1)?.id || session.document.layers.at(-1).id;
  pushPatch(session.history, session.document, { label: 'Слой удалён', removedLayer: structuredClone(layer), layerIndex, parts, frameIndex:session.frameIndex, activeLayerBefore: previous, activeLayerAfter: session.activeLayerId });
  return sessionState(session, { label: "Слой удалён" });
}

export function updateLayer(sessionId, options = {}) {
  const session = requireSession(sessionId);
  const layerId = String(options.layerId || session.activeLayerId);
  const layer = findLayer(session.document, layerId);
  if (!layer) return sessionState(session, { blocked: "Слой не найден." });
  const before = structuredClone(layer);
  if (options.active) session.activeLayerId = layerId;
  if (typeof options.visible === "boolean") layer.visible = options.visible;
  if (typeof options.locked === "boolean") layer.locked = options.locked;
  if (options.opacity != null) {
    const opacity = Math.round(Number(options.opacity));
    if (Number.isFinite(opacity)) layer.opacity = Math.max(0, Math.min(255, opacity));
  }
  if (typeof options.blendMode === "string") layer.blendMode = options.blendMode;
  if (typeof options.name === "string" && options.name.trim()) layer.name = options.name.trim().slice(0, 40);
  if (JSON.stringify(before) !== JSON.stringify(layer)) pushPatch(session.history, session.document, { label: 'Свойства слоя', parts: [], layerUpdates: [{ id: layer.id, before, after: structuredClone(layer) }] });
  session.checkAllFrames=true;
  return sessionState(session);
}

export function layerPixel(sessionId, options = {}) {
  const session = requireSession(sessionId);
  const point = normalizePoint(options);
  if (!point) return { color: null };
  const layer = activeLayer(session);
  return { color: readPixel(session.document, layer.id, session.frameIndex, point[0], point[1]) };
}

export function readState(sessionId) {
  return sessionState(requireSession(sessionId));
}

// The interface hands this to sharp, which encodes the PNG; nothing here writes to disk.
export function exportFrame(sessionId) {
  const session = requireSession(sessionId);
  return {
    name: session.name,
    frameIndex: session.frameIndex,
    width: session.document.width,
    height: session.document.height,
    composite: compositeFrame(session.document, session.frameIndex),
  };
}

export function exportEditableDocument(sessionId) {
  const session = requireSession(sessionId);
  return encodeEditorDocument(session.document, session.frameIndex);
}

export function exportActivePixels(sessionId) {
  const session = requireSession(sessionId), layer = activeLayer(session);
  if (layer.locked || layer.kind === 'text') throw new Error('Выберите незаблокированный пиксельный слой с исходной надписью.');
  return { pixels: snapshotCel(session.document, layer.id, session.frameIndex), layerId: layer.id, width: session.document.width, height: session.document.height, selection: session.selection ? Uint8Array.from(session.selection) : null };
}

export function replaceActivePixels(sessionId, options = {}) {
  const session = requireSession(sessionId), layer = activeLayer(session);
  if (options.layerId !== layer.id) throw new Error('Активный слой изменился. Подготовьте восстановление заново.');
  const pixels = Uint8ClampedArray.from(options.pixels || []);
  if (pixels.length !== session.document.width * session.document.height * 4) throw new Error('Неверный размер восстановленного слоя.');
  return applyCommand(session, 'Старая надпись удалена', current => { ensureCel(session.document, current.id, session.frameIndex).set(pixels); return true; });
}

export function previewActivePixels(sessionId, options = {}) {
  const session = requireSession(sessionId), layer = activeLayer(session);
  if (options.layerId !== layer.id) throw new Error('Активный слой изменился.');
  const pixels = Uint8ClampedArray.from(options.pixels || []), before = snapshotCel(session.document, layer.id, session.frameIndex);
  if (pixels.length !== before.length) throw new Error('Неверный размер восстановленного слоя.');
  ensureCel(session.document, layer.id, session.frameIndex).set(pixels);
  try { return compositeFrame(session.document, session.frameIndex); }
  finally { ensureCel(session.document, layer.id, session.frameIndex).set(before); }
}

export function setTextLayer(sessionId, options = {}) {
  const session = requireSession(sessionId), document = session.document;
  if(document.colorMode==='indexed')throw new Error('Переключите документ в RGBA перед добавлением редактируемого текста.');
  const existing = options.layerId ? findLayer(document, String(options.layerId)) : null;
  if (options.layerId && (!existing || existing.kind !== 'text')) throw new Error('Текстовый слой не найден.');
  if (existing?.locked) return sessionState(session, { blocked: 'Текстовый слой заблокирован.' });
  const pixels = new Uint8ClampedArray(options.pixels || []);
  if (pixels.length !== document.width * document.height * 4) throw new Error('Неверный размер текстового слоя.');
  const settings = textSettings(options.text), activeBefore = session.activeLayerId;
  const layer = existing || addLayer(document, 'Текст');
  if (!existing && session.frameIndices?.length > 1) layer.frameScope = session.frameIndex;
  const beforeLayer = structuredClone(layer), before = snapshotCel(document, layer.id, session.frameIndex);
  layer.kind = 'text'; layer.text = settings; layer.name = `Т: ${settings.text.split('\n')[0].slice(0, 32) || 'Текст'}`;
  ensureCel(document, layer.id, session.frameIndex).set(pixels);
  const part = patchFromSnapshot(document, layer.id, session.frameIndex, before);
  const patch = { label: existing ? 'Текст изменён' : 'Добавлен текстовый слой', parts: part ? [part] : [], activeLayerBefore: activeBefore, activeLayerAfter: layer.id };
  if(existing?.seriesTextId)for(const index of session.frameIndices||[]){if(index===session.frameIndex)continue;const original=snapshotCel(document,layer.id,index);ensureCel(document,layer.id,index).set(pixels);const change=patchFromSnapshot(document,layer.id,index,original);if(change)patch.parts.push(change);session.dirtyFrames?.add(index);}
  if(existing?.seriesTextId)session.checkAllFrames=true;
  if (existing) patch.layerUpdates = [{ id: layer.id, before: beforeLayer, after: structuredClone(layer) }];
  else { patch.addedLayer = structuredClone(layer); patch.layerIndex = document.layers.length - 1; }
  if (part || !existing || JSON.stringify(beforeLayer) !== JSON.stringify(layer)) pushPatch(session.history, document, patch);
  session.activeLayerId = layer.id;
  return sessionState(session, { label: patch.label });
}

export function rasterizeTextLayer(sessionId) {
  const session = requireSession(sessionId), layer = activeLayer(session);
  if (layer.kind !== 'text') return sessionState(session);
  if (layer.locked) return sessionState(session, { blocked: 'Текстовый слой заблокирован.' });
  const before = structuredClone(layer);
  layer.kind = 'normal'; layer.text = undefined;
  pushPatch(session.history, session.document, { label: 'Текст переведён в пиксели', parts: [], layerUpdates: [{ id: layer.id, before, after: structuredClone(layer) }] });
  return sessionState(session, { label: 'Текст переведён в пиксели · отмена возвращает редактируемый текст' });
}

export function previewTextLayer(sessionId, options = {}) {
  const session = requireSession(sessionId), document = session.document;
  const existing = options.layerId ? findLayer(document, options.layerId) : null;
  if (options.layerId && existing?.kind !== 'text') throw new Error('Текстовый слой не найден.');
  const pixels = new Uint8ClampedArray(options.pixels || []);
  if (pixels.length !== document.width * document.height * 4) throw new Error('Неверный размер текстового слоя.');
  const layer = existing || addLayer(document, 'Просмотр текста');
  const before = snapshotCel(document, layer.id, session.frameIndex);
  ensureCel(document, layer.id, session.frameIndex).set(pixels);
  try { return compositeFrame(document, session.frameIndex); }
  finally { if (existing) ensureCel(document, layer.id, session.frameIndex).set(before); else removeLayer(document, layer.id); }
}

export function closeSession(sessionId) {
  return sessions.delete(String(sessionId || ""));
}

export function openSessionCount() {
  return sessions.size;
}

export function resetSessionsForTests() {
  sessions.clear();
}

export function selectPixels(sessionId, options = {}) {
  const session = requireSession(sessionId);
  session.selection = options.clear ? null : makePixelSelection(compositeFrame(session.document, session.frameIndex), session.document.width, session.document.height, options);
  return sessionState(session);
}
export function transformSelection(sessionId, options = {}) {
  const session = requireSession(sessionId);
  if (activeLayer(session)?.kind === 'text') return sessionState(session, { blocked: 'Перемещайте надпись инструментом T. Для правки пикселей нажмите «В пиксели».' });
  if (!session.selection?.some(Boolean)) return sessionState(session, { blocked: "Сначала выделите пиксели." });
  if (options.newLayer) {
    const source = activeLayer(session);
    if (source.locked) return sessionState(session, { blocked: "Слой заблокирован." });
    const before = snapshotCel(session.document, source.id, session.frameIndex);
    const moved = moveSelectedPixels(before, session.document.width, session.document.height, session.selection, options);
    const selected = Buffer.alloc(before.length);
    for (let i = 0; i < session.selection.length; i++) if (session.selection[i]) selected.set(before.subarray(i * 4, i * 4 + 4), i * 4);
    const target = moveSelectedPixels(selected, session.document.width, session.document.height, session.selection, { ...options, copy: false });
    // Validate before creating a layer: an out-of-bounds move has no side effects.
    const layer = addLayer(session.document, "Выделенный объект");
    ensureCel(session.document, layer.id, session.frameIndex).set(target.data);
    const sourceCel = ensureCel(session.document, source.id, session.frameIndex);
    for (let i = 0; i < session.selection.length; i++) if (session.selection[i]) sourceCel.fill(0, i * 4, i * 4 + 4);
    const parts = [patchFromSnapshot(session.document, source.id, session.frameIndex, before), patchFromSnapshot(session.document, layer.id, session.frameIndex, new Uint8ClampedArray(before.length))].filter(Boolean);
    if (!parts.length) { removeLayer(session.document, layer.id); return sessionState(session); }
    const patch = { label: "Объект вынесен на новый слой", parts, addedLayer: { ...layer }, layerIndex: session.document.layers.length - 1, activeLayerBefore: source.id, activeLayerAfter: layer.id, selectionBefore: Uint8Array.from(session.selection), selectionAfter: moved.mask };
    pushPatch(session.history, session.document, patch); session.selection = moved.mask; session.activeLayerId = layer.id;
    return sessionState(session, { label: patch.label });
  }
  return applyCommand(session, options.erase ? "Вырезать выделение" : "Перемещение выделенных пикселей", layer => {
    const cel = ensureCel(session.document, layer.id, session.frameIndex);
    const moved = moveSelectedPixels(cel, session.document.width, session.document.height, session.selection, options);
    cel.set(moved.data); session.selection = moved.mask; return true;
  }, false);
}
