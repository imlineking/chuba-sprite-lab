// A non-destructive quality hint for a white-background cutout. A compact white
// island can be leftover paper or a deliberate highlight, so this never edits alpha.
export function findWhiteRemainders(data, { width, height, channels }, keyColor) {
  const total = width * height;
  if (channels !== 4 || !Array.isArray(keyColor) || Math.min(...keyColor) < 230 || total > 12_000_000) return { count: 0, regions: [] };
  let transparent = 0;
  for (let index = 0; index < total; index += 1) if (data[index * 4 + 3] < 32) transparent += 1;
  if (transparent < total * .01) return { count: 0, regions: [] };

  const matches = (index) => {
    const offset = index * 4;
    if (data[offset + 3] < 224) return false;
    const r = data[offset]; const g = data[offset + 1]; const b = data[offset + 2];
    return Math.max(r, g, b) - Math.min(r, g, b) <= 12
      && Math.abs(r - keyColor[0]) <= 12 && Math.abs(g - keyColor[1]) <= 12 && Math.abs(b - keyColor[2]) <= 12;
  };
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  const regions = [];
  const minimumArea = Math.max(48, Math.ceil(total * .00008));
  for (let start = 0; start < total; start += 1) {
    if (visited[start]) continue;
    visited[start] = 1;
    if (!matches(start)) continue;
    let head = 0; let tail = 0;
    queue[tail++] = start;
    let minX = width; let minY = height; let maxX = 0; let maxY = 0;
    while (head < tail) {
      const at = queue[head++]; const x = at % width; const y = Math.floor(at / width);
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      for (const next of [x > 0 ? at - 1 : -1, x + 1 < width ? at + 1 : -1, y > 0 ? at - width : -1, y + 1 < height ? at + width : -1]) {
        if (next < 0 || visited[next]) continue;
        visited[next] = 1;
        if (matches(next)) queue[tail++] = next;
      }
    }
    const regionWidth = maxX - minX + 1; const regionHeight = maxY - minY + 1;
    if (tail >= minimumArea && regionWidth >= 8 && regionHeight >= 8 && tail / (regionWidth * regionHeight) >= .12) {
      regions.push({ x: minX, y: minY, width: regionWidth, height: regionHeight, pixels: tail });
    }
  }
  regions.sort((a, b) => b.pixels - a.pixels);
  return { count: regions.length, regions: regions.slice(0, 8) };
}
