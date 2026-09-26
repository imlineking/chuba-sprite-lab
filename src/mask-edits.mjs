import { removeRegionColor, removeChecker } from "./region-color.mjs";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function editApplies(edit, frameIndex) {
  return Boolean(edit?.applyAll) || Number(edit?.frameIndex) === Number(frameIndex);
}

function colorDistanceSquared(data, offset, color) {
  const dr = data[offset] - color[0];
  const dg = data[offset + 1] - color[1];
  const db = data[offset + 2] - color[2];
  return dr * dr + dg * dg + db * db;
}

function findColorComponents(source, width, height, channels, color, tolerance) {
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const thresholdSquared = tolerance * tolerance;
  const components = [];
  let tail = 0;

  for (let seed = 0; seed < visited.length; seed += 1) {
    if (visited[seed]) continue;
    visited[seed] = 1;
    const seedOffset = seed * channels;
    if (source[seedOffset + 3] < 8 || colorDistanceSquared(source, seedOffset, color) > thresholdSquared) continue;

    const start = tail;
    let head = tail;
    queue[tail++] = seed;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let sumX = 0;
    let sumY = 0;
    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      sumX += x;
      sumY += y;
      const neighbours = [index - 1, index + 1, index - width, index + width];
      for (const next of neighbours) {
        if (next < 0 || next >= visited.length || visited[next]) continue;
        if ((next === index - 1 && x === 0) || (next === index + 1 && x === width - 1)) continue;
        visited[next] = 1;
        const offset = next * channels;
        if (source[offset + 3] < 8 || colorDistanceSquared(source, offset, color) > thresholdSquared) continue;
        queue[tail++] = next;
      }
    }
    const area = tail - start;
    components.push({
      start,
      end: tail,
      area,
      centerX: sumX / Math.max(1, area),
      centerY: sumY / Math.max(1, area),
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      minX,
      minY,
      maxX,
      maxY,
    });
  }
  return { components, queue };
}

function selectTrackedComponent(components, queue, edit, width, height, frameIndex) {
  if (!components.length) return null;
  const targetX = clamp(Number(edit.centroidX ?? edit.x) || 0, 0, 1);
  const targetY = clamp(Number(edit.centroidY ?? edit.y) || 0, 0, 1);
  const targetArea = Math.max(4, (Number(edit.area) || 0.001) * width * height);
  const targetWidth = Math.max(2, (Number(edit.selectionWidth) || 0.02) * width);
  const targetHeight = Math.max(2, (Number(edit.selectionHeight) || 0.02) * height);
  const seedX = clamp(Math.round((Number(edit.x) || 0) * (width - 1)), 0, width - 1);
  const seedY = clamp(Math.round((Number(edit.y) || 0) * (height - 1)), 0, height - 1);
  const referenceFrame = Number(edit.frameIndex) === Number(frameIndex);
  let best = null;

  for (const component of components) {
    let containsSeed = false;
    if (referenceFrame && seedX >= component.minX && seedX <= component.maxX && seedY >= component.minY && seedY <= component.maxY) {
      const seedIndex = seedY * width + seedX;
      for (let cursor = component.start; cursor < component.end; cursor += 1) {
        if (queue[cursor] === seedIndex) { containsSeed = true; break; }
      }
    }
    if (referenceFrame && containsSeed) return { component, score: 0 };
    const areaRatio = component.area / targetArea;
    const widthRatio = component.width / targetWidth;
    const heightRatio = component.height / targetHeight;
    if (areaRatio < 0.12 || areaRatio > 8 || widthRatio < 0.1 || widthRatio > 10 || heightRatio < 0.1 || heightRatio > 10) continue;
    const dx = component.centerX / Math.max(1, width - 1) - targetX;
    const dy = component.centerY / Math.max(1, height - 1) - targetY;
    const distance = Math.hypot(dx, dy);
    const searchRadius = clamp(Number(edit.searchRadius) || 0.28, 0.06, 0.75);
    if (distance > searchRadius) continue;
    const shapePenalty = Math.abs(Math.log(areaRatio)) * 0.24
      + Math.abs(Math.log(widthRatio)) * 0.1
      + Math.abs(Math.log(heightRatio)) * 0.1;
    const score = distance * 4 + shapePenalty;
    if (!best || score < best.score) best = { component, score };
  }
  return best?.score <= 2.35 ? best : null;
}

