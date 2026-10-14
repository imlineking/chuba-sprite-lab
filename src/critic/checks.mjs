import { crop, createImage, detectBackground } from "../pipeline/image-ops.mjs";

// Objective, model-free acceptance checks on a built atlas. They always run first and
// their hard failures cannot be overridden by the visual critic.
// Input: the in-memory result of buildAtlas(..., { write: false }) or a loaded atlas
// ({ atlas, pages: [{ image }], config }). Output: { issues, metrics }.

export const severities = ["info", "warning", "error"];

function frameImage(result, frame) {
  const page = result.pages[frame.page]?.image;
  if (!page || frame.rotated) return null;
  return crop(page, frame.x, frame.y, frame.w, frame.h);
}

function opaqueCount(image) {
  let count = 0;
  for (let i = 3; i < image.rgba.length; i += 4) if (image.rgba[i] > 8) count += 1;
  return count;
}

/** Fraction of the outer pixel ring that is opaque and the share of its dominant colour. */
function borderRing(image) {
  const { width, height, rgba } = image;
  const colors = new Map();
  let ring = 0, opaque = 0;
  const visit = (x, y) => {
    ring += 1;
    const o = (y * width + x) * 4;
    if (rgba[o + 3] < 200) return;
    opaque += 1;
    const key = `${rgba[o] >> 4},${rgba[o + 1] >> 4},${rgba[o + 2] >> 4}`;
    colors.set(key, (colors.get(key) || 0) + 1);
  };
  for (let x = 0; x < width; x += 1) { visit(x, 0); if (height > 1) visit(x, height - 1); }
  for (let y = 1; y < height - 1; y += 1) { visit(0, y); if (width > 1) visit(width - 1, y); }
  const dominant = Math.max(0, ...colors.values());
  return { opaque: ring ? opaque / ring : 0, uniform: opaque ? dominant / opaque : 0 };
}

/** Share of interior pixels whose colour differs from the top-left corner. */
function interiorVariety(image) {
  const { width, height, rgba } = image;
  let differ = 0, total = 0;
  for (let y = 2; y < height - 2; y += 1) for (let x = 2; x < width - 2; x += 1) {
    const o = (y * width + x) * 4; total += 1;
    if (Math.abs(rgba[o] - rgba[0]) + Math.abs(rgba[o + 1] - rgba[1]) + Math.abs(rgba[o + 2] - rgba[2]) > 48) differ += 1;
  }
  return total ? differ / total : 0;
}

/** Alpha thumbnail of a frame placed in its source cell, for order/near-duplicate checks. */
function signature(image, frame, size = 12) {
  const { w: sw, h: sh } = frame.sourceSize;
  const out = new Float32Array(size * size);
  for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) {
    const a = image.rgba[(y * image.width + x) * 4 + 3] / 255;
    if (!a) continue;
    const gx = Math.min(size - 1, Math.floor(((x + frame.spriteSourceSize.x) / sw) * size));
    const gy = Math.min(size - 1, Math.floor(((y + frame.spriteSourceSize.y) / sh) * size));
    out[gy * size + gx] += a;
  }
  const total = out.reduce((s, v) => s + v, 0) || 1;
  return out.map((v) => v / total);
}
const distance = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0);

function stddev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
}

function issue(code, severity, target, reason, fix = null, extra = {}) {
  return { code, severity, source: "algorithm", hard: severity === "error", target, reason, fix, ...extra };
}

