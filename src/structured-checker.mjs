// Evidence comes from alternation in two axes and a second-period match, not
// from a list of removable colours. Dark neutral contours alone are not seeds.
export function structuredCheckerMask(data, { width, height, channels = 4 }, selectionContains = () => true) {
  const tones = new Int16Array(width * height).fill(-1), votes = new Map();
  for (let i = 0; i < tones.length; i++) {
    const o = i * channels;
    if (data[o + 3] >= 32 && Math.max(data[o], data[o + 1], data[o + 2]) - Math.min(data[o], data[o + 1], data[o + 2]) <= 12) tones[i] = Math.round((data[o] + data[o + 1] + data[o + 2]) / 3);
  }
  for (let y = 0; y < height; y += Math.max(1, Math.floor(height / 96))) {
    let start = -1, previous = -1;
    for (let x = 0; x < width; x++) {
      const tone = tones[y * width + x];
      if (tone < 0) { start = previous = -1; continue; }
      if (previous >= 0 && Math.abs(tone - previous) >= 20) { const size = x - start; if (size >= 2 && size <= 128) votes.set(size, (votes.get(size) || 0) + 1); start = x; }
      else if (start < 0) start = x;
      previous = tone;
    }
  }
  const sizes = [...votes].filter(([, count]) => count >= 8).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([size]) => size);
  const mask = new Uint8Array(width * height), models = [];
  const at = (x, y) => x < 0 || y < 0 || x >= width || y >= height ? -1 : tones[y * width + x];
  const near = (a, b) => a >= 0 && b >= 0 && Math.abs(a - b) <= 10;
  let count = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const center = at(x, y), i = y * width + x;
    if (center < 0 || center >= 150 || !selectionContains((x + .5) / width, (y + .5) / height)) continue;
    for (const size of sizes) {
      let proved = false;
      for (const dx of [-size, size]) for (const dy of [-size, size]) {
        const h = at(x + dx, y), v = at(x, y + dy), diagonal = at(x + dx, y + dy);
        if (Math.abs(center - h) >= 20 && near(h, v) && near(center, diagonal) && near(center, at(x + 2 * dx, y)) && near(center, at(x, y + 2 * dy))) { proved = true; break; }
      }
      if (!proved) continue;
      mask[i] = 1; count++; if (!models.some(m => m.size === size)) models.push({ size, confidence: "structural", method: "two-axis-two-periods" }); break;
    }
  }
  // Add the matching lighter half only when the same multi-period test proves it.
  // Re-run with inverted luminance: geometry and evidence remain unchanged.
  if (count) {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * width + x, c = at(x, y);
      if (mask[i] || c < 0 || !selectionContains((x + .5) / width, (y + .5) / height)) continue;
      for (const { size } of models) {
        let proved = false;
        for (const dx of [-size, size]) for (const dy of [-size, size]) { const h = at(x + dx, y), v = at(x, y + dy); if (h >= 0 && Math.min(c, h) < 150 && Math.abs(c - h) >= 20 && near(h, v) && near(c, at(x + dx, y + dy)) && near(c, at(x + 2 * dx, y)) && near(c, at(x, y + 2 * dy))) proved = true; }
        if (proved) { mask[i] = 1; count++; break; }
      }
    }
  }
  return { mask, count, models, confidence: count >= 64 ? "high" : "insufficient" };
}
