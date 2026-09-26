// Colour bins are diagnostic only. A JPEG/noisy flat backdrop can straddle many bin boundaries.
export function analyseBorderBackground(data, { width, height, channels = 4 }, tolerance = 12) {
  const pixels = [];
  let total = 0, transparent = 0;
  const add = (x, y) => {
    const offset = (y * width + x) * channels;
    total++;
    if (data[offset + 3] < 16) { transparent++; return; }
    if (data[offset + 3] >= 249) pixels.push([data[offset], data[offset + 1], data[offset + 2]]);
  };
  for (let x = 0; x < width; x++) { add(x, 0); if (height > 1) add(x, height - 1); }
  for (let y = 1; y < height - 1; y++) { add(0, y); if (width > 1) add(width - 1, y); }
  const median = [0, 1, 2].map(channel => pixels.map(pixel => pixel[channel]).sort((a, b) => a - b)[Math.floor(pixels.length / 2)] ?? 255);
  const distances = pixels.map(pixel => Math.max(...pixel.map((value, channel) => Math.abs(value - median[channel]))));
  const matching = pixels.filter((_pixel, index) => distances[index] <= tolerance);
  const colour = [0, 1, 2].map(channel => matching.length ? Math.round(matching.reduce((sum, pixel) => sum + pixel[channel], 0) / matching.length) : median[channel]);
  const opaqueRatio = pixels.length / Math.max(1, total);
  const solidRatio = matching.length / Math.max(1, pixels.length);
  const noise = [...distances].sort((a, b) => a - b)[Math.floor(distances.length * 0.9)] || 0;
  return { colour, opaqueRatio, transparentRatio: transparent / Math.max(1, total), solidRatio, noise,
    solid: opaqueRatio > 0.72 && solidRatio >= 0.92 };
}

export function backgroundKeyMode(border) {
  if (border.transparentRatio > 0.55) return "alpha";
  if (!border.solid) return "ai";
  const [r, g, b] = border.colour;
  if (Math.max(r, g, b) < 26) return "black";
  if (Math.min(r, g, b) > 235) return "white";
  if (Math.hypot(r, g - 255, b) < 60) return "green";
  if (Math.hypot(r, g, b - 255) < 60) return "blue";
  return "auto";
}
