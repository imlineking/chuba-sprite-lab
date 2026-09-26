// A distance field separates a solid object's core from thin connected tails.
// It measures geometry only; it does not infer the meaning of the object.
function distanceLine(input, length, output, vertices, boundaries) {
  let last = 0; vertices[0] = 0; boundaries[0] = -Infinity; boundaries[1] = Infinity;
  for (let q = 1; q < length; q++) {
    let intersection;
    do {
      const p = vertices[last];
      intersection = ((input[q] + q * q) - (input[p] + p * p)) / (2 * (q - p));
      if (intersection <= boundaries[last]) last--;
      else break;
    } while (last >= 0);
    last++; vertices[last] = q; boundaries[last] = intersection; boundaries[last + 1] = Infinity;
  }
  last = 0;
  for (let q = 0; q < length; q++) {
    while (boundaries[last + 1] < q) last++;
    const offset = q - vertices[last]; output[q] = offset * offset + input[vertices[last]];
  }
}

export function findBodyAnchor(data, { width, height, channels = 4 }) {
  const columns = new Float64Array(width); const rows = new Float64Array(height);
  let total = 0;
  const paddedWidth = width + 2; const paddedHeight = height + 2;
  const distances = new Float64Array(paddedWidth * paddedHeight);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const alpha = data[(y * width + x) * channels + 3];
    if (alpha <= 12) continue;
    columns[x] += alpha; rows[y] += alpha; total += alpha;
    distances[(y + 1) * paddedWidth + x + 1] = 1e12;
  }
  const length = Math.max(paddedWidth, paddedHeight);
  const input = new Float64Array(length); const output = new Float64Array(length);
  const vertices = new Int32Array(length); const boundaries = new Float64Array(length + 1);
  for (let y = 0; y < paddedHeight; y++) {
    input.set(distances.subarray(y * paddedWidth, (y + 1) * paddedWidth));
    distanceLine(input, paddedWidth, output, vertices, boundaries);
    distances.set(output.subarray(0, paddedWidth), y * paddedWidth);
  }
  let maximum = 0;
  for (let x = 0; x < paddedWidth; x++) {
    for (let y = 0; y < paddedHeight; y++) input[y] = distances[y * paddedWidth + x];
    distanceLine(input, paddedHeight, output, vertices, boundaries);
    for (let y = 0; y < paddedHeight; y++) { distances[y * paddedWidth + x] = output[y]; maximum = Math.max(maximum, output[y]); }
  }
  const radius = Math.sqrt(maximum);
  if (radius >= Math.max(2, Math.min(width, height) * .08)) {
    let sumX = 0; let sumY = 0; let count = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (distances[(y + 1) * paddedWidth + x + 1] < maximum * .98) continue;
      sumX += x; sumY += y; count++;
    }
    if (count) return { x: sumX / count, y: sumY / count, radius, method: "dense-core" };
  }
  // Thin and hollow art has no reliable solid core: retain the mass-median anchor.
  const median = (weights, fallback) => {
    if (!total) return fallback;
    let sum = 0;
    for (let index = 0; index < weights.length; index++) { sum += weights[index]; if (sum >= total / 2) return index; }
    return fallback;
  };
  return { x: median(columns, width / 2), y: median(rows, height / 2), radius, method: "alpha-median" };
}
