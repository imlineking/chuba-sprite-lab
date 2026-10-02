// Selection is a mask of source pixels, independent of display zoom. Wand uses
// four-connectivity, so touching only at a corner does not join two figures.
export function makePixelSelection(data, width, height, { mode = "rect", from = [0, 0], to = from, tolerance = 24, points = [] } = {}) {
  const mask = new Uint8Array(width * height);
  const containsPolygon = (x, y) => {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) { const a = points[i], b = points[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside; }
    return inside;
  };
  if (mode === "wand") {
    const x = Math.round(from[0]), y = Math.round(from[1]);
    if (x < 0 || y < 0 || x >= width || y >= height) return mask;
    const seed = y * width + x, colour = data.subarray(seed * 4, seed * 4 + 4), visited = new Uint8Array(mask.length), queue = new Int32Array(mask.length);
    let head = 0, tail = 1; queue[0] = seed; visited[seed] = 1;
    const threshold = Math.max(0, Math.min(255, Number(tolerance) || 0)) ** 2;
    while (head < tail) {
      const i = queue[head++], ix = i % width, iy = Math.floor(i / width), o = i * 4;
      if (Math.abs(data[o + 3] - colour[3]) > Math.sqrt(threshold) || colour.slice(0, 3).reduce((sum, c, k) => sum + (data[o + k] - c) ** 2, 0) > threshold) continue;
      mask[i] = 1;
      for (const [nx, ny] of [[ix - 1, iy], [ix + 1, iy], [ix, iy - 1], [ix, iy + 1]]) if (nx >= 0 && ny >= 0 && nx < width && ny < height) { const next = ny * width + nx; if (!visited[next]) { visited[next] = 1; queue[tail++] = next; } }
    }
  } else {
    if (mode === "lasso" && points.length) { from = [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1]))]; to = [Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))]; }
    const left = Math.max(0, Math.min(from[0], to[0])), right = Math.min(width - 1, Math.max(from[0], to[0]));
    const top = Math.max(0, Math.min(from[1], to[1])), bottom = Math.min(height - 1, Math.max(from[1], to[1]));
    for (let y = Math.floor(top); y <= bottom; y++) for (let x = Math.floor(left); x <= right; x++) if (mode !== "lasso" || points.length >= 3 && containsPolygon(x + .5, y + .5)) mask[y * width + x] = 1;
  }
  return mask;
}

export function moveSelectedPixels(data, width, height, mask, { dx = 0, dy = 0, erase = false, copy = false } = {}) {
  const result = Buffer.from(data), original = Buffer.from(data), shifted = new Uint8Array(mask.length);
  dx = Math.round(Number(dx) || 0); dy = Math.round(Number(dy) || 0);
  // Clear all source pixels first; overlapping destinations then read ORIGINAL.
  if (!copy || erase) for (let i = 0; i < mask.length; i++) if (mask[i]) result.fill(0, i * 4, i * 4 + 4);
  if (!erase) for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || !original[i * 4 + 3]) continue;
    const x = i % width + dx, y = Math.floor(i / width) + dy;
    if (x < 0 || y < 0 || x >= width || y >= height) throw new Error("Перемещение обрежет выделенные пиксели. Уменьшите сдвиг.");
    const target = y * width + x; original.copy(result, target * 4, i * 4, i * 4 + 4); shifted[target] = 1;
  }
  return { data: result, mask: erase ? mask : shifted };
}
