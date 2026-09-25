import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function averageCornerColor(data, width, height, channels) {
  const sample = Math.max(2, Math.round(Math.min(width, height) * 0.025));
  let red = 0; let green = 0; let blue = 0; let count = 0;
  for (const [startX, startY] of [[0, 0], [width - sample, 0], [0, height - sample], [width - sample, height - sample]]) {
    for (let y = startY; y < startY + sample; y += 1) {
      for (let x = startX; x < startX + sample; x += 1) {
        const offset = (y * width + x) * channels;
        if (data[offset + 3] < 16) continue;
        red += data[offset]; green += data[offset + 1]; blue += data[offset + 2]; count += 1;
      }
    }
  }
  return count ? [red / count, green / count, blue / count] : [255, 255, 255];
}

function connectedComponents(mask, width, height) {
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const components = [];
  for (let seed = 0; seed < mask.length; seed += 1) {
    if (!mask[seed] || visited[seed]) continue;
    let head = 0; let tail = 0; let minX = width; let minY = height; let maxX = -1; let maxY = -1;
    visited[seed] = 1; queue[tail++] = seed;
    while (head < tail) {
      const index = queue[head++];
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
    if (tail >= 18) components.push({ left: minX, top: minY, right: maxX, bottom: maxY, area: tail, centerX: (minX + maxX) / 2, centerY: (minY + maxY) / 2 });
  }
  return components;
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

async function detectObjectCells(sheetPath, tolerance = 34, padding = 8) {
  const { data, info } = await sharp(sheetPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const background = averageCornerColor(data, width, height, channels);
  const thresholdSquared = clamp(Number(tolerance) || 34, 8, 120) ** 2;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels;
      const dr = data[offset] - background[0];
      const dg = data[offset + 1] - background[1];
      const db = data[offset + 2] - background[2];
      const foreground = data[offset + 3] >= 16 && dr * dr + dg * dg + db * db > thresholdSquared;
      if (!foreground) continue;
      mask[y * width + x] = 1;
    }
  }
  const components = connectedComponents(mask, width, height);
  const rows = clusterByCenter(components, "centerY", Math.max(52, height * 0.115));
  const cells = [];
  for (const row of rows) {
    const columns = clusterByCenter(row, "centerX", Math.max(62, width * 0.105));
    for (const column of columns) cells.push(unionBounds(column, width, height, padding));
  }
  return { width, height, background: background.map(Math.round), cells };
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
  const mode = options.mode === "grid" ? "grid" : "objects";
  let cells;
  let background = null;
  if (mode === "grid") {
    cells = uniformCells(width, height, clamp(Math.round(Number(options.rows) || 1), 1, 64), clamp(Math.round(Number(options.columns) || 1), 1, 64));
  } else {
    const detected = await detectObjectCells(sheetPath, options.tolerance, options.padding);
    cells = detected.cells;
    background = detected.background;
  }
  if (!cells.length) throw new Error("На листе не удалось найти отдельные кадры. Попробуйте режим равномерной сетки.");
  const framePaths = [];
  for (let index = 0; index < cells.length; index += 1) {
    const framePath = path.join(outputDir, `${String(index).padStart(4, "0")}.png`);
    await sharp(sheetPath).extract(cells[index]).png().toFile(framePath);
    framePaths.push(framePath);
  }
  return { mode, width, height, cells, framePaths, background };
}
