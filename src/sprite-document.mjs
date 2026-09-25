// Document model for the built-in pixel editor. Pure data and pure functions: the canvas in the
// interface only paints what this module computes, so every rule below is testable without a DOM.
//
// The shape follows the design in docs/PIXEL_EDITOR_DESIGN.md: a document owns layers, frames and
// cels, where a cel is the (layer, frame) intersection. Layers and frames therefore grow
// independently, and adding blend modes, groups or tags later never changes the storage.

export const blendModes = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "add", "subtract", "difference"];

let nextLayerId = 1;

export function createDocument({ width = 64, height = 64, frames = 1, layers = 1 } = {}) {
  const document = {
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    colorMode: "rgba",
    palette: [],
    frames: Array.from({ length: Math.max(1, Math.round(frames)) }, () => ({ durationMs: 100 })),
    layers: [],
    cels: new Map(),
  };
  for (let index = 0; index < Math.max(1, Math.round(layers)); index += 1) {
    addLayer(document, index === 0 ? "Слой 1" : `Слой ${index + 1}`);
  }
  return document;
}

export function celKey(layerId, frameIndex) {
  return `${layerId}#${frameIndex}`;
}

export function addLayer(document, name = null, { at = null } = {}) {
  const layer = {
    id: `layer-${nextLayerId++}`,
    name: name || `Слой ${document.layers.length + 1}`,
    visible: true,
    locked: false,
    opacity: 255,
    blendMode: "normal",
    kind: "normal",
  };
  if (at == null || at < 0 || at >= document.layers.length) document.layers.push(layer);
  else document.layers.splice(at, 0, layer);
  return layer;
}

export function removeLayer(document, layerId) {
  const index = document.layers.findIndex((layer) => layer.id === layerId);
  if (index < 0 || document.layers.length <= 1) return false;
  document.layers.splice(index, 1);
  for (const key of [...document.cels.keys()]) {
    if (key.startsWith(`${layerId}#`)) document.cels.delete(key);
  }
  return true;
}

export function findLayer(document, layerId) {
  return document.layers.find((layer) => layer.id === layerId) || null;
}

export function ensureCel(document, layerId, frameIndex) {
  const key = celKey(layerId, frameIndex);
  let cel = document.cels.get(key);
  if (!cel) {
    cel = new Uint8ClampedArray(document.width * document.height * 4);
    document.cels.set(key, cel);
  }
  return cel;
}

export function readPixel(document, layerId, frameIndex, x, y) {
  if (x < 0 || y < 0 || x >= document.width || y >= document.height) return [0, 0, 0, 0];
  const cel = document.cels.get(celKey(layerId, frameIndex));
  if (!cel) return [0, 0, 0, 0];
  const offset = (y * document.width + x) * 4;
  return [cel[offset], cel[offset + 1], cel[offset + 2], cel[offset + 3]];
}

// Bresenham: a mouse reports sparse positions, and without interpolation a fast stroke becomes a
// dotted line. Returned points are inclusive of both ends.
export function linePoints(fromX, fromY, toX, toY) {
  const points = [];
  let x = Math.round(fromX);
  let y = Math.round(fromY);
  const targetX = Math.round(toX);
  const targetY = Math.round(toY);
  const dx = Math.abs(targetX - x);
  const dy = Math.abs(targetY - y);
  const stepX = x < targetX ? 1 : -1;
  const stepY = y < targetY ? 1 : -1;
  let error = dx - dy;
  for (;;) {
    points.push([x, y]);
    if (x === targetX && y === targetY) break;
    const doubled = error * 2;
    if (doubled > -dy) { error -= dy; x += stepX; }
    if (doubled < dx) { error += dx; y += stepY; }
  }
  return points;
}

function brushPoints(x, y, size) {
  const radius = Math.max(0, Math.floor((size - 1) / 2));
  const points = [];
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) points.push([x + dx, y + dy]);
  }
  return points;
}

