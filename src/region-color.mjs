// Normalized selections are independent of display zoom and source dimensions.
export function selectionContains(selection, x, y) {
  if (!selection) return true;
  if (selection.points?.length >= 3) {
    let inside = false;
    const points = selection.points;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[i], b = points[j];
      if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }
  return x >= selection.left && x < selection.right && y >= selection.top && y < selection.bottom;
}

export function removeRegionColor(data, original, info, edit) {
  const colors = edit.colors || [edit.color];
  const threshold = Math.max(0, Math.min(150, Number(edit.tolerance) || 0)) ** 2;
  let removed = 0;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    if (!selectionContains(edit.selection, (x + .5) / info.width, (y + .5) / info.height)) continue;
    const offset = (y * info.width + x) * info.channels;
    if (!data[offset + 3]) continue;
    if (colors.some(color => Array.isArray(color) && color.length >= 3 && color.slice(0, 3).reduce((sum, value, c) => sum + (original[offset + c] - value) ** 2, 0) <= threshold)) {
      data[offset + 3] = 0; removed++;
    }
  }
  return removed;
}

// Require repeated alternation in BOTH axes. A gray/white colour alone is not
// sufficient evidence: white flowers and isolated highlights must survive.
export function checkerMask(data, { width, height, channels = 4 }, selection = null) {
  const gray = new Int16Array(width * height).fill(-1);
  for (let i = 0; i < gray.length; i++) {
    const o = i * channels, r = data[o], g = data[o + 1], b = data[o + 2];
    if (data[o + 3] >= 24 && Math.min(r, g, b) >= 150 && Math.max(r, g, b) - Math.min(r, g, b) <= 10) gray[i] = Math.round((r + g + b) / 3);
  }
  const votes = new Map();
  const step = Math.max(1, Math.floor(height / 96));
  for (let y = 0; y < height; y += step) {
    let start = -1, previous = -1;
    for (let x = 0; x < width; x++) {
      const value = gray[y * width + x];
      if (value < 0) { start = -1; previous = -1; continue; }
      if (previous >= 0 && Math.abs(value - previous) >= 15) {
        const run = x - start;
        if (start >= 0 && run >= 2 && run <= 128) votes.set(run, (votes.get(run) || 0) + 1);
        start = x;
      } else if (start < 0) start = x;
      previous = value;
    }
  }
  const sizes = [...votes].sort((a, b) => b[1] - a[1]).filter(item => item[1] >= 4).slice(0, 4).map(item => item[0]);
  const mask = new Uint8Array(width * height);
  let count = 0;
  const similar = (a, b) => a >= 0 && b >= 0 && Math.abs(a - b) <= 10;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, center = gray[i];
    if (center < 0 || !selectionContains(selection, (x + .5) / width, (y + .5) / height)) continue;
    for (const size of sizes) {
      let horizontal = false, vertical = false, diagonal = false;
      for (const dx of [-size, size]) for (const dy of [-size, size]) {
        if (x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
        const h = gray[y * width + x + dx], v = gray[(y + dy) * width + x], d = gray[(y + dy) * width + x + dx];
        if (h >= 0 && v >= 0 && Math.abs(center - h) >= 15 && similar(h, v) && similar(center, d)) {
          horizontal = vertical = diagonal = true;
        }
      }
      if (horizontal && vertical && diagonal) { mask[i] = 1; count++; break; }
    }
  }
  // The repeating pattern supplies evidence, not just the centre of each tile.
  // Follow its connected neutral background through partial tiles and narrow
  // gaps. Requiring a proven seed preserves disconnected white artwork.
  if (count) {
    const queue = new Int32Array(width * height);
    let head = 0, tail = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) queue[tail++] = i;
    while (head < tail) {
      const i = queue[head++], x = i % width, y = Math.floor(i / width);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const next = ny * width + nx;
        if (mask[next] || gray[next] < 0 || !selectionContains(selection, (nx + .5) / width, (ny + .5) / height)) continue;
        mask[next] = 1; count++; queue[tail++] = next;
      }
    }
    // Detached remnants need local evidence too. A background sliver may be
    // separated from the repeating tiles by one leaf, but a compact white
    // flower must not be treated as a sliver merely because it is white.
    const stride = width + 1, integral = new Int32Array(stride * (height + 1));
    for (let y = 0; y < height; y++) {
      let row = 0;
      for (let x = 0; x < width; x++) { row += mask[y * width + x]; integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row; }
    }
    const seen = mask.slice(), radius = Math.min(64, Math.max(...sizes) * 4);
    for (let start = 0; start < gray.length; start++) {
      if (seen[start] || gray[start] < 0) continue;
      head = 0; tail = 1; queue[0] = start; seen[start] = 1;
      let left = width, right = 0, top = height, bottom = 0, min = 255, max = 0, exposed = false, allowed = true;
      while (head < tail) {
        const i = queue[head++], x = i % width, y = Math.floor(i / width);
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
        min = Math.min(min, gray[i]); max = Math.max(max, gray[i]);
        if (!selectionContains(selection, (x + .5) / width, (y + .5) / height)) allowed = false;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) { exposed = true; continue; }
          const next = ny * width + nx;
          if (data[next * channels + 3] < 32 || mask[next]) exposed = true;
          if (seen[next] || gray[next] < 0) continue;
          seen[next] = 1; queue[tail++] = next;
        }
      }
      const x0 = Math.max(0, left - radius), x1 = Math.min(width, right + radius + 1), y0 = Math.max(0, top - radius), y1 = Math.min(height, bottom + radius + 1);
      const nearby = integral[y1 * stride + x1] - integral[y0 * stride + x1] - integral[y1 * stride + x0] + integral[y0 * stride + x0];
      const occupancy = tail / ((right - left + 1) * (bottom - top + 1));
      const brokenPattern = max - min >= 15 && tail >= 4;
      const thinRemnant = tail >= 6 && occupancy < .3 && min >= 235;
      if (allowed && exposed && nearby && (brokenPattern || thinRemnant)) {
        for (let j = 0; j < tail; j++) mask[queue[j]] = 1;
        count += tail;
      }
    }
  }
  return { mask, count, sizes };
}

