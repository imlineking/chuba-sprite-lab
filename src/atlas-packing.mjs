import sharp from "sharp";

// Best short-side fit. Split every intersecting free rectangle, then discard
// contained rectangles. Stable input indices resolve ties, including rotation.
function maxRects(items, { limitW, limitH, gap, extrude, rotate }) {
  const ordered = items.map((item, index) => ({ item, index, w: item.width + 2 * extrude + gap, h: item.height + 2 * extrude + gap }))
    .sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || b.w * b.h - a.w * a.h || a.index - b.index);
  const largest = Math.max(1, ...ordered.map(i => i.w));
  const width = limitW ? (limitH ? limitW : Math.max(limitW, largest)) : Math.max(largest, Math.ceil(Math.sqrt(ordered.reduce((s, i) => s + i.w * i.h, 0))));
  const height = limitH || Math.max(1, ordered.reduce((s, i) => s + Math.max(i.w, i.h), 0));
  const pages = [];
  const newPage = () => ({ width: 0, height: 0, rects: [], free: [{ x: 0, y: 0, w: width, h: height }] });
  for (const entry of ordered) {
    let best;
    const consider = (page, pageIndex) => {
      page.free.forEach((free, freeIndex) => {
        for (const rotated of rotate && entry.w !== entry.h ? [false, true] : [false]) {
          const w = rotated ? entry.h : entry.w, h = rotated ? entry.w : entry.h;
          if (w > free.w || h > free.h) continue;
          const short = Math.min(free.w - w, free.h - h), long = Math.max(free.w - w, free.h - h);
          if (!best || short < best.short || short === best.short && long < best.long) best = { page, pageIndex, freeIndex, x: free.x, y: free.y, w, h, rotated, short, long };
        }
      });
    };
    pages.forEach(consider);
    if (!best) { const page = newPage(); pages.push(page); consider(page, pages.length - 1); }
    if (!best) throw new Error(`Кадр ${entry.item.width}×${entry.item.height} с отступами не помещается в лист ${width}×${height}.`);
    const { page, x, y, w, h, rotated } = best;
    const free = [];
    for (const r of page.free) {
      if (x >= r.x + r.w || x + w <= r.x || y >= r.y + r.h || y + h <= r.y) { free.push(r); continue; }
      if (x > r.x) free.push({ ...r, w: x - r.x });
      if (x + w < r.x + r.w) free.push({ ...r, x: x + w, w: r.x + r.w - x - w });
      if (y > r.y) free.push({ ...r, h: y - r.y });
      if (y + h < r.y + r.h) free.push({ ...r, y: y + h, h: r.y + r.h - y - h });
    }
    page.free = free.filter((a, i) => !free.some((b, j) => i !== j && a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h && (j < i || a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h)));
    page.rects.push({ item: entry.item, x: x + extrude, y: y + extrude, rotated });
    page.width = Math.max(page.width, x + w - gap);
    page.height = Math.max(page.height, y + h - gap);
  }
  return pages.map(({ free: _free, ...page }) => page);
}

