// Pixel operations on plain RGBA buffers ({ width, height, rgba }). No sharp here, so
// every step is deterministic and testable on tiny synthetic images.

export function createImage(width, height) {
  return { width, height, rgba: Buffer.alloc(width * height * 4) };
}

export function crop(image, x, y, width, height) {
  const out = createImage(width, height);
  for (let row = 0; row < height; row += 1) {
    const start = ((y + row) * image.width + x) * 4;
    image.rgba.copy(out.rgba, row * width * 4, start, start + width * 4);
  }
  return out;
}

export function parseColor(value) {
  if (value && typeof value === "object") return { r: value.r | 0, g: value.g | 0, b: value.b | 0 };
  const hex = String(value).trim().replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(hex)) throw new Error(`Bad color "${value}", expected #rrggbb`);
  return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
}

function near(rgba, offset, key, tolerance) {
  return Math.abs(rgba[offset] - key.r) <= tolerance && Math.abs(rgba[offset + 1] - key.g) <= tolerance && Math.abs(rgba[offset + 2] - key.b) <= tolerance;
}

/**
 * Detects a solid background from the four corners. Returns the color or null when
 * the corners are transparent already or disagree (no reliable background).
 */
export function detectBackground(image, tolerance = 16) {
  const { width, height, rgba } = image;
  const corners = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]].map(([x, y]) => (y * width + x) * 4);
  if (corners.some((offset) => rgba[offset + 3] < 250)) return null;
  const first = { r: rgba[corners[0]], g: rgba[corners[0] + 1], b: rgba[corners[0] + 2] };
  if (!corners.every((offset) => near(rgba, offset, first, tolerance))) return null;
  return first;
}

/**
 * Turns the background transparent.
 * mode "key": every pixel near the color becomes transparent.
 * mode "auto": color from the corners, removed only where connected to the border
 * (so a white eye inside a white-background sprite survives).
 */
export function removeBackground(image, { mode = "auto", color = null, tolerance = 16 } = {}) {
  const out = { width: image.width, height: image.height, rgba: Buffer.from(image.rgba) };
  const key = color ? parseColor(color) : detectBackground(image, tolerance);
  if (!key) return { image: out, color: null };
  const { width, height, rgba } = out;
  if (mode === "key") {
    for (let offset = 0; offset < rgba.length; offset += 4) if (near(rgba, offset, key, tolerance)) rgba[offset + 3] = 0;
    return { image: out, color: key };
  }
  const visited = new Uint8Array(width * height);
  const stack = [];
  for (let x = 0; x < width; x += 1) stack.push(x, (height - 1) * width + x);
  for (let y = 0; y < height; y += 1) stack.push(y * width, y * width + width - 1);
  while (stack.length) {
    const index = stack.pop();
    if (visited[index]) continue;
    visited[index] = 1;
    const offset = index * 4;
    if (rgba[offset + 3] !== 0 && !near(rgba, offset, key, tolerance)) continue;
    rgba[offset + 3] = 0;
    const x = index % width;
    if (x > 0) stack.push(index - 1);
    if (x < width - 1) stack.push(index + 1);
    if (index >= width) stack.push(index - width);
    if (index < width * (height - 1)) stack.push(index + width);
  }
  return { image: out, color: key };
}

/** Bounding box of pixels with alpha > threshold, or null for an empty image. */
export function opaqueBounds(image, threshold = 0) {
  const { width, height, rgba } = image;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (rgba[(y * width + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Trims transparent borders; an empty frame keeps a single transparent pixel. */
export function trim(image, threshold = 0) {
  const bounds = opaqueBounds(image, threshold) ?? { x: 0, y: 0, width: 1, height: 1 };
  return { image: crop(image, bounds.x, bounds.y, bounds.width, bounds.height), offset: { x: bounds.x, y: bounds.y } };
}

/** Grid slicing by columns/rows or by cell size, with optional margin and spacing. */
export function sliceGrid(image, { cols, rows, cellWidth, cellHeight, margin = 0, spacing = 0 } = {}) {
  const cw = cellWidth || Math.floor((image.width - 2 * margin - spacing * ((cols || 1) - 1)) / (cols || 1));
  const ch = cellHeight || Math.floor((image.height - 2 * margin - spacing * ((rows || 1) - 1)) / (rows || 1));
  if (cw < 1 || ch < 1) throw new Error("Grid slicing produced an empty cell; check cols/rows or cell size");
  const cells = [];
  for (let y = margin; y + ch <= image.height - margin; y += ch + spacing) {
    for (let x = margin; x + cw <= image.width - margin; x += cw + spacing) cells.push({ x, y, width: cw, height: ch });
  }
  return cells;
}

/**
 * Auto slicing: 8-connected opaque islands, boxes closer than mergeDistance merged
 * (so a detached sword or eye stays with its body), ordered in reading order.
 */
export function sliceAuto(image, { threshold = 0, mergeDistance = 1, minSize = 2 } = {}) {
  const { width, height, rgba } = image;
  const label = new Int32Array(width * height).fill(-1);
  let boxes = [];
  for (let start = 0; start < width * height; start += 1) {
    if (label[start] !== -1 || rgba[start * 4 + 3] <= threshold) continue;
    const box = { x: width, y: height, x2: -1, y2: -1 };
    const stack = [start];
    label[start] = boxes.length;
    while (stack.length) {
      const index = stack.pop();
      const x = index % width, y = (index - x) / width;
      if (x < box.x) box.x = x;
      if (y < box.y) box.y = y;
      if (x > box.x2) box.x2 = x;
      if (y > box.y2) box.y2 = y;
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (label[next] === -1 && rgba[next * 4 + 3] > threshold) { label[next] = boxes.length; stack.push(next); }
      }
    }
    boxes.push(box);
  }
  const reach = mergeDistance + 1; // merge when at most mergeDistance empty pixels separate boxes
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i], b = boxes[j];
      if (a.x - reach <= b.x2 && b.x - reach <= a.x2 && a.y - reach <= b.y2 && b.y - reach <= a.y2) {
        boxes[i] = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2) };
        boxes.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }
  boxes = boxes.map((b) => ({ x: b.x, y: b.y, width: b.x2 - b.x + 1, height: b.y2 - b.y + 1 })).filter((b) => b.width >= minSize || b.height >= minSize);
  // Reading order: rows are boxes whose vertical centers overlap the first box of the row.
  boxes.sort((a, b) => a.y - b.y || a.x - b.x);
  const rowsOut = [];
  for (const box of boxes) {
    const row = rowsOut.find((r) => box.y < r.y + r.height && box.y + box.height > r.y);
    if (row) row.items.push(box); else rowsOut.push({ y: box.y, height: box.height, items: [box] });
  }
  return rowsOut.flatMap((row) => row.items.sort((a, b) => a.x - b.x));
}

