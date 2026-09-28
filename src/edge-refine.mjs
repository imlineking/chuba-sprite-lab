// Conservative pixel-level cleanup. Everything works on a copy so the same options
// can be previewed, undone and applied to every frame without touching source files.
function removeSmallPalePockets(output, width, height) {
  const source = Buffer.from(output);
  const count = width * height;
  const pale = new Uint8Array(count);
  const core = new Uint8Array(count);
  let visible = 0;
  let bright = 0;
  for (let index = 0; index < count; index += 1) {
    const offset = index * 4;
    if (source[offset + 3] < 8) continue;
    visible += 1;
    const minimum = Math.min(source[offset], source[offset + 1], source[offset + 2]);
    const spread = Math.max(source[offset], source[offset + 1], source[offset + 2]) - minimum;
    pale[index] = Number(minimum >= 190 && spread <= 35);
    core[index] = Number(minimum >= 235 && spread <= 25);
    bright += core[index];
  }
  // Cream petals and white markings are artwork. On such images even a small
  // bright component at the silhouette must not be guessed away.
  if (!visible || bright / visible >= .008) return false;
  const visited = new Uint8Array(count);
  const queue = new Int32Array(count);
  let found = false;
  for (let seed = 0; seed < count; seed += 1) {
    if (!pale[seed] || visited[seed]) continue;
    let head = 0; let tail = 0; let brightPixels = 0; let openEdges = 0;
    let minX = width; let minY = height; let maxX = 0; let maxY = 0;
    visited[seed] = 1; queue[tail++] = seed;
    while (head < tail) {
      const at = queue[head++]; const x = at % width; const y = Math.floor(at / width);
      brightPixels += core[at];
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      for (const next of [x > 0 ? at - 1 : -1, x + 1 < width ? at + 1 : -1, y > 0 ? at - width : -1, y + 1 < height ? at + width : -1]) {
        if (next < 0) continue;
        if (source[next * 4 + 3] < 8) openEdges += 1;
        if (!pale[next] || visited[next]) continue;
        visited[next] = 1; queue[tail++] = next;
      }
    }
    const shortSide = Math.min(maxX - minX + 1, maxY - minY + 1);
    const longSide = Math.max(maxX - minX + 1, maxY - minY + 1);
    if (brightPixels < 12 || openEdges < 2 || longSide < shortSide * 1.5
      || tail > Math.max(192, Math.ceil(count * .006)) || tail > brightPixels * 4.5) continue;
    // A highlight on the outside of a leaf has artwork on one side only.
    // A trapped background slit is bordered by artwork on both sides of
    // several rows (or columns), even if one part opens into transparency.
    const rows = new Map(); const columns = new Map();
    for (let i = 0; i < tail; i += 1) {
      const at = queue[i], x = at % width, y = Math.floor(at / width);
      const row = rows.get(y) || [x, x]; row[0] = Math.min(row[0], x); row[1] = Math.max(row[1], x); rows.set(y, row);
      const column = columns.get(x) || [y, y]; column[0] = Math.min(column[0], y); column[1] = Math.max(column[1], y); columns.set(x, column);
    }
    let enclosedRows = 0; let enclosedColumns = 0;
    for (const [y, [left, right]] of rows) if (left > 0 && right + 1 < width) {
      const a = y * width + left - 1, b = y * width + right + 1;
      if (source[a * 4 + 3] >= 8 && source[b * 4 + 3] >= 8 && !pale[a] && !pale[b]) enclosedRows += 1;
    }
    for (const [x, [top, bottom]] of columns) if (top > 0 && bottom + 1 < height) {
      const a = (top - 1) * width + x, b = (bottom + 1) * width + x;
      if (source[a * 4 + 3] >= 8 && source[b * 4 + 3] >= 8 && !pale[a] && !pale[b]) enclosedColumns += 1;
    }
    if (Math.max(enclosedRows, enclosedColumns) < 3) continue;
    found = true;
    for (let i = 0; i < tail; i += 1) output[queue[i] * 4 + 3] = 0;
  }
  return found;
}

