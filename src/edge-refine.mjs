// Conservative pixel-level cleanup. Everything works on a copy so the same options
// can be previewed, undone and applied to every frame without touching source files.
function removeNeutralWithoutLightArtwork(output, width, height) {
  const count = width * height;
  const bright = new Uint8Array(count);
  const fringe = new Uint8Array(count);
  const distance = new Uint8Array(count);
  distance.fill(255);
  const queue = new Int32Array(count);
  let tail = 0;
  for (let index = 0; index < count; index += 1) {
    const offset = index * 4;
    if (output[offset + 3] < 8) continue;
    const red = output[offset], green = output[offset + 1], blue = output[offset + 2];
    const minimum = Math.min(red, green, blue);
    const spread = Math.max(red, green, blue) - minimum;
    // The explicit palette choice protects the green needles, brown wood and
    // dark outline, including their pale coloured variations.
    if ((green >= red + 6 && green >= blue + 10)
      || (red >= green + 8 && green >= blue + 8)) continue;
    fringe[index] = Number(minimum >= 90 && spread <= 38);
    if (minimum < 125 || spread > 28) continue;
    bright[index] = 1;
    distance[index] = 0;
    queue[tail++] = index;
  }
  // Four-pixel band around every neutral light fragment. A second flood below
  // follows only connected neutral gray, so it cannot cross a coloured needle.
  for (let head = 0; head < tail; head += 1) {
    const at = queue[head];
    if (distance[at] >= 4) continue;
    const x = at % width, y = Math.floor(at / width);
    for (const next of [x > 0 ? at - 1 : -1, x + 1 < width ? at + 1 : -1,
      y > 0 ? at - width : -1, y + 1 < height ? at + width : -1]) {
      if (next < 0 || distance[next] !== 255) continue;
      distance[next] = distance[at] + 1;
      queue[tail++] = next;
    }
  }
  let head = 0;
  tail = 0;
  for (let index = 0; index < count; index += 1) if (bright[index]) queue[tail++] = index;
  const remove = Uint8Array.from(bright);
  for (; head < tail; head += 1) {
    const at = queue[head], x = at % width, y = Math.floor(at / width);
    for (const next of [x > 0 ? at - 1 : -1, x + 1 < width ? at + 1 : -1,
      y > 0 ? at - width : -1, y + 1 < height ? at + width : -1]) {
      if (next < 0 || remove[next] || !fringe[next] || distance[next] > 4) continue;
      remove[next] = 1;
      queue[tail++] = next;
    }
  }
  for (let index = 0; index < count; index += 1) if (remove[index]) output[index * 4 + 3] = 0;
}

function recolorContourFromDepth(output, width, height, contourWidth = 2, sampleDepth = 5, filter = {}) {
  const source = Buffer.from(output);
  const count = width * height;
  const distance = new Uint8Array(count);
  distance.fill(255);
  const queue = new Int32Array(count);
  let tail = 0;
  for (let at = 0; at < count; at += 1) {
    const x = at % width, y = Math.floor(at / width);
    if (source[at * 4 + 3] < 8) {
      distance[at] = 0;
      queue[tail++] = at;
    } else if (x === 0 || y === 0 || x + 1 === width || y + 1 === height) {
      distance[at] = 1;
      queue[tail++] = at;
    }
  }
  // Square rings: diagonal neighbors count as one pixel of contour width.
  for (let head = 0; head < tail; head += 1) {
    const at = queue[head], x = at % width, y = Math.floor(at / width);
    if (distance[at] >= 32) continue;
    for (let dy = -1; dy <= 1; dy += 1) {
      const py = y + dy;
      if (py < 0 || py >= height) continue;
      for (let dx = -1; dx <= 1; dx += 1) {
        const px = x + dx;
        if (px < 0 || px >= width) continue;
        const next = py * width + px;
        if (distance[next] !== 255 || source[next * 4 + 3] < 8) continue;
        distance[next] = distance[at] + 1;
        queue[tail++] = next;
      }
    }
  }
  for (let at = 0; at < count; at += 1) {
    const depth = distance[at];
    if (depth === 0 || depth > contourWidth || source[at * 4 + 3] < 8) continue;
    const x = at % width, y = Math.floor(at / width), offset = at * 4;
    if (filter.whiteOnly) {
      const minimum = Math.min(source[offset], source[offset + 1], source[offset + 2]);
      if (minimum < filter.threshold || Math.max(source[offset], source[offset + 1], source[offset + 2]) - minimum > filter.neutralTolerance) continue;
    }
    let localThickness = 0;
    for (let dy = -3; dy <= 3; dy += 1) for (let dx = -3; dx <= 3; dx += 1) {
      const px = x + dx, py = y + dy;
      if (px >= 0 && px < width && py >= 0 && py < height) {
        const nearby = py * width + px;
        if (source[nearby * 4 + 3] >= 200) localThickness = Math.max(localThickness, distance[nearby]);
      }
    }
    const inset = localThickness <= 2 ? Math.min(2, sampleDepth) : sampleDepth;
    const radius = inset + 2;
    let inwardX = 0, inwardY = 0;
    for (let dy = -radius; dy <= radius; dy += 1) {
      const py = y + dy;
      if (py < 0 || py >= height) continue;
      for (let dx = -radius; dx <= radius; dx += 1) {
        const px = x + dx;
        if (px < 0 || px >= width || dx * dx + dy * dy > radius * radius) continue;
        const candidate = py * width + px;
        if (source[candidate * 4 + 3] < 128) continue;
        const weight = Math.min(distance[candidate], 6) / (1 + (dx * dx + dy * dy) * .15);
        inwardX += dx * weight;
        inwardY += dy * weight;
      }
    }
    const directionLength = Math.hypot(inwardX, inwardY);
    if (directionLength < .2) continue;
    const directionX = inwardX / directionLength, directionY = inwardY / directionLength;
    const targetX = x + directionX * inset, targetY = y + directionY * inset;
    const redGreen = source[offset] - source[offset + 1];
    const greenBlue = source[offset + 1] - source[offset + 2];
    let best = -1, bestScore = Infinity;
    for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
      const px = Math.round(targetX) + dx, py = Math.round(targetY) + dy;
      if (px < 0 || px >= width || py < 0 || py >= height) continue;
      const candidate = py * width + px, candidateOffset = candidate * 4;
      if (source[candidateOffset + 3] < 200) continue;
      if (filter.whiteOnly) {
        const minimum = Math.min(source[candidateOffset], source[candidateOffset + 1], source[candidateOffset + 2]);
        if (minimum >= filter.threshold && Math.max(source[candidateOffset], source[candidateOffset + 1], source[candidateOffset + 2]) - minimum <= filter.neutralTolerance) continue;
      }
      const deltaX = px - x, deltaY = py - y;
      if (deltaX * directionX + deltaY * directionY < inset - 2) continue;
      const steps = Math.max(Math.abs(deltaX), Math.abs(deltaY));
      let connected = true;
      for (let step = 1; step < steps; step += 1) {
        const sx = x + Math.round(deltaX * step / steps), sy = y + Math.round(deltaY * step / steps);
        if (source[(sy * width + sx) * 4 + 3] < 8) { connected = false; break; }
      }
      if (!connected) continue;
      const hueDifference = Math.abs(redGreen - (source[candidateOffset] - source[candidateOffset + 1]))
        + Math.abs(greenBlue - (source[candidateOffset + 1] - source[candidateOffset + 2]));
      const score = ((px - targetX) ** 2 + (py - targetY) ** 2) * 25
        + hueDifference * .2 - Math.min(distance[candidate], 16) * 2;
      if (score < bestScore) { best = candidateOffset; bestScore = score; }
    }
    if (best < 0) continue;
    output[offset] = source[best];
    output[offset + 1] = source[best + 1];
    output[offset + 2] = source[best + 2];
  }
}

