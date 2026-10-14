// Golden fixtures for the acceptance critic: clean inputs and deliberately broken ones.
// Generated on the fly into a temp folder (no binary fixtures in the repo).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

const W = 32, H = 40;
function canvas(w, h, bg = null) {
  const rgba = Buffer.alloc(w * h * 4);
  if (bg) for (let i = 0; i < w * h; i += 1) rgba.set(bg, i * 4);
  return { w, h, rgba };
}
function rect(img, x, y, w, h, color) {
  for (let yy = Math.max(0, y); yy < Math.min(img.h, y + h); yy += 1) for (let xx = Math.max(0, x); xx < Math.min(img.w, x + w); xx += 1) img.rgba.set(color, (yy * img.w + xx) * 4);
}
/** A small character: body, head, and an arm whose position encodes the animation phase. */
export function figure(phase, { dx = 0, dy = 0, bg = null, w = W, h = H } = {}) {
  const img = canvas(w, h, bg);
  const ox = Math.round(w / 2 - 6) + dx, foot = h - 4 + dy;
  rect(img, ox, foot - 22, 12, 18, [40, 90, 200, 255]);
  rect(img, ox + 2, foot - 30, 8, 8, [230, 190, 150, 255]);
  rect(img, ox + 2, foot - 4, 3, 4, [30, 30, 30, 255]); rect(img, ox + 7, foot - 4, 3, 4, [30, 30, 30, 255]);
  const armY = foot - 20 + Math.round(phase * 12);
  rect(img, ox + 12, armY, 4, 4, [200, 60, 60, 255]);
  return img;
}
async function save(img, file) { await sharp(img.rgba, { raw: { width: img.w, height: img.h, channels: 4 } }).png().toFile(file); }
async function sheet(frames, file) {
  const out = canvas(frames.length * frames[0].w, frames[0].h, null);
  frames.forEach((f, i) => { for (let y = 0; y < f.h; y += 1) f.rgba.copy(out.rgba, (y * out.w + i * f.w) * 4, y * f.w * 4, (y + 1) * f.w * 4); });
  await save(out, file);
}

export async function makeGoldenCases(root) {
  const dir = root || await fs.mkdtemp(path.join(os.tmpdir(), "sl-critic-"));
  const cases = [];
  const add = async (id, expectBad, build, write) => { const input = path.join(dir, id); await fs.mkdir(input, { recursive: true }); await write(input); cases.push({ id, expectBad, config: { name: id, input: [input], output: path.join(dir, `${id}-out`), formats: ["texturepacker-hash"], ...build } }); };
  const phases = [0, 0.2, 0.4, 0.6, 0.8, 1];
  // Clean.
  await add("clean-walk", false, { pivot: { x: 0.5, y: 1 } }, async (d) => { for (const [i, p] of phases.entries()) await save(figure(p), path.join(d, `walk_0${i}.png`)); });
  await add("clean-sheet-grid", false, { slice: { mode: "grid", cols: 4, rows: 1 } }, async (d) => sheet(phases.slice(0, 4).map((p) => figure(p)), path.join(d, "idle.png")));
  await add("clean-bg-removed", false, { background: { mode: "auto", tolerance: 16 } }, async (d) => { for (const [i, p] of phases.slice(0, 4).entries()) await save(figure(p, { bg: [255, 0, 255, 255] }), path.join(d, `hop_0${i}.png`)); });
  await add("clean-props", false, {}, async (d) => { for (const name of ["coin", "key", "gem"]) { const img = canvas(20, 20); rect(img, 4, 4, 12, 12, name === "coin" ? [240, 200, 40, 255] : name === "key" ? [150, 150, 160, 255] : [60, 200, 120, 255]); await save(img, path.join(d, `${name}.png`)); } });
  // Broken.
  await add("broken-leftover-bg", true, { background: "none" }, async (d) => { for (const [i, p] of phases.slice(0, 4).entries()) await save(figure(p, { bg: [255, 0, 255, 255] }), path.join(d, `hop_0${i}.png`)); });
  await add("broken-wrong-grid", true, { slice: { mode: "grid", cols: 3, rows: 1 } }, async (d) => sheet(phases.slice(0, 4).map((p) => figure(p)), path.join(d, "idle.png")));
  await add("broken-pivot-jitter", true, { pivot: { x: 0.5, y: 1 } }, async (d) => { const shifts = [[0, 0], [6, -6], [-6, 0], [5, -8], [-5, -2], [7, -7]]; for (const [i, p] of phases.entries()) await save(figure(p, { dx: shifts[i][0], dy: shifts[i][1] }), path.join(d, `run_0${i}.png`)); });
  await add("broken-missing-frame", true, {}, async (d) => { for (const i of [0, 1, 3, 4]) await save(figure(phases[i]), path.join(d, `walk_0${i}.png`)); });
  await add("broken-overflow", true, { maxSize: 64 }, async (d) => { for (const [i, p] of phases.entries()) await save(figure(p), path.join(d, `walk_0${i}.png`)); });
  await add("broken-frame-too-big", true, { maxSize: 32 }, async (d) => save(figure(0, { w: 64, h: 64 }), path.join(d, "boss.png")));
  await add("broken-order", true, {}, async (d) => { const order = [0, 5, 1, 4, 2, 3]; for (const [i, k] of order.entries()) await save(figure(phases[k]), path.join(d, `wave_0${i}.png`)); });
  await add("broken-empty-frame", true, { trim: true }, async (d) => { for (const [i, p] of phases.slice(0, 3).entries()) await save(figure(p), path.join(d, `blink_0${i}.png`)); await save(canvas(W, H), path.join(d, "blink_03.png")); });
  await add("broken-no-padding", true, { padding: 0, extrude: 0 }, async (d) => { for (const [i, p] of phases.slice(0, 4).entries()) await save(figure(p), path.join(d, `walk_0${i}.png`)); });
  return { dir, cases };
}