function writePixels(document, layerId, frameIndex, points, color, erase) {
  const cel = ensureCel(document, layerId, frameIndex);
  const { width, height } = document;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (const [x, y] of points) {
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const offset = (y * width + x) * 4;
    if (erase) {
      cel[offset] = 0; cel[offset + 1] = 0; cel[offset + 2] = 0; cel[offset + 3] = 0;
    } else {
      cel[offset] = color[0]; cel[offset + 1] = color[1]; cel[offset + 2] = color[2];
      cel[offset + 3] = color[3] ?? 255;
    }
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export function paintStroke(document, layerId, frameIndex, from, to, { color = [0, 0, 0, 255], size = 1, erase = false } = {}) {
  const points = [];
  for (const [x, y] of linePoints(from[0], from[1], to[0], to[1])) points.push(...brushPoints(x, y, size));
  return writePixels(document, layerId, frameIndex, points, color, erase);
}

function colorsClose(cel, offset, target, tolerance, respectAlpha) {
  const alpha = cel[offset + 3];
  if (respectAlpha && alpha === 0) return target[3] === 0;
  if (Math.abs(alpha - target[3]) > tolerance) return false;
  if (alpha === 0) return target[3] === 0;
  return Math.abs(cel[offset] - target[0]) <= tolerance
    && Math.abs(cel[offset + 1] - target[1]) <= tolerance
    && Math.abs(cel[offset + 2] - target[2]) <= tolerance;
}

// Four-connected flood fill. The region is read from the same cel that is being written, so the fill
// cannot leak through a one-pixel wall: the wall is simply not part of the region.
export function floodFill(document, layerId, frameIndex, startX, startY, color, { tolerance = 0 } = {}) {
  const { width, height } = document;
  const x0 = Math.round(startX);
  const y0 = Math.round(startY);
  if (x0 < 0 || y0 < 0 || x0 >= width || y0 >= height) return null;
  const cel = ensureCel(document, layerId, frameIndex);
  const target = [cel[(y0 * width + x0) * 4], cel[(y0 * width + x0) * 4 + 1], cel[(y0 * width + x0) * 4 + 2], cel[(y0 * width + x0) * 4 + 3]];
  const replacement = [color[0], color[1], color[2], color[3] ?? 255];
  if (target.every((value, index) => value === replacement[index])) return null;

  const visited = new Uint8Array(width * height);
  const stack = [[x0, y0]];
  const points = [];
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const index = y * width + x;
    if (visited[index]) continue;
    visited[index] = 1;
    const offset = index * 4;
    if (!colorsClose(cel, offset, target, tolerance, true)) continue;
    points.push([x, y]);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  writePixels(document, layerId, frameIndex, points, replacement, false);
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function blendChannel(base, top, mode) {
  switch (mode) {
    case "multiply": return (base * top) / 255;
    case "screen": return 255 - ((255 - base) * (255 - top)) / 255;
    case "overlay": return base < 128 ? (2 * base * top) / 255 : 255 - (2 * (255 - base) * (255 - top)) / 255;
    case "darken": return Math.min(base, top);
    case "lighten": return Math.max(base, top);
    case "add": return Math.min(255, base + top);
    case "subtract": return Math.max(0, base - top);
    case "difference": return Math.abs(base - top);
    default: return top;
  }
}

// Flattens one frame bottom-to-top. An unknown blend mode falls back to normal instead of throwing,
// so a document written by a newer version still opens.
export function compositeFrame(document, frameIndex) {
  const { width, height } = document;
  const output = new Uint8ClampedArray(width * height * 4);
  for (const layer of document.layers) {
    if (!layer.visible || layer.opacity === 0) continue;
    const cel = document.cels.get(celKey(layer.id, frameIndex));
    if (!cel) continue;
    const opacity = Math.max(0, Math.min(255, layer.opacity)) / 255;
    const mode = blendModes.includes(layer.blendMode) ? layer.blendMode : "normal";
    for (let index = 0; index < width * height; index += 1) {
      const offset = index * 4;
      const alpha = (cel[offset + 3] / 255) * opacity;
      if (alpha <= 0) continue;
      const baseAlpha = output[offset + 3] / 255;
      const outAlpha = alpha + baseAlpha * (1 - alpha);
      if (outAlpha <= 0) continue;
      for (let channel = 0; channel < 3; channel += 1) {
        const blended = mode === "normal" || baseAlpha <= 0
          ? cel[offset + channel]
          : blendChannel(output[offset + channel], cel[offset + channel], mode);
        output[offset + channel] = Math.round((blended * alpha + output[offset + channel] * baseAlpha * (1 - alpha)) / outAlpha);
      }
      output[offset + 3] = Math.round(outAlpha * 255);
    }
  }
  return output;
}

// The interface snapshots the cel when a stroke starts and draws freely; this turns the difference
// into one patch. That is what makes a whole mouse stroke a single undo step, as the design requires.
export function snapshotCel(document, layerId, frameIndex) {
  const cel = document.cels.get(celKey(layerId, frameIndex));
  return cel ? Uint8ClampedArray.from(cel) : new Uint8ClampedArray(document.width * document.height * 4);
}

export function patchFromSnapshot(document, layerId, frameIndex, snapshot, label = "") {
  const { width, height } = document;
  const cel = document.cels.get(celKey(layerId, frameIndex));
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const changed = !cel
        ? snapshot[offset + 3] !== 0
        : snapshot[offset] !== cel[offset] || snapshot[offset + 1] !== cel[offset + 1]
          || snapshot[offset + 2] !== cel[offset + 2] || snapshot[offset + 3] !== cel[offset + 3];
      if (!changed) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  const rect = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  const patch = createPatch(document, layerId, frameIndex, rect, captureRect(document, layerId, frameIndex, rect));
  // The rectangle was measured after the change, so the "before" block has to come from the snapshot.
  const before = new Uint8ClampedArray(rect.width * rect.height * 4);
  for (let row = 0; row < rect.height; row += 1) {
    for (let column = 0; column < rect.width; column += 1) {
      const target = (row * rect.width + column) * 4;
      const source = ((rect.y + row) * width + rect.x + column) * 4;
      for (let channel = 0; channel < 4; channel += 1) before[target + channel] = snapshot[source + channel];
    }
  }
  patch.before = before;
  patch.label = label;
  return patch;
}

/* ------------------------------------------------------------------ history */

export function createHistory({ limit = 60 } = {}) {
  return { undoStack: [], redoStack: [], limit };
}

// A patch stores only the rectangle a command touched, so a brush stroke costs a few kilobytes
// instead of a full copy of the layer.
export function createPatch(document, layerId, frameIndex, rect, before) {
  const cel = document.cels.get(celKey(layerId, frameIndex));
  const after = new Uint8ClampedArray(before.length);
  const { width } = document;
  for (let row = 0; row < rect.height; row += 1) {
    for (let column = 0; column < rect.width; column += 1) {
      const target = (row * rect.width + column) * 4;
      const source = ((rect.y + row) * width + rect.x + column) * 4;
      for (let channel = 0; channel < 4; channel += 1) after[target + channel] = cel ? cel[source + channel] : 0;
    }
  }
  return { label: "", layerId, frameIndex, rect, before, after };
}

export function captureRect(document, layerId, frameIndex, rect) {
  const { width } = document;
  const cel = document.cels.get(celKey(layerId, frameIndex));
  const block = new Uint8ClampedArray(rect.width * rect.height * 4);
  for (let row = 0; row < rect.height; row += 1) {
    for (let column = 0; column < rect.width; column += 1) {
      const target = (row * rect.width + column) * 4;
      const source = ((rect.y + row) * width + rect.x + column) * 4;
      for (let channel = 0; channel < 4; channel += 1) block[target + channel] = cel ? cel[source + channel] : 0;
    }
  }
  return block;
}

function writeBlock(document, layerId, frameIndex, rect, block) {
  const cel = ensureCel(document, layerId, frameIndex);
  const { width } = document;
  for (let row = 0; row < rect.height; row += 1) {
    for (let column = 0; column < rect.width; column += 1) {
      const source = (row * rect.width + column) * 4;
      const target = ((rect.y + row) * width + rect.x + column) * 4;
      for (let channel = 0; channel < 4; channel += 1) cel[target + channel] = block[source + channel];
    }
  }
}

export function pushPatch(history, document, patch) {
  writeBlock(document, patch.layerId, patch.frameIndex, patch.rect, patch.after);
  history.undoStack.push(patch);
  if (history.undoStack.length > history.limit) history.undoStack.shift();
  history.redoStack.length = 0;
  return patch;
}

export function undoPatch(history, document) {
  const patch = history.undoStack.pop();
  if (!patch) return null;
  writeBlock(document, patch.layerId, patch.frameIndex, patch.rect, patch.before);
  history.redoStack.push(patch);
  return patch;
}

export function redoPatch(history, document) {
  const patch = history.redoStack.pop();
  if (!patch) return null;
  writeBlock(document, patch.layerId, patch.frameIndex, patch.rect, patch.after);
  history.undoStack.push(patch);
  return patch;
}

export function resetDocumentIdsForTests() {
  nextLayerId = 1;
}