function recolorBrightResiduals(output, width, height) {
  const source = Buffer.from(output);
  const isResidual = (offset) => {
    const red = source[offset], green = source[offset + 1], blue = source[offset + 2];
    return Math.min(red, green, blue) >= 145
      && Math.max(red, green, blue) - Math.min(red, green, blue) <= 75;
  };
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4;
    if (source[offset + 3] < 8 || !isResidual(offset)) continue;
    const targetRG = source[offset] - source[offset + 1];
    const targetGB = source[offset + 1] - source[offset + 2];
    let best = -1, bestScore = Infinity;
    for (let dy = -6; dy <= 6; dy += 1) for (let dx = -6; dx <= 6; dx += 1) {
      const px = x + dx, py = y + dy;
      if (px < 0 || px >= width || py < 0 || py >= height || dx * dx + dy * dy > 36) continue;
      const candidate = (py * width + px) * 4;
      if (source[candidate + 3] < 200 || isResidual(candidate)) continue;
      const steps = Math.max(Math.abs(dx), Math.abs(dy));
      let connected = true;
      for (let step = 1; step < steps; step += 1) {
        const sx = x + Math.round(dx * step / steps), sy = y + Math.round(dy * step / steps);
        if (source[(sy * width + sx) * 4 + 3] < 8) { connected = false; break; }
      }
      if (!connected) continue;
      const hueDifference = Math.abs(targetRG - (source[candidate] - source[candidate + 1]))
        + Math.abs(targetGB - (source[candidate + 1] - source[candidate + 2]));
      const score = (dx * dx + dy * dy) * 12 + hueDifference * .4;
      if (score < bestScore) { best = candidate; bestScore = score; }
    }
    if (best < 0) continue;
    output[offset] = source[best];
    output[offset + 1] = source[best + 1];
    output[offset + 2] = source[best + 2];
  }
}
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
  if (options.noLightArtwork) {
    removeNeutralWithoutLightArtwork(output, width, height);
    const contourWidth = options.contourWidth === 4 ? 4 : 2;
    recolorContourFromDepth(output, width, height, contourWidth, Math.max(1, Math.min(32, Math.round(Number(options.depth) || 5))));
    recolorBrightResiduals(output, width, height);
  }
  if (options.autoPaleCleanup && !options.noLightArtwork && !removeSmallPalePockets(output, width, height)) {
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
  const depth = Math.max(1, Math.min(32, Math.round(Number(options.depth) || 5)));
  if (mode === "recolor") {
    recolorContourFromDepth(output, width, height, widthPx, depth, { whiteOnly: options.whiteOnly !== false, threshold, neutralTolerance });
    return output;
  }
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

  for (let index = 0; index < count; index += 1) {
    if (distance[index] >= 1 && distance[index] <= widthPx) output[index * 4 + 3] = 0;
  }
  return output;
}
