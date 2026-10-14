import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { buildAtlas } from "../src/pipeline/build.mjs";
import { exportAtlas, formats, parseTexturePacker, parseGodot, parseUnityMeta } from "../src/pipeline/exporters.mjs";
import { createImage, encodeBmp } from "../src/pipeline/image-ops.mjs";
import { main as atlasCli } from "../scripts/atlas.mjs";

const goldenDir = path.resolve("test/golden");
const update = process.env.UPDATE_GOLDEN === "1";

function square(size, color, inset = 1) {
  const image = createImage(size, size);
  for (let y = inset; y < size - inset; y += 1) for (let x = inset; x < size - inset; x += 1) image.rgba.set(color, (y * size + x) * 4);
  return image;
}

async function writePng(file, image) {
  await sharp(image.rgba, { raw: { width: image.width, height: image.height, channels: 4 } }).png().toFile(file);
}

// Tiny synthetic project: a walk cycle with one duplicated frame, a JPEG on a magenta
// key, a BMP, a 2-frame GIF and a 2x1 sprite sheet.
async function makeFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-pipeline-"));
  const src = path.join(dir, "sprites");
  await fs.mkdir(path.join(src, "hero"), { recursive: true });
  await writePng(path.join(src, "hero", "walk_01.png"), square(8, [200, 30, 30, 255]));
  await writePng(path.join(src, "hero", "walk_02.png"), square(8, [30, 200, 30, 255], 2));
  await writePng(path.join(src, "hero", "walk_03.png"), square(8, [200, 30, 30, 255]));
  await fs.writeFile(path.join(src, "coin.bmp"), encodeBmp(square(6, [250, 210, 0, 255])));
  const gif = createImage(5, 10);
  for (let y = 0; y < 10; y += 1) for (let x = 0; x < 5; x += 1) gif.rgba.set(y < 5 ? [0, 0, 255, 255] : [0, 255, 0, 255], (y * 5 + x) * 4);
  // Two-page GIF via sharp's pageHeight join.
  await sharp(gif.rgba, { raw: { width: 5, height: 10, channels: 4, pageHeight: 5 } }).gif({ delay: [100, 100], loop: 0 }).toFile(path.join(src, "blink.gif"));
  const sheet = createImage(10, 5);
  for (let y = 1; y < 4; y += 1) { for (let x = 1; x < 4; x += 1) sheet.rgba.set([90, 90, 90, 255], (y * 10 + x) * 4); for (let x = 6; x < 9; x += 1) sheet.rgba.set([60, 60, 60, 255], (y * 10 + x) * 4); }
  await writePng(path.join(dir, "sheet.png"), sheet);
  return { dir, src };
}

function sha(buffer) { return crypto.createHash("sha1").update(buffer).digest("hex"); }

test("pipeline builds the synthetic project and matches golden files", async (t) => {
  const { dir, src } = await makeFixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const out = path.join(dir, "out");
  const result = await buildAtlas({ name: "demo", input: [src], output: out, formats, maxSize: 64, padding: 2, extrude: 1, tags: { walk: ["loop"] } });
  assert.equal(result.stats.frames, 6);
  assert.equal(result.stats.duplicates, 1);
  assert.equal(result.atlas.frames.find((f) => f.name === "walk_03").duplicateOf, "walk_01");
  assert.deepEqual(result.atlas.animations.walk, ["walk_01", "walk_02", "walk_03"]);
  assert.deepEqual(result.atlas.animations.blink, ["blink_00", "blink_01"]);
  assert.deepEqual(result.atlas.frames.find((f) => f.name === "walk_01").tags, ["hero", "loop"]);
  const page = await sharp(path.join(out, "demo.png")).raw().toBuffer({ resolveWithObject: true });
  const golden = { atlas: result.atlas, stats: result.stats, pagePixelsSha1: sha(page.data), files: Object.fromEntries(result.outputs.map((o) => [o.file, sha(o.text)])) };
  const goldenFile = path.join(goldenDir, "pipeline-demo.json");
  if (update) await fs.writeFile(goldenFile, `${JSON.stringify(golden, null, 2)}\n`);
  assert.deepEqual(golden, JSON.parse(await fs.readFile(goldenFile, "utf8")));
  for (const file of Object.keys(golden.files)) assert.ok((await fs.stat(path.join(out, file))).size > 0, file);
});