export function refineEdgeRgba(input, info, options = {}) {
  const { width, height, channels } = info;
  if (channels !== 4) throw new Error("Очистка кромки требует RGBA-кадр.");
  const output = Buffer.from(input);
  const count = width * height;
  if (options.autoPaleCleanup && !removeSmallPalePockets(output, width, height)) {
    // Even without a larger pocket, the next pass may repair a pale contour.
    // It is skipped when coherent white artwork dominates the image.
    let visible = 0; let bright = 0;
    for (let index = 0; index < count; index += 1) {
      const offset = index * 4;
      if (input[offset + 3] < 8) continue;
      visible += 1;
      const minimum = Math.min(input[offset], input[offset + 1], input[offset + 2]);
      if (minimum >= 235 && Math.max(input[offset], input[offset + 1], input[offset + 2]) - minimum <= 25) bright += 1;
    }
    if (visible && bright / visible >= .008) return output;
  }
  const threshold = Math.max(64, Math.min(255, Math.round(Number(options.whiteThreshold) || 235)));
  const neutralTolerance = Math.max(0, Math.min(96, Math.round(Number(options.neutralTolerance) || 32)));
  const isWhite = (index) => {
    const offset = index * 4;
    const minimum = Math.min(output[offset], output[offset + 1], output[offset + 2]);
    const maximum = Math.max(output[offset], output[offset + 1], output[offset + 2]);
    return output[offset + 3] >= 8 && minimum >= threshold && maximum - minimum <= neutralTolerance;
  };

  // Only a sizeable white component reaching the canvas border is treated as a
  // background. Enclosed white flowers and isolated highlights stay intact.
  if (options.removeWhiteExterior) {
    const visited = new Uint8Array(count);
    const queue = new Int32Array(count);
    for (let index = 0; index < count; index += 1) {
      const x = index % width; const y = Math.floor(index / width);
      if (x !== 0 && y !== 0 && x !== width - 1 && y !== height - 1) continue;
      if (visited[index] || !isWhite(index)) continue;
      let head = 0; let tail = 0; let border = 0;
      visited[index] = 1; queue[tail++] = index;
      while (head < tail) {
        const at = queue[head++]; const px = at % width; const py = Math.floor(at / width);
        if (px === 0 || py === 0 || px === width - 1 || py === height - 1) border += 1;
        for (const next of [px > 0 ? at - 1 : -1, px + 1 < width ? at + 1 : -1, py > 0 ? at - width : -1, py + 1 < height ? at + width : -1]) {
          if (next < 0 || visited[next] || !isWhite(next)) continue;
          visited[next] = 1; queue[tail++] = next;
        }
      }
      if (tail < Math.max(16, Math.ceil(count * .005)) || border < Math.max(4, Math.ceil(2 * (width + height) * .04))) continue;
      for (let i = 0; i < tail; i += 1) output[queue[i] * 4 + 3] = 0;
    }
  }

  const mode = options.mode === "trim" || options.mode === "recolor" ? options.mode : "none";
  if (mode === "none") return output;
  const widthPx = Math.max(1, Math.min(3, Math.round(Number(options.width) || 1)));
  const depth = Math.max(1, Math.min(5, Math.round(Number(options.depth) || 2)));
  const source = Buffer.from(output);
  const distance = new Int16Array(count);
  distance.fill(-1);
  const queue = new Int32Array(count);
  let tail = 0;
  for (let index = 0; index < count; index += 1) {
    const x = index % width; const y = Math.floor(index / width);
    if (source[index * 4 + 3] < 8 || x === 0 || y === 0 || x === width - 1 || y === height - 1) {
      distance[index] = source[index * 4 + 3] < 8 ? 0 : 1;
      queue[tail++] = index;
    }
  }
  // Breadth-first city-block distance from transparency or the outer canvas edge.
  for (let head = 0; head < tail; head += 1) {
    const at = queue[head]; const x = at % width; const y = Math.floor(at / width);
    for (const next of [x > 0 ? at - 1 : -1, x + 1 < width ? at + 1 : -1, y > 0 ? at - width : -1, y + 1 < height ? at + width : -1]) {
      if (next < 0 || distance[next] >= 0 || source[next * 4 + 3] < 8) continue;
      distance[next] = distance[at] + 1;
      queue[tail++] = next;
    }
  }

  const minInterior = Math.max(widthPx + 1, depth + 1);
  const radius = minInterior + widthPx + 2;
  for (let index = 0; index < count; index += 1) {
    if (distance[index] < 1 || distance[index] > widthPx || source[index * 4 + 3] < 8) continue;
    const offset = index * 4;
    if (mode === "trim") { output[offset + 3] = 0; continue; }
    if (options.whiteOnly !== false && !isWhite(index)) continue;
    const x = index % width; const y = Math.floor(index / width);
    let nearest = -1; let nearestDistance = Infinity;
    for (let dy = -radius; dy <= radius; dy += 1) {
      const sy = y + dy;
      if (sy < 0 || sy >= height) continue;
      for (let dx = -radius; dx <= radius; dx += 1) {
        const sx = x + dx;
        if (sx < 0 || sx >= width) continue;
        const candidate = sy * width + sx;
        if (distance[candidate] < minInterior || source[candidate * 4 + 3] < 200) continue;
        const candidateOffset = candidate * 4;
        if (options.whiteOnly !== false) {
          const minimum = Math.min(source[candidateOffset], source[candidateOffset + 1], source[candidateOffset + 2]);
          const maximum = Math.max(source[candidateOffset], source[candidateOffset + 1], source[candidateOffset + 2]);
          if (minimum >= threshold && maximum - minimum <= neutralTolerance) continue;
        }
        const score = dx * dx + dy * dy;
        if (score >= nearestDistance) continue;
        // Do not borrow colours across a transparent gap from another object.
        let connected = true;
        const steps = Math.max(Math.abs(dx), Math.abs(dy));
        for (let step = 1; step < steps; step += 1) {
          const lineX = Math.round(x + dx * step / steps);
          const lineY = Math.round(y + dy * step / steps);
          if (source[(lineY * width + lineX) * 4 + 3] < 8) { connected = false; break; }
        }
        if (connected) { nearest = candidateOffset; nearestDistance = score; }
      }
    }
    // Fine fur, grass and conifer needles can be only one or two pixels wide,
    // so they have no pixel at minInterior depth. In that case borrow the
    // nearest non-neutral colour from the same connected opaque stroke rather
    // than leaving a grey/white export fringe in place.
    if (nearest < 0) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        const sy = y + dy;
        if (sy < 0 || sy >= height) continue;
        for (let dx = -radius; dx <= radius; dx += 1) {
          const sx = x + dx;
          if (sx < 0 || sx >= width || (!dx && !dy)) continue;
          const candidate = sy * width + sx;
          const candidateOffset = candidate * 4;
          if (source[candidateOffset + 3] < 200) continue;
          const minimum = Math.min(source[candidateOffset], source[candidateOffset + 1], source[candidateOffset + 2]);
          const maximum = Math.max(source[candidateOffset], source[candidateOffset + 1], source[candidateOffset + 2]);
          if (minimum >= threshold && maximum - minimum <= neutralTolerance) continue;
          const score = dx * dx + dy * dy;
          if (score >= nearestDistance) continue;
          let connected = true;
          const steps = Math.max(Math.abs(dx), Math.abs(dy));
          for (let step = 1; step < steps; step += 1) {
            const lineX = Math.round(x + dx * step / steps);
            const lineY = Math.round(y + dy * step / steps);
            if (source[(lineY * width + lineX) * 4 + 3] < 8) { connected = false; break; }
          }
          if (connected) { nearest = candidateOffset; nearestDistance = score; }
        }
      }
    }
    if (nearest < 0) continue;
    output[offset] = source[nearest];
    output[offset + 1] = source[nearest + 1];
    output[offset + 2] = source[nearest + 2];
  }
  return output;
}
