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
  paintStroke,
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

function describeLayers(document) {
  return document.layers.map((layer) => ({
    id: layer.id,
    name: layer.name,
    visible: layer.visible,
    locked: layer.locked,
    opacity: layer.opacity,
    blendMode: layer.blendMode,
    kind: layer.kind,
    text: layer.kind === 'text' ? structuredClone(layer.text) : undefined,
  }));
}

// One state shape for open, paint, fill, undo and layer changes: the window draws the composite and
// rebuilds the panels from the rest, so no operation needs its own update path.
function sessionState(session, extra = {}) {
  return {
    sessionId: session.id,
    name: session.name,
    frameIndex: session.frameIndex,
    width: session.document.width,
    height: session.document.height,
    layers: describeLayers(session.document),
    activeLayerId: session.activeLayerId,
    selection: session.selection || null,
    canUndo: session.history.undoStack.length > 0,
    canRedo: session.history.redoStack.length > 0,
    composite: compositeFrame(session.document, session.frameIndex),
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

export function paint(sessionId, options = {}) {
  const session = requireSession(sessionId);
  const from = normalizePoint(options.from);
  if (!from) return sessionState(session);
  const to = normalizePoint(options.to) || from;
  const erase = Boolean(options.erase);
  return applyCommand(session, erase ? "Ластик" : "Карандаш", (layer) => paintStroke(
    session.document,
    layer.id,
    session.frameIndex,
    from,
    to,
    { color: normalizeColor(options.color), size: normalizeBrushSize(options.size), shape: options.shape === "round" ? "round" : "square", erase },
  ));
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
  if (!findLayer(session.document, session.activeLayerId)) session.activeLayerId = session.document.layers.at(-1).id;
  return sessionState(session, { label: patch ? patch.label || null : null, empty: !patch });
}

export function addEmptyLayer(sessionId, options = {}) {
  const session = requireSession(sessionId);
  const previous = session.activeLayerId;
  const layer = addLayer(session.document, options.name || null);
  session.activeLayerId = layer.id;
  pushPatch(session.history, session.document, { label: 'Добавлен слой', parts: [], addedLayer: { ...layer }, layerIndex: session.document.layers.length - 1, activeLayerBefore: previous, activeLayerAfter: layer.id });
  return sessionState(session, { label: `Слой «${layer.name}» добавлен` });
}

export function deleteLayer(sessionId, options = {}) {
  const session = requireSession(sessionId);
  const layerId = String(options.layerId || session.activeLayerId);
  const layer = findLayer(session.document, layerId), layerIndex = session.document.layers.indexOf(layer);
  if (!layer || session.document.layers.length <= 1) return sessionState(session, { blocked: 'Нельзя удалить последний слой.' });
  const before = snapshotCel(session.document, layerId, session.frameIndex), previous = session.activeLayerId;
  if (!removeLayer(session.document, layerId)) {
    return sessionState(session, { blocked: "Нельзя удалить последний слой." });
  }
  if (session.activeLayerId === layerId) session.activeLayerId = session.document.layers.at(-1).id;
  pushPatch(session.history, session.document, { label: 'Слой удалён', removedLayer: structuredClone(layer), layerIndex, parts: [{ layerId, frameIndex: session.frameIndex, rect: { x: 0, y: 0, width: session.document.width, height: session.document.height }, before, after: new Uint8ClampedArray(before.length) }], activeLayerBefore: previous, activeLayerAfter: session.activeLayerId });
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
  const existing = options.layerId ? findLayer(document, String(options.layerId)) : null;
  if (options.layerId && (!existing || existing.kind !== 'text')) throw new Error('Текстовый слой не найден.');
  if (existing?.locked) return sessionState(session, { blocked: 'Текстовый слой заблокирован.' });
  const pixels = new Uint8ClampedArray(options.pixels || []);
  if (pixels.length !== document.width * document.height * 4) throw new Error('Неверный размер текстового слоя.');
  const settings = textSettings(options.text), activeBefore = session.activeLayerId;
  const layer = existing || addLayer(document, 'Текст');
  const beforeLayer = structuredClone(layer), before = snapshotCel(document, layer.id, session.frameIndex);
  layer.kind = 'text'; layer.text = settings; layer.name = `Т: ${settings.text.split('\n')[0].slice(0, 32) || 'Текст'}`;
  ensureCel(document, layer.id, session.frameIndex).set(pixels);
  const part = patchFromSnapshot(document, layer.id, session.frameIndex, before);
  const patch = { label: existing ? 'Текст изменён' : 'Добавлен текстовый слой', parts: part ? [part] : [], activeLayerBefore: activeBefore, activeLayerAfter: layer.id };
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