test("background key, grid and auto slicing through the pipeline", async (t) => {
  const { dir } = await makeFixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const keyed = createImage(6, 6);
  for (let i = 0; i < 36; i += 1) keyed.rgba.set(i % 6 > 1 && i % 6 < 4 && i > 11 && i < 24 ? [0, 0, 0, 255] : [255, 0, 255, 255], i * 4);
  await writePng(path.join(dir, "keyed.png"), keyed);
  const keyedResult = await buildAtlas({ name: "k", input: [path.join(dir, "keyed.png")], output: path.join(dir, "k"), background: { mode: "key", color: "#ff00ff" }, formats: ["texturepacker-hash"] }, { write: false });
  assert.deepEqual([keyedResult.atlas.frames[0].w, keyedResult.atlas.frames[0].h], [2, 2]);
  const grid = await buildAtlas({ name: "g", input: [path.join(dir, "sheet.png")], output: path.join(dir, "g"), slice: { mode: "grid", cols: 2, rows: 1 }, formats: ["texturepacker-array"] }, { write: false });
  assert.deepEqual(grid.atlas.frames.map((f) => [f.name, f.w, f.h, f.spriteSourceSize.x]), [["sheet_00", 3, 3, 1], ["sheet_01", 3, 3, 1]]);
  const auto = await buildAtlas({ name: "a", input: [path.join(dir, "sheet.png")], output: path.join(dir, "a"), slice: { mode: "auto" }, formats: ["texturepacker-array"] }, { write: false });
  assert.equal(auto.atlas.frames.length, 2);
});

test("every exporter round-trips frame rectangles through its parser", async (t) => {
  const { dir, src } = await makeFixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { atlas } = await buildAtlas({ name: "rt", input: [src], output: path.join(dir, "o"), formats: ["texturepacker-hash"], maxSize: 16, pivot: { x: 0.5, y: 1 } }, { write: false });
  assert.ok(atlas.pages.length >= 2, "fixture should need several pages at 16 px");
  const expected = Object.fromEntries(atlas.frames.map((f) => [f.name, f]));
  for (const format of ["texturepacker-hash", "texturepacker-array", "phaser-hash", "phaser-array"]) {
    const files = exportAtlas(atlas, format).filter((f) => !f.file.includes("anims") && !f.file.includes("multiatlas"));
    assert.equal(files.length, atlas.pages.length, format);
    const parsed = files.flatMap((file) => parseTexturePacker(file.text));
    assert.equal(parsed.length, atlas.frames.length, format);
    for (const frame of parsed) {
      const e = expected[frame.name];
      assert.deepEqual([frame.x, frame.y, frame.w, frame.h, frame.rotated, frame.trimmed], [e.x, e.y, e.w, e.h, e.rotated, e.trimmed], `${format} ${frame.name}`);
      assert.deepEqual(frame.spriteSourceSize, e.spriteSourceSize);
      assert.deepEqual(frame.sourceSize, e.sourceSize);
    }
  }
  const multi = exportAtlas(atlas, "phaser-hash").find((f) => f.file.endsWith("multiatlas.json"));
  assert.equal(JSON.parse(multi.text).textures.length, atlas.pages.length);
  const godot = parseGodot(exportAtlas(atlas, "godot-spriteframes")[0].text);
  for (const [name, list] of Object.entries(atlas.animations)) {
    assert.deepEqual(godot.animations[name].map((r) => [r.page, r.x, r.y, r.w, r.h]), list.map((n) => expected[n]).map((f) => [f.page, f.x, f.y, f.w, f.h]), name);
  }
  for (const file of exportAtlas(atlas, "godot-atlastexture")) {
    const region = parseGodot(file.text).regions.resource;
    const f = expected[path.basename(file.file, ".tres")];
    assert.deepEqual([region.x, region.y, region.w, region.h], [f.x, f.y, f.w, f.h]);
    if (f.trimmed) assert.deepEqual(region.margin, { x: f.spriteSourceSize.x, y: f.spriteSourceSize.y, w: f.sourceSize.w - f.w, h: f.sourceSize.h - f.h });
  }
  for (const file of exportAtlas(atlas, "unity-meta")) {
    const pageIndex = atlas.pages.findIndex((p) => `${p.file}.meta` === file.file);
    const parsed = parseUnityMeta(file.text);
    assert.match(parsed.guid, /^[0-9a-f]{32}$/);
    for (const sprite of parsed.sprites) {
      const f = expected[sprite.name];
      assert.equal(f.page, pageIndex);
      // Back from Unity's bottom-left origin and normalised pivot.
      assert.deepEqual([sprite.x, atlas.pages[pageIndex].height - sprite.y - sprite.h, sprite.w, sprite.h], [f.x, f.y, f.w, f.h]);
      assert.ok(Math.abs(sprite.pivot.x * f.w + f.spriteSourceSize.x - f.pivot.x * f.sourceSize.w) < 1e-4);
      assert.ok(Math.abs((1 - sprite.pivot.y) * f.h + f.spriteSourceSize.y - f.pivot.y * f.sourceSize.h) < 1e-4);
    }
  }
  const unity = JSON.parse(exportAtlas(atlas, "unity-json")[0].text);
  assert.equal(unity.frames.length, atlas.frames.length);
});

