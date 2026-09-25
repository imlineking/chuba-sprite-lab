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
function applyCommand(session, label, command) {
  const layer = activeLayer(session);
  if (!layer) return sessionState(session);
  if (layer.locked) return sessionState(session, { blocked: `Слой «${layer.name}» заблокирован.` });
  const before = snapshotCel(session.document, layer.id, session.frameIndex);
  const touched = command(layer);
  if (!touched) return sessionState(session);
  const patch = patchFromSnapshot(session.document, layer.id, session.frameIndex, before, label);
  if (patch) pushPatch(session.history, session.document, patch);
  return sessionState(session, { label });
}

export function openSession({ width, height, name = "Кадр", frameIndex = 0, pixels = null } = {}) {
  // The document uses the source frame number as its own frame index, so a later version can hold
  // several frames of one character without moving any pixels around.
  const frameNumber = Math.max(0, Math.round(Number(frameIndex) || 0));
  const document = createDocument({ width, height, frames: frameNumber + 1 });
  const base = document.layers[0];
  base.name = "Кадр";
  if (pixels) {
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
    activeLayerId: base.id,
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
    { color: normalizeColor(options.color), size: normalizeBrushSize(options.size), erase },
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

export function stepHistory(sessionId, direction = "undo") {
  const session = requireSession(sessionId);
  const patch = direction === "redo"
    ? redoPatch(session.history, session.document)
    : undoPatch(session.history, session.document);
  return sessionState(session, { label: patch ? patch.label || null : null, empty: !patch });
}

export function addEmptyLayer(sessionId, options = {}) {
  const session = requireSession(sessionId);
  const layer = addLayer(session.document, options.name || null);
  session.activeLayerId = layer.id;
  return sessionState(session, { label: `Слой «${layer.name}» добавлен` });
}

export function deleteLayer(sessionId, options = {}) {
  const session = requireSession(sessionId);
  const layerId = String(options.layerId || session.activeLayerId);
  if (!removeLayer(session.document, layerId)) {
    return sessionState(session, { blocked: "Нельзя удалить последний слой." });
  }
  if (session.activeLayerId === layerId) session.activeLayerId = session.document.layers.at(-1).id;
  return sessionState(session, { label: "Слой удалён" });
}

export function updateLayer(sessionId, options = {}) {
  const session = requireSession(sessionId);
  const layerId = String(options.layerId || session.activeLayerId);
  const layer = findLayer(session.document, layerId);
  if (!layer) return sessionState(session, { blocked: "Слой не найден." });
  if (options.active) session.activeLayerId = layerId;
  if (typeof options.visible === "boolean") layer.visible = options.visible;
  if (typeof options.locked === "boolean") layer.locked = options.locked;
  if (options.opacity != null) {
    const opacity = Math.round(Number(options.opacity));
    if (Number.isFinite(opacity)) layer.opacity = Math.max(0, Math.min(255, opacity));
  }
  if (typeof options.blendMode === "string") layer.blendMode = options.blendMode;
  if (typeof options.name === "string" && options.name.trim()) layer.name = options.name.trim().slice(0, 40);
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

export function closeSession(sessionId) {
  return sessions.delete(String(sessionId || ""));
}

export function openSessionCount() {
  return sessions.size;
}

export function resetSessionsForTests() {
  sessions.clear();
}