/** Copies `image` into `target` at (x, y), repeating edge pixels `extrude` times. */
export function blit(target, image, x, y, { extrude = 0, rotated = false } = {}) {
  const source = rotated ? rotateClockwise(image) : image;
  for (let ty = -extrude; ty < source.height + extrude; ty += 1) {
    const sy = Math.min(source.height - 1, Math.max(0, ty));
    const dy = y + ty;
    if (dy < 0 || dy >= target.height) continue;
    for (let tx = -extrude; tx < source.width + extrude; tx += 1) {
      const sx = Math.min(source.width - 1, Math.max(0, tx));
      const dx = x + tx;
      if (dx < 0 || dx >= target.width) continue;
      source.rgba.copy(target.rgba, (dy * target.width + dx) * 4, (sy * source.width + sx) * 4, (sy * source.width + sx) * 4 + 4);
    }
  }
}

/** 90 degrees clockwise, the TexturePacker / Phaser convention for rotated frames. */
export function rotateClockwise(image) {
  const out = createImage(image.height, image.width);
  for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) {
    const nx = image.height - 1 - y, ny = x;
    image.rgba.copy(out.rgba, (ny * out.width + nx) * 4, (y * image.width + x) * 4, (y * image.width + x) * 4 + 4);
  }
  return out;
}

/** Minimal BMP decoder (sharp/libvips cannot read BMP): 24/32 bpp, uncompressed or bitfields. */
export function decodeBmp(buffer) {
  if (buffer.toString("latin1", 0, 2) !== "BM") throw new Error("Not a BMP file");
  const dataOffset = buffer.readUInt32LE(10);
  const width = buffer.readInt32LE(18);
  const rawHeight = buffer.readInt32LE(22);
  const bpp = buffer.readUInt16LE(28);
  const compression = buffer.readUInt32LE(30);
  if (![24, 32].includes(bpp) || ![0, 3].includes(compression)) throw new Error(`BMP ${bpp} bpp / compression ${compression} is not supported; convert to PNG`);
  const height = Math.abs(rawHeight);
  const bottomUp = rawHeight > 0;
  const stride = Math.ceil((width * bpp) / 32) * 4;
  const image = createImage(width, height);
  for (let y = 0; y < height; y += 1) {
    const row = dataOffset + (bottomUp ? height - 1 - y : y) * stride;
    for (let x = 0; x < width; x += 1) {
      const src = row + x * (bpp / 8);
      const dst = (y * width + x) * 4;
      image.rgba[dst] = buffer[src + 2];
      image.rgba[dst + 1] = buffer[src + 1];
      image.rgba[dst + 2] = buffer[src];
      image.rgba[dst + 3] = bpp === 32 ? buffer[src + 3] : 255;
    }
  }
  // Many writers leave alpha at 0 in 32 bpp files; treat an all-zero alpha as opaque.
  if (bpp === 32 && !image.rgba.some((value, index) => index % 4 === 3 && value !== 0)) for (let i = 3; i < image.rgba.length; i += 4) image.rgba[i] = 255;
  return image;
}

/** Minimal 32 bpp BMP encoder, used by tests to create synthetic BMP input. */
export function encodeBmp(image) {
  const stride = image.width * 4;
  const buffer = Buffer.alloc(54 + stride * image.height);
  buffer.write("BM", 0, "latin1");
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(image.width, 18);
  buffer.writeInt32LE(-image.height, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(32, 28);
  for (let i = 0; i < image.width * image.height; i += 1) {
    buffer[54 + i * 4] = image.rgba[i * 4 + 2];
    buffer[54 + i * 4 + 1] = image.rgba[i * 4 + 1];
    buffer[54 + i * 4 + 2] = image.rgba[i * 4];
    buffer[54 + i * 4 + 3] = image.rgba[i * 4 + 3];
  }
  return buffer;
}
