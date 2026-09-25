// Conservative pixel-level cleanup. Everything works on a copy so the same options
// can be previewed, undone and applied to every frame without touching source files.
export function refineEdgeRgba(input, info, options = {}) {
  const { width, height, channels } = info;
  if (channels !== 4) throw new Error("Очистка кромки требует RGBA-кадр.");
  const output = Buffer.from(input);
  const count = width * height;
  const threshold = Math.max(200, Math.min(255, Math.round(Number(options.whiteThreshold) || 235)));
  const isWhite = (index) => {
    const offset = index * 4;
    return output[offset + 3] >= 8 && output[offset] >= threshold && output[offset + 1] >= threshold && output[offset + 2] >= threshold;
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
    if (options.whiteOnly !== false && !(source[offset] >= threshold && source[offset + 1] >= threshold && source[offset + 2] >= threshold)) continue;
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
        if (options.whiteOnly !== false && source[candidateOffset] >= threshold && source[candidateOffset + 1] >= threshold && source[candidateOffset + 2] >= threshold) continue;
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
    if (nearest < 0) continue;
    output[offset] = source[nearest];
    output[offset + 1] = source[nearest + 1];
    output[offset + 2] = source[nearest + 2];
  }
  return output;
}