test("rotated frames survive the TexturePacker round trip; Godot/Unity refuse rotation", async (t) => {
  const { dir, src } = await makeFixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const tall = createImage(4, 20);
  tall.rgba.fill(255);
  await writePng(path.join(src, "pole.png"), tall);
  const wide = createImage(24, 18); wide.rgba.fill(255);
  await writePng(path.join(src, "wall.png"), wide);
  const { atlas } = await buildAtlas({ name: "rot", input: [src], output: path.join(dir, "r"), rotate: true, formats: ["texturepacker-hash"], maxSize: 32, padding: 0, extrude: 0 }, { write: false });
  const parsed = exportAtlas(atlas, "texturepacker-hash").flatMap((f) => parseTexturePacker(f.text));
  assert.deepEqual(parsed.map((f) => f.rotated), atlas.frames.map((f) => f.rotated));
  if (atlas.frames.some((f) => f.rotated)) {
    assert.throws(() => exportAtlas(atlas, "godot-spriteframes"), /rotated/);
    assert.throws(() => exportAtlas(atlas, "unity-meta"), /rotated/);
  }
  await assert.rejects(buildAtlas({ input: [src], rotate: true, formats: ["godot-spriteframes"] }, { write: false }), /rotate/);
});

test("CLI builds with defaults, batch presets and reports bad input", async (t) => {
  const { dir, src } = await makeFixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const preset = path.join(dir, "batch.json");
  await fs.writeFile(preset, JSON.stringify({ input: "sprites", maxSize: 64, builds: [{ name: "one", output: "out1" }, { name: "two", output: "out2", formats: ["godot-spriteframes"] }] }));
  const log = []; const original = console.log; console.log = (line) => log.push(line);
  try {
    assert.equal(await atlasCli(["build", preset, "--json"]), 0);
    assert.equal(await atlasCli(["build", "--input", src, "--output", path.join(dir, "out3"), "--name", "three", "--format", "phaser-array", "--json"]), 0);
  } finally { console.log = original; }
  assert.equal(log.length, 3);
  assert.ok(log.every((line) => JSON.parse(line).ok));
  await fs.access(path.join(dir, "out1", "one.json"));
  await fs.access(path.join(dir, "out2", "two.tres"));
  await fs.access(path.join(dir, "out3", "three.phaser-array.json"));
  const errors = []; const originalError = console.error; console.error = (line) => errors.push(line);
  try {
    assert.equal(await atlasCli(["build", "--input", path.join(dir, "missing")]), 2);
    assert.equal(await atlasCli(["build", "--bogus"]), 1);
  } finally { console.error = originalError; }
  assert.match(errors.join("\n"), /not found/);
});
