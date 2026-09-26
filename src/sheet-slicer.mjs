import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function averageCornerColor(data, width, height, channels) {
  const sample = Math.max(2, Math.round(Math.min(width, height) * 0.025));
  let red = 0; let green = 0; let blue = 0; let count = 0; let transparent = 0;
  for (const [startX, startY] of [[0, 0], [width - sample, 0], [0, height - sample], [width - sample, height - sample]]) {
    for (let y = startY; y < startY + sample; y += 1) {
      for (let x = startX; x < startX + sample; x += 1) {
        const offset = (y * width + x) * channels;
        if (data[offset + 3] < 16) { transparent += 1; continue; }
        red += data[offset]; green += data[offset + 1]; blue += data[offset + 2]; count += 1;
      }
    }
  }
  return { color: count ? [red / count, green / count, blue / count] : [255, 255, 255], transparent: transparent > count * 3 };
}

function connectedComponents(mask, width, height) {
  const visited = new Uint8Array(mask.length);
  const labels = new Uint32Array(mask.length);
  const queue = new Int32Array(mask.length);
  const components = [];
  let nextId = 0;
  for (let seed = 0; seed < mask.length; seed += 1) {
    if (!mask[seed] || visited[seed]) continue;
    let head = 0; let tail = 0; let minX = width; let minY = height; let maxX = -1; let maxY = -1;
    const componentId = ++nextId;
    visited[seed] = 1; queue[tail++] = seed;
    while (head < tail) {
      const index = queue[head++];
      labels[index] = componentId;
      const x = index % width; const y = Math.floor(index / width);
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dy) continue;
          const nx = x + dx; const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (!mask[next] || visited[next]) continue;
          visited[next] = 1; queue[tail++] = next;
        }
      }
    }
    if (tail >= 18) components.push({ id: componentId, left: minX, top: minY, right: maxX, bottom: maxY, area: tail, centerX: (minX + maxX) / 2, centerY: (minY + maxY) / 2 });
  }
  return { components, labels };
}

function clusterByCenter(items, coordinate, gap) {
  const ordered = [...items].sort((a, b) => a[coordinate] - b[coordinate]);
  const groups = [];
  for (const item of ordered) {
    const previous = groups.at(-1);
    if (!previous || item[coordinate] - previous.last > gap) groups.push({ items: [item], last: item[coordinate] });
    else { previous.items.push(item); previous.last = item[coordinate]; }
  }
  return groups.map((group) => group.items);
}

function unionBounds(items, width, height, padding) {
  const left = Math.max(0, Math.min(...items.map((item) => item.left)) - padding);
  const top = Math.max(0, Math.min(...items.map((item) => item.top)) - padding);
  const right = Math.min(width - 1, Math.max(...items.map((item) => item.right)) + padding);
  const bottom = Math.min(height - 1, Math.max(...items.map((item) => item.bottom)) + padding);
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

async function detectObjectCells(sheetPath, tolerance = 34, padding = 0, alphaOnly = false, attachFragments = false) {
  const { data, info } = await sharp(sheetPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const corner = averageCornerColor(data, width, height, channels);
  const background = corner.color;
  const thresholdSquared = clamp(Number(tolerance) || 34, 8, 120) ** 2;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels;
      const dr = data[offset] - background[0];
      const dg = data[offset + 1] - background[1];
      const db = data[offset + 2] - background[2];
      const foreground = data[offset + 3] >= 16 && (alphaOnly || corner.transparent || dr * dr + dg * dg + db * db > thresholdSquared);
      if (!foreground) continue;
      mask[y * width + x] = 1;
    }
  }
  const { components, labels } = connectedComponents(mask, width, height);
  if (attachFragments && components.length) {
    const largest = Math.max(...components.map(item => item.area));
    const major = components.filter(item => item.area >= Math.max(64, largest * 0.02));
    const maxGap = Math.max(12, Math.min(width, height) * 0.04);
    for (const fragment of components) {
      if (major.includes(fragment)) continue;
      let nearest = null; let best = Infinity;
      for (const object of major) {
        const dx = Math.max(object.left - fragment.right, fragment.left - object.right, 0);
        const dy = Math.max(object.top - fragment.bottom, fragment.top - object.bottom, 0);
        const distance = Math.hypot(dx, dy);
        const score = distance * 10000 + Math.hypot(fragment.centerX - object.centerX, fragment.centerY - object.centerY);
        if (distance <= maxGap && score < best) { nearest = object; best = score; }
      }
      // Keep every pixel and component label, but order nearby loose leaves with their tree.
      if (nearest) { fragment.centerX = nearest.centerX; fragment.centerY = nearest.centerY; }
    }
  }
  const rows = clusterByCenter(components, "centerY", Math.max(52, height * 0.115));
  const cells = [];
  for (const row of rows) {
    const columns = clusterByCenter(row, "centerX", Math.max(62, width * 0.105));
    for (const column of columns) cells.push({ ...unionBounds(column, width, height, padding), componentIds: column.map((item) => item.id) });
  }
  return { width, height, background: background.map(Math.round), cells, labels };
}

