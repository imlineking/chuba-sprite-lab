// Evidence for a reviewable cleanup route, never a colour-based deletion mask.
// Paper and authored white can overlap in RGB: only a model may propose removal.
export function analyseAlphaResidue(data, { width, height }, { masks = false } = {}) {
  const count = width * height;
  const pale = new Uint8Array(count), seen = new Uint8Array(count);
  const paper = new Uint8Array(count), protectedLight = new Uint8Array(count);
  const queue = new Int32Array(count);
  const regions = [];
  let visible = 0, edgePixels = 0, neutralEdgePixels = 0, paperPixels = 0, paperRegions = 0, protectedPixels = 0;
  const neighbours = at => {
    const x = at % width, y = Math.floor(at / width);
    return [x ? at - 1 : -1, x + 1 < width ? at + 1 : -1, y ? at - width : -1, y + 1 < height ? at + width : -1];
  };
  for (let at = 0; at < count; at++) {
    const p = at * 4;
    if (data[p + 3] < 8) continue;
    visible++;
    const lo = Math.min(data[p], data[p + 1], data[p + 2]);
    const hi = Math.max(data[p], data[p + 1], data[p + 2]);
    const edge = neighbours(at).some(n => n < 0 || data[n * 4 + 3] < 8);
    if (edge) { edgePixels++; if (lo >= 120 && hi - lo <= 45) neutralEdgePixels++; }
    if (lo >= 145 && hi - lo <= 65) pale[at] = 1;
  }
  for (let seed = 0; seed < count; seed++) {
    if (!pale[seed] || seen[seed]) continue;
    let head = 0, tail = 1, open = 0, inside = 0, flat = 0, pairs = 0, sum = 0;
    const colours = new Map(); seen[seed] = 1; queue[0] = seed;
    while (head < tail) {
      const at = queue[head++], p = at * 4;
      const ns = neighbours(at);
      const isOpen = ns.some(n => n < 0 || data[n * 4 + 3] < 8);
      if (isOpen) open++; else inside++;
      sum += Math.min(data[p], data[p + 1], data[p + 2]);
      const colour = (data[p] >> 3 << 10) | (data[p + 1] >> 3 << 5) | (data[p + 2] >> 3);
      colours.set(colour, (colours.get(colour) || 0) + 1);
      for (const n of ns) {
        if (n < 0 || !pale[n]) continue;
        if (n > at) { pairs++; if (Math.max(...[0, 1, 2].map(c => Math.abs(data[p + c] - data[n * 4 + c]))) <= 6) flat++; }
        if (!seen[n]) { seen[n] = 1; queue[tail++] = n; }
      }
      const x = at % width, y = Math.floor(at / width);
      for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const xx = x + dx, yy = y + dy, n = yy * width + xx;
        if (xx >= 0 && xx < width && yy >= 0 && yy < height && pale[n] && !seen[n]) { seen[n] = 1; queue[tail++] = n; }
      }
    }
    const dominant = Math.max(...colours.values()) / tail;
    if (tail >= 30) regions.push({ pixels: tail, open, inside, mean: sum / tail, dominant, flatShare: pairs ? flat / pairs : 0 });
    // This is deliberately a suspicion, not a claim that a pale component is paper.
    // ToonOut decides which of its pixels are background, within the original alpha.
    const suspicious = tail >= 24 && (open >= 2 || tail >= 48);
    if (suspicious) { paperRegions++; paperPixels += tail; }
    // Coherent bark/petals/metal are protected from RGB fringe repainting.
    const protect = tail >= 8 && inside >= 2;
    for (let i = 0; i < tail; i++) {
      // Small disconnected flecks participate in the semantic proposal too;
      // only the sizeable components above are allowed to trigger inference.
      paper[queue[i]] = 1;
      if (protect) { protectedLight[queue[i]] = 1; protectedPixels++; }
    }
  }
  return { visible, edgePixels, neutralEdgePixels, neutralEdgeShare: edgePixels ? neutralEdgePixels / edgePixels : 0,
    paperPixels, paperRegions, protectedPixels, regions: regions.sort((a, b) => b.pixels - a.pixels).slice(0, 20), ...(masks ? { paper, protectedLight } : {}) };
}

/** Restrict a semantic proposal to suspect neutral components, not the whole sprite. */
export function applyResidueMask(original, proposed, info) {
  const evidence = analyseAlphaResidue(original, info, { masks: true });
  const output = Buffer.from(original);
  let alphaChanged = 0;
  for (let at = 0; at < info.width * info.height; at++) {
    if (!evidence.paper[at]) continue;
    const p = at * 4 + 3, value = Math.min(original[p], proposed[p]);
    if (value !== original[p]) { output[p] = value; alphaChanged++; }
  }
  return { data: output, report: { alphaChanged, candidatePixels: evidence.paper.reduce((sum, value) => sum + value, 0), triggerPixels: evidence.paperPixels, candidateRegions: evidence.paperRegions,
    protectedPixels: evidence.protectedPixels, rgbChanged: 0, geometryChanged: false, reviewRequired: true } };
}