export function runChecks(result, { buildError = null } = {}) {
  const issues = [];
  const metrics = {};
  if (buildError) {
    const overflow = /does not fit/.test(buildError);
    issues.push(issue(overflow ? "atlas_overflow" : "build_failed", "error", { atlas: true },
      overflow ? `Кадр не помещается в страницу атласа: ${buildError}` : `Сборка не удалась: ${buildError}`,
      overflow ? { maxSize: 4096 } : null));
    return { issues, metrics: { buildFailed: true } };
  }
  const { atlas, config = {} } = result;
  const frames = atlas.frames;
  const images = new Map(frames.map((frame) => [frame.name, frameImage(result, frame)]));
  metrics.frames = frames.length;
  metrics.pages = atlas.pages.length;
  metrics.duplicates = frames.filter((f) => f.duplicateOf).length;

  // Atlas overflow: more than one page means the frames did not fit maxSize.
  if (atlas.pages.length > 1) {
    issues.push(issue("atlas_overflow", "warning", { atlas: true }, `Кадры не поместились в одну страницу ${config.maxSize || ""}px — получилось ${atlas.pages.length} страниц.`, { maxSize: Math.min(8192, (config.maxSize || 2048) * 2) }));
  }

  // Padding/extrude: placed rectangles (with extrude) must not overlap or touch.
  const extrude = config.extrude ?? 0;
  const placed = new Map();
  for (const frame of frames.filter((f) => !f.duplicateOf)) {
    const list = placed.get(frame.page) || []; placed.set(frame.page, list);
    const w = frame.rotated ? frame.h : frame.w, h = frame.rotated ? frame.w : frame.h;
    list.push({ name: frame.name, x: frame.x - extrude, y: frame.y - extrude, w: w + extrude * 2, h: h + extrude * 2 });
  }
  for (const list of placed.values()) for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) {
    const a = list[i], b = list[j];
    if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) issues.push(issue("padding_overlap", "error", { frame: a.name, other: b.name }, "Кадры в атласе перекрываются вместе с экструзией — будет просачивание при фильтрации.", { padding: Math.max(2, (config.padding ?? 0) + 2) }));
  }
  if ((config.extrude ?? 0) === 0 && (config.padding ?? 0) < 2) issues.push(issue("padding_small", "warning", { atlas: true }, "Нет экструзии и отступ меньше 2px — на GPU возможны швы между кадрами.", { padding: 2, extrude: 1 }));
  // Extrude correctness: the ring around each frame repeats its edge pixels.
  if (extrude > 0) {
    let bad = 0;
    for (const frame of frames.filter((f) => !f.duplicateOf && !f.rotated)) {
      const page = result.pages[frame.page].image;
      const px = (x, y) => page.rgba.readUInt32BE((y * page.width + x) * 4);
      if (frame.x - 1 >= 0 && px(frame.x - 1, frame.y) !== px(frame.x, frame.y)) bad += 1;
    }
    if (bad) issues.push(issue("extrude_broken", "error", { atlas: true }, `Экструзия не совпадает с краевыми пикселями у ${bad} кадров.`, { extrude }));
  }

  for (const frame of frames) {
    const image = images.get(frame.name);
    if (!image) continue;
    const count = opaqueCount(image);
    if (count < 4) { issues.push(issue("empty_frame", "error", { frame: frame.name, animation: frame.animation }, "Пустой кадр: нет видимых пикселей.", { slice: { mode: "auto" } })); continue; }
    const ring = borderRing(image);
    // Leftover background: content fills the whole source (nothing was transparent), the
    // outer ring is one opaque colour, and the inside holds other colours (the sprite).
    if (!frame.trimmed && image.width >= 8 && image.height >= 8 && ring.opaque > 0.85 && ring.uniform > 0.8 && interiorVariety(image) > 0.1) {
      issues.push(issue("leftover_background", "error", { frame: frame.name, animation: frame.animation }, "По краям кадра остался сплошной фон — фон не удалён.", { background: { mode: "auto", tolerance: 24 } }));
    }
    const s = frame.spriteSourceSize, src = frame.sourceSize;
    frame._touch = (s.x === 0) + (s.y === 0) + (s.x + s.w === src.w) + (s.y + s.h === src.h);
    frame._count = count;
  }

  // Per animation checks.
  const byAnimation = new Map();
  for (const frame of frames) { const list = byAnimation.get(frame.animation) || []; list.push(frame); byAnimation.set(frame.animation, list); }
  for (const [name, list] of byAnimation) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.index - b.index);
    // Missing frames: numbering gaps.
    const indices = list.map((f) => f.index);
    const missing = [];
    for (let i = indices[0]; i <= indices[indices.length - 1]; i += 1) if (!indices.includes(i)) missing.push(i);
    if (missing.length && missing.length <= list.length) issues.push(issue("missing_frame", "error", { animation: name, frames: missing }, `В анимации «${name}» пропущены кадры: ${missing.join(", ")}.`, null));
    // Inconsistent source sizes.
    const sizes = new Set(list.map((f) => `${f.sourceSize.w}x${f.sourceSize.h}`));
    // Auto slicing yields per-object sizes by design; only files and grid cells must match.
    if (sizes.size > 1 && config.slice?.mode !== "auto") issues.push(issue("inconsistent_size", "error", { animation: name }, `Кадры анимации «${name}» разного размера: ${[...sizes].join(", ")}.`, { trim: true, pivot: { x: 0.5, y: 1 } }));
    // Content area consistency and cut objects: a wrong grid cuts sprites at cell borders.
    const counts = list.map((f) => f._count || 0).filter(Boolean);
    const ratio = counts.length ? Math.max(...counts) / Math.max(1, Math.min(...counts)) : 1;
    const touching = list.filter((f) => (f._touch || 0) >= 1).length;
    metrics[`area_ratio:${name}`] = Number(ratio.toFixed(2));
    const grid = config.slice?.mode === "grid";
    if (grid && sizes.size === 1 && touching / list.length >= 0.5 && ratio > 1.8) {
      issues.push(issue("wrong_grid", "error", { animation: name }, `Сетка режет объекты: ${touching} из ${list.length} кадров касаются края ячейки, площадь отличается в ${ratio.toFixed(1)} раза.`, { slice: { mode: "auto" } }));
    } else if (grid && sizes.size === 1 && touching / list.length >= 0.5) {
      issues.push(issue("bleeding", "warning", { animation: name }, `Объекты касаются края ячейки в ${touching} из ${list.length} кадров — возможна обрезка или заход соседнего кадра.`, { slice: { mode: "auto" } }));
    }
    // Pivot jitter: feet line and horizontal centre within the animation.
    if (sizes.size === 1) {
      const feet = list.map((f) => f.spriteSourceSize.y + f.spriteSourceSize.h);
      const centers = list.map((f) => f.spriteSourceSize.x + f.spriteSourceSize.w / 2);
      const h = list[0].sourceSize.h, w = list[0].sourceSize.w;
      const jitter = Math.max(stddev(feet) / h, stddev(centers) / w);
      metrics[`pivot_jitter:${name}`] = Number(jitter.toFixed(3));
      if (jitter > 0.04) issues.push(issue("pivot_jitter", "warning", { animation: name }, `Опора «прыгает» между кадрами (разброс ${(jitter * 100).toFixed(1)}% размера кадра).`, { pivot: { x: 0.5, y: 1 }, anchor: "feet" }));
    }
    // Order by similarity: consecutive frames should be the most similar ones.
    if (list.length >= 4 && sizes.size === 1) {
      const sig = list.map((f) => signature(images.get(f.name) || createImage(1, 1), f));
      const steps = sig.slice(1).map((v, i) => distance(sig[i], v));
      const actual = steps.reduce((t, d) => t + d, 0);
      // Cheapest greedy chain over all start frames: a shuffled animation costs far more.
      let best = Infinity, bestOrder = null;
      for (let start = 0; start < sig.length; start += 1) {
        const order = [start], left = new Set(sig.keys()); left.delete(start);
        let cost = 0;
        while (left.size) { const last = order[order.length - 1]; let pick = null, d = Infinity; for (const k of left) { const dd = distance(sig[last], sig[k]); if (dd < d) { d = dd; pick = k; } } order.push(pick); left.delete(pick); cost += d; }
        if (cost < best) { best = cost; bestOrder = order; }
      }
      metrics[`order_ratio:${name}`] = Number((actual / Math.max(1e-6, best)).toFixed(2));
      if (actual > best * 1.5 && actual - best > 0.05) issues.push(issue("frame_order", "warning", { animation: name }, `Порядок кадров «${name}» похож на перепутанный: по сходству естественнее ${bestOrder.map((k) => list[k].index).join(", ")}.`, { sortBy: "similarity", order: bestOrder.map((k) => list[k].name) }));
      // Near duplicates are an algorithmic call (the model is unreliable here, M5).
      const near = steps.map((d, i) => (d < 0.01 && !list[i + 1].duplicateOf ? list[i + 1].name : null)).filter(Boolean);
      if (near.length) issues.push(issue("near_duplicate", "info", { animation: name, frames: near }, `Почти одинаковые соседние кадры: ${near.join(", ")}.`, null));
    }
  }
  for (const frame of frames) { delete frame._touch; delete frame._count; }
  // Background visible on whole page (corners agree and are opaque) is a strong signal too.
  for (const page of result.pages) if (page.image && detectBackground(page.image, 8)) issues.push(issue("leftover_background", "error", { atlas: true }, "Углы страницы атласа непрозрачны и одного цвета — фон не удалён.", { background: { mode: "auto", tolerance: 24 } }));
  return { issues, metrics };
}

const penalty = { error: 35, warning: 10, info: 0 };
export function algorithmicVerdict(issues) {
  const score = Math.max(0, 100 - issues.reduce((s, i) => s + penalty[i.severity], 0));
  const errors = issues.filter((i) => i.severity === "error");
  const verdict = errors.some((i) => i.code === "build_failed" || i.code === "atlas_overflow" || i.code === "empty_frame") || errors.length >= 3 ? "rejected" : errors.length || issues.some((i) => i.severity === "warning") ? "needs_fix" : "accepted";
  return { verdict, score: verdict === "accepted" ? Math.max(score, 80) : Math.min(score, verdict === "rejected" ? 39 : 79) };
}
