// MaxRects bin packer (Best Short Side Fit) with optional 90 degree rotation,
// power-of-two page sizes and multiple pages. Pure function: no image data here,
// only sizes, so it is cheap to test and to reuse from the CLI and the window.

function fits(free, w, h) { return w <= free.w && h <= free.h; }

function intersects(a, b) {
  return !(b.x >= a.x + a.w || b.x + b.w <= a.x || b.y >= a.y + a.h || b.y + b.h <= a.y);
}

function contains(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

class Bin {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.free = [{ x: 0, y: 0, w: width, h: height }];
    this.used = [];
  }

  find(w, h, rotate) {
    let best = null;
    for (const free of this.free) {
      for (const [cw, ch, rotated] of rotate && w !== h ? [[w, h, false], [h, w, true]] : [[w, h, false]]) {
        if (!fits(free, cw, ch)) continue;
        const shortSide = Math.min(free.w - cw, free.h - ch);
        const longSide = Math.max(free.w - cw, free.h - ch);
        if (!best || shortSide < best.shortSide || (shortSide === best.shortSide && longSide < best.longSide)) {
          best = { x: free.x, y: free.y, w: cw, h: ch, rotated, shortSide, longSide };
        }
      }
    }
    return best;
  }

  place(rect) {
    const next = [];
    for (const free of this.free) {
      if (!intersects(free, rect)) { next.push(free); continue; }
      if (rect.x > free.x) next.push({ x: free.x, y: free.y, w: rect.x - free.x, h: free.h });
      if (rect.x + rect.w < free.x + free.w) next.push({ x: rect.x + rect.w, y: free.y, w: free.x + free.w - rect.x - rect.w, h: free.h });
      if (rect.y > free.y) next.push({ x: free.x, y: free.y, w: free.w, h: rect.y - free.y });
      if (rect.y + rect.h < free.y + free.h) next.push({ x: free.x, y: rect.y + rect.h, w: free.w, h: free.y + free.h - rect.y - rect.h });
    }
    this.free = next.filter((a, i) => !next.some((b, j) => j !== i && contains(b, a) && (!contains(a, b) || j < i)));
    this.used.push(rect);
  }
}

function floorPowerOfTwo(value) {
  let size = 1;
  while (size * 2 <= value) size *= 2;
  return size;
}

function ceilPowerOfTwo(value) {
  let size = 1;
  while (size < value) size *= 2;
  return size;
}

/**
 * items: [{ id, w, h }] (sizes already include padding/extrude).
 * Returns { pages: [{ width, height, rects: [{ id, x, y, w, h, rotated }] }] }.
 * w/h in a rect are the occupied size (swapped when rotated).
 */
export function packMaxRects(items, { maxSize = 2048, rotate = false, powerOfTwo = false, square = false } = {}) {
  if (!Number.isInteger(maxSize) || maxSize < 1) throw new Error(`maxSize must be a positive integer, got ${maxSize}`);
  // With powerOfTwo the page must stay a power of two AND within maxSize, so the usable
  // side is the largest power of two <= maxSize (1000 -> 512), never rounded up past it.
  const limit = powerOfTwo ? floorPowerOfTwo(maxSize) : maxSize;
  const order = [...items].sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || b.w * b.h - a.w * a.h || String(a.id).localeCompare(String(b.id)));
  for (const item of order) {
    if (!(item.w <= limit && item.h <= limit)) throw new Error(`Frame "${item.id}" (${item.w}x${item.h}) does not fit into maxSize ${maxSize}${limit !== maxSize ? ` (power-of-two pages: largest page ${limit}x${limit})` : ""}`);
  }
  const bins = [];
  for (const item of order) {
    let placed = null;
    let bin = null;
    for (const candidate of bins) {
      placed = candidate.find(item.w, item.h, rotate);
      if (placed) { bin = candidate; break; }
    }
    if (!placed) {
      bin = new Bin(limit, limit);
      bins.push(bin);
      placed = bin.find(item.w, item.h, rotate);
    }
    const rect = { id: item.id, x: placed.x, y: placed.y, w: placed.w, h: placed.h, rotated: placed.rotated };
    bin.place(rect);
  }
  const pages = bins.map((bin) => {
    let width = Math.max(1, ...bin.used.map((r) => r.x + r.w));
    let height = Math.max(1, ...bin.used.map((r) => r.y + r.h));
    if (powerOfTwo) { width = Math.min(ceilPowerOfTwo(width), limit); height = Math.min(ceilPowerOfTwo(height), limit); }
    if (square) width = height = Math.max(width, height);
    return { width, height, rects: bin.used };
  });
  return { pages };
}