export async function extrudeSprite(buffer, border) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const width = info.width + 2 * border, height = info.height + 2 * border;
  const output = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = Math.max(0, Math.min(info.width - 1, x - border)), sy = Math.max(0, Math.min(info.height - 1, y - border));
    data.copy(output, (y * width + x) * 4, (sy * info.width + sx) * 4, (sy * info.width + sx + 1) * 4);
  }
  return sharp(output, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

function layoutAtlas(groups, { packing, limitW = 0, limitH = 0, columnsOverride = null, gap = 2, extrude = 0, rotate = false }) {
  if (packing === "maxrects") return maxRects(groups.flatMap(group => group.items), { limitW, limitH, gap, extrude, rotate });
  const pages = [];
  let page = { width: 0, height: 0, rects: [] };
  const pushPage = () => { if (page.rects.length) pages.push(page); page = { width: 0, height: 0, rects: [] }; };
  if (packing === "tight") {
    const items = groups.flatMap((group) => group.items).map(item => ({ original: item, width: item.width + extrude * 2, height: item.height + extrude * 2 }));
    const totalArea = items.reduce((sum, item) => sum + (item.width + gap) * (item.height + gap), 0);
    const widest = Math.max(1, ...items.map((item) => item.width));
    const pageWidth = limitW || Math.max(widest, Math.ceil(Math.sqrt(totalArea * 1.15)));
    const ordered = [...items].sort((a, b) => b.height - a.height || b.width - a.width);
    let x = 0; let y = 0; let shelf = 0;
    for (const item of ordered) {
      if (x > 0 && x + item.width > pageWidth) { y += shelf + gap; x = 0; shelf = 0; }
      if (limitH && y + item.height > limitH && page.rects.length) { pushPage(); x = 0; y = 0; shelf = 0; }
      page.rects.push({ item: item.original, x: x + extrude, y: y + extrude, rotated: false });
      x += item.width + gap;
      shelf = Math.max(shelf, item.height);
      page.width = Math.max(page.width, x - gap);
      page.height = Math.max(page.height, y + item.height);
    }
    pushPage();
    return pages;
  }
  let y = 0;
  for (const group of groups) {
    let columns = columnsOverride?.(group) ?? group.columns;
    if (limitW) columns = Math.max(1, Math.min(columns, Math.floor(limitW / group.cellWidth)));
    for (let start = 0; start < group.items.length; start += columns) {
      if (limitH && y + group.cellHeight > limitH && page.rects.length) { pushPage(); y = 0; }
      group.items.slice(start, start + columns).forEach((item, column) => {
        page.rects.push({ item, x: column * group.cellWidth, y });
        page.width = Math.max(page.width, (column + 1) * group.cellWidth);
      });
      y += group.cellHeight;
      page.height = Math.max(page.height, y);
    }
    group.layoutColumns = columns;
  }
  pushPage();
  return pages;
}

function scaleHitbox(hitbox, scale) {
  if (!hitbox) return null;
  return { x: Math.round(hitbox.x * scale), y: Math.round(hitbox.y * scale), width: Math.max(1, Math.round(hitbox.width * scale)), height: Math.max(1, Math.round(hitbox.height * scale)) };
}

function scaleGroups(groups, scale) {
  return groups.map((group) => ({
    ...group,
    cellWidth: Math.max(1, Math.floor(group.cellWidth * scale)),
    cellHeight: Math.max(1, Math.floor(group.cellHeight * scale)),
    items: group.items.map((item) => ({ ...item, width: Math.max(1, Math.floor(item.width * scale)), height: Math.max(1, Math.floor(item.height * scale)), hitbox: scaleHitbox(item.hitbox, scale) })),
  }));
}

function pagesExceed(pages, limit) {
  return Boolean(limit) && pages.some((page) => page.width > limit || page.height > limit);
}

function floorPowerOfTwo(value) {
  let size = 1;
  while (size * 2 <= value) size *= 2;
  return size;
}

function padAtlasPages(pages, powerOfTwo) {
  if (!powerOfTwo) return pages;
  const ceilPowerOfTwo = (value) => {
    let size = 1;
    while (size < value) size *= 2;
    return size;
  };
  return pages.map((page) => ({ ...page, width: ceilPowerOfTwo(page.width), height: ceilPowerOfTwo(page.height) }));
}

export function planAtlas(groups, { packing = "grid", maxSize = 0, overflow = "warn", powerOfTwo = false, gap = 2, extrude = 0, rotate = false } = {}) {
  if (!Number.isInteger(gap) || gap < 0 || gap > 64 || !Number.isInteger(extrude) || extrude < 0 || extrude > 2) throw new Error("Padding атласа: 0–64 px; extrude: 0–2 px.");
  if (packing === "grid" && (extrude || rotate)) throw new Error("Для extrude / поворота выберите плотный атлас.");
  const limit = Number(maxSize) > 0 ? Number(maxSize) : 0;
  // A non-power-of-two CLI limit (for example 3000) can only fit a 2048 page.
  const layoutLimit = limit && powerOfTwo ? floorPowerOfTwo(limit) : limit;
  const tight = packing !== "grid";
  const layout = (plannedGroups, settings) => padAtlasPages(layoutAtlas(plannedGroups, { ...settings, gap, extrude, rotate }), powerOfTwo);
  const natural = layout(groups, { packing, limitW: tight ? layoutLimit : 0 });
  const naturalWidth = Math.max(...natural.map((page) => page.width));
  const naturalHeight = natural.reduce((sum, page) => Math.max(sum, page.height), 0);
  const exceeds = pagesExceed(natural, limit);
  const base = { exceeds, limit, naturalWidth, naturalHeight, requested: overflow, powerOfTwo: Boolean(powerOfTwo) };
  if (!exceeds || !limit || overflow === "warn") {
    return { ...base, pages: natural, groups, scale: 1, applied: exceeds ? "warn" : "none", note: exceeds ? `Лист ${naturalWidth}×${naturalHeight} больше ${limit} px` : "" };
  }
  const largestItem = Math.max(...groups.flatMap((group) => group.items.map((item) => Math.max(item.width, item.height) + extrude * 2 + gap)));
  if (overflow === "columns" && !tight) {
    const pages = layout(groups, { packing, columnsOverride: (group) => Math.max(1, Math.floor(layoutLimit / group.cellWidth)) });
    if (!pagesExceed(pages, limit)) return { ...base, pages, groups, scale: 1, applied: "columns", note: "Столбцы пересчитаны под лимит" };
  }
  if (overflow === "scale") {
    let scale = Math.min(1, layoutLimit / Math.max(1, naturalWidth), layoutLimit / Math.max(1, naturalHeight));
    if (tight) scale = Math.min(1, Math.sqrt((layoutLimit * layoutLimit) / Math.max(1, naturalWidth * naturalHeight)));
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const scaledGroups = scaleGroups(groups, scale);
      const pages = layout(scaledGroups, { packing, limitW: tight ? layoutLimit : 0 });
      if (!pagesExceed(pages, limit) && pages.length === 1) {
        return { ...base, pages, groups: scaledGroups, scale, applied: "scale", note: `Кадры уменьшены до ${Math.round(scale * 100)}%` };
      }
      scale *= 0.94;
    }
  }
  // Split into several pages; a single frame larger than the limit is scaled down first.
  const scale = largestItem > layoutLimit ? Math.max(0.001, (layoutLimit - 2 * extrude - gap) / (largestItem - 2 * extrude - gap)) : 1;
  const scaledGroups = scale < 1 ? scaleGroups(groups, scale) : groups;
  const pages = layout(scaledGroups, { packing, limitW: layoutLimit, limitH: layoutLimit });
  const note = overflow === "columns" && !tight ? "Столбцы не помогли — лист разбит на страницы" : `Разбито на листов: ${pages.length}`;
  return { ...base, pages, groups: scaledGroups, scale, applied: "split", note: scale < 1 ? `${note} · кадры уменьшены до ${Math.round(scale * 100)}%` : note };
}