function validateManualCells(cells, width, height) {
  if (!Array.isArray(cells) || !cells.length || cells.length > 1000) throw new Error("Добавьте от 1 до 1000 рамок кадров.");
  return cells.map((cell, index) => {
    const values = [cell.left, cell.top, cell.width, cell.height].map(Number);
    if (!values.every(Number.isInteger)) throw new Error(`Рамка ${index + 1}: нужны целые координаты.`);
    const [left, top, cellWidth, cellHeight] = values;
    if (left < 0 || top < 0 || cellWidth < 1 || cellHeight < 1 || left + cellWidth > width || top + cellHeight > height) {
      throw new Error(`Рамка ${index + 1} выходит за границы исходного листа.`);
    }
    return { left, top, width: cellWidth, height: cellHeight };
  });
}

function uniformCells(width, height, rows, columns) {
  const cells = [];
  for (let row = 0; row < rows; row += 1) {
    const top = Math.round(row * height / rows);
    const bottom = Math.round((row + 1) * height / rows);
    for (let column = 0; column < columns; column += 1) {
      const left = Math.round(column * width / columns);
      const right = Math.round((column + 1) * width / columns);
      cells.push({ left, top, width: right - left, height: bottom - top });
    }
  }
  return cells;
}

export async function sliceSpriteSheet(sheetPath, outputDir, options = {}) {
  await fs.mkdir(outputDir, { recursive: true });
  const metadata = await sharp(sheetPath).metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  if (!width || !height) throw new Error("Не удалось прочитать размер спрайт-листа.");
  const mode = ["grid", "manual"].includes(options.mode) ? options.mode : "objects";
  let cells;
  let background = null;
  let labels = null;
  if (mode === "manual") {
    cells = validateManualCells(options.cells, width, height);
  } else if (mode === "grid") {
    cells = uniformCells(width, height, clamp(Math.round(Number(options.rows) || 1), 1, 64), clamp(Math.round(Number(options.columns) || 1), 1, 64));
  } else {
    const detected = await detectObjectCells(sheetPath, options.tolerance, options.padding, options.alphaOnly, options.attachFragments);
    cells = detected.cells;
    background = detected.background;
    labels = detected.labels;
  }
  if (!cells.length) throw new Error("На листе не удалось найти отдельные кадры. Попробуйте режим равномерной сетки.");
  const framePaths = [];
  for (let index = 0; index < cells.length; index += 1) {
    const framePath = path.join(outputDir, `${String(index).padStart(4, "0")}.png`);
    const cell = cells[index];
    const rect = { left: cell.left, top: cell.top, width: cell.width, height: cell.height };
    if (mode === "objects") {
      const { data, info } = await sharp(sheetPath).extract(rect).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const ids = new Set(cell.componentIds);
      for (let y = 0; y < rect.height; y += 1) for (let x = 0; x < rect.width; x += 1) {
        if (!ids.has(labels[(rect.top + y) * width + rect.left + x])) data[(y * rect.width + x) * info.channels + 3] = 0;
      }
      await sharp(data, { raw: info }).png().toFile(framePath);
    } else await sharp(sheetPath).extract(rect).png().toFile(framePath);
    framePaths.push(framePath);
  }
  return { mode, width, height, cells: cells.map(({ componentIds, ...cell }) => cell), framePaths, background };
}