function applyBrushEdit(data, original, width, height, channels, edit) {
  const centerX = clamp(Number(edit.x) || 0, 0, 1) * (width - 1);
  const centerY = clamp(Number(edit.y) || 0, 0, 1) * (height - 1);
  const radius = Math.max(1, clamp(Number(edit.radius) || 0.03, 0.002, 0.35) * Math.max(width, height));
  const minX = Math.max(0, Math.floor(centerX - radius));
  const maxX = Math.min(width - 1, Math.ceil(centerX + radius));
  const minY = Math.max(0, Math.floor(centerY - radius));
  const maxY = Math.min(height - 1, Math.ceil(centerY + radius));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const distance = Math.hypot(x - centerX, y - centerY);
      if (distance > radius) continue;
      const index = y * width + x;
      const offset = index * channels;
      const hardRadius = radius * 0.82;
      const strength = distance <= hardRadius
        ? 1
        : clamp(1 - (distance - hardRadius) / Math.max(1, radius - hardRadius), 0, 1);
      const originalAlpha = original[offset + 3];
      if (edit.mode === "keep") {
        data[offset + 3] = Math.max(data[offset + 3], Math.round(originalAlpha * strength));
        for (let channel = 0; channel < 3; channel++) data[offset + channel] = Math.round(data[offset + channel] * (1 - strength) + original[offset + channel] * strength);
      }
      else data[offset + 3] = Math.min(data[offset + 3], Math.round(data[offset + 3] * (1 - strength)));
    }
  }
}

function applyTrackedEdit(data, original, width, height, channels, edit, frameIndex) {
  const color = Array.isArray(edit.color) && edit.color.length >= 3
    ? edit.color.slice(0, 3).map((value) => clamp(Number(value) || 0, 0, 255))
    : null;
  if (!color) return null;
  const tolerance = clamp(Number(edit.tolerance) || 42, 6, 140);
  const { components, queue } = findColorComponents(original, width, height, channels, color, tolerance);
  const match = selectTrackedComponent(components, queue, edit, width, height, frameIndex);
  if (!match) return { matched: false, confidence: 0, pixels: 0 };
  const { component: selected, score } = match;
  for (let cursor = selected.start; cursor < selected.end; cursor += 1) data[queue[cursor] * channels + 3] = 0;

  const haloThreshold = tolerance * 1.3;
  const haloThresholdSquared = haloThreshold * haloThreshold;
  for (let cursor = selected.start; cursor < selected.end; cursor += 1) {
    const index = queue[cursor];
    const x = index % width;
    const neighbours = [index - 1, index + 1, index - width, index + width];
    for (const next of neighbours) {
      if (next < 0 || next >= width * height) continue;
      if ((next === index - 1 && x === 0) || (next === index + 1 && x === width - 1)) continue;
      if (colorDistanceSquared(original, next * channels, color) <= haloThresholdSquared) data[next * channels + 3] = 0;
    }
  }
  return { matched: true, confidence: clamp(1 - score / 2.35, 0, 1), pixels: selected.area };
}

export function applyMaskEdits(data, original, info, edits = [], frameIndex = 0) {
  const tracked = [];
  if (!edits.length) return { data, tracked };
  const { width, height, channels } = info;
  for (const edit of edits) {
    if (!editApplies(edit, frameIndex)) continue;
    if (edit.type === "region-color") removeRegionColor(data, original, info, edit);
    else if (edit.type === "checker") removeChecker(data, original, info, edit.selection);
    else if (edit.type === "tracked-region") tracked.push({ strokeId: edit.strokeId, ...applyTrackedEdit(data, original, width, height, channels, edit, frameIndex) });
    else applyBrushEdit(data, original, width, height, channels, edit);
  }
  return { data, tracked };
}