export function removeChecker(data, original, info, selection) {
  const result = checkerMask(original, info, selection);
  for (let i = 0; i < result.mask.length; i++) if (result.mask[i]) data[i * info.channels + 3] = 0;
  let fringeCount = 0;
  // Recover colour from a nearby foreground sample only where a confirmed
  // checker pixel touches the rim. Fit C = alpha*F + (1-alpha)*B, rather than
  // deleting all pale colours or shrinking the silhouette.
  if (result.count) for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const i = y * info.width + x, o = i * info.channels;
    if (result.mask[i] || !data[o + 3] || !selectionContains(selection, (x + .5) / info.width, (y + .5) / info.height)) continue;
    const color = [original[o], original[o + 1], original[o + 2]];
    if (Math.min(...color) < 190 || Math.max(...color) - Math.min(...color) > 50) continue;
    let background = false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < info.width && ny >= 0 && ny < info.height && result.mask[ny * info.width + nx]) background = true;
    }
    if (!background) continue;
    let best = null;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= info.width || ny < 0 || ny >= info.height) continue;
      const j = ny * info.width + nx, offset = j * info.channels;
      const foreground = [original[offset], original[offset + 1], original[offset + 2]];
      if (result.mask[j] || original[offset + 3] < 200 || Math.min(...foreground) >= 170 || Math.max(...foreground) - Math.min(...foreground) < 35) continue;
      for (const b of [210, 255]) {
        const direction = foreground.map(value => value - b), denominator = direction.reduce((sum, value) => sum + value * value, 0);
        const alpha = direction.reduce((sum, value, c) => sum + value * (color[c] - b), 0) / denominator;
        if (alpha <= .02 || alpha >= .9) continue;
        const error = color.reduce((sum, value, c) => sum + (value - (b + alpha * direction[c])) ** 2, 0) / 3;
        const score = error + (dx * dx + dy * dy) * .5;
        if (error <= 36 && (!best || score < best.score)) best = { score, alpha, foreground };
      }
    }
    if (best) {
      data[o] = best.foreground[0]; data[o + 1] = best.foreground[1]; data[o + 2] = best.foreground[2];
      data[o + 3] = Math.min(data[o + 3], Math.round(original[o + 3] * best.alpha)); fringeCount++;
    }
  }
  result.fringeCount = fringeCount;
  return result;
}
