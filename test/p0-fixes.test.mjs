import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { applyFix, sanitizeFix, validateCriticConfig } from "../src/critic/critic.mjs";
import { buildAtlas, listImages } from "../src/pipeline/build.mjs";
import { packMaxRects } from "../src/pipeline/maxrects.mjs";

import { readFileSync } from "node:fs";

const tmp = (prefix) => fs.mkdtemp(path.join(os.tmpdir(), `spritelab-p0-${prefix}-`));

// 4. applyFix whitelist and IPC config validation.
test("applyFix only applies whitelisted, valid keys", () => {
  const config = { name: "hero", input: ["/in"], output: "/out", padding: 0, background: "none", formats: ["phaser-hash"] };
  const next = applyFix(config, { output: "C:/Windows", input: ["/etc"], name: "evil", formats: ["godot"], padding: 2, extrude: 1, background: { mode: "auto", tolerance: 32 }, maxSize: 4096, rotate: true, sortBy: "similarity" });
  assert.equal(next.output, "/out"); assert.deepEqual(next.input, ["/in"]); assert.equal(next.name, "hero"); assert.deepEqual(next.formats, ["phaser-hash"]);
  assert.equal(next.rotate, undefined);
  assert.equal(next.padding, 2); assert.equal(next.extrude, 1); assert.deepEqual(next.background, { mode: "auto", tolerance: 32 }); assert.equal(next.maxSize, 4096);
  const { rejected } = sanitizeFix({ padding: -1, fps: 1000, pivot: { x: 2 }, background: { mode: "key", color: "red" }, slice: { mode: "grid", cols: "4" }, trim: "yes", output: "/x" });
  assert.deepEqual(rejected.sort(), ["background", "fps", "output", "padding", "pivot", "slice", "trim"].sort());
  assert.deepEqual(applyFix(config, null), config);
  assert.deepEqual(applyFix(config, { slice: { mode: "grid", cols: 4, rows: 2 } }).slice, { mode: "grid", cols: 4, rows: 2 });
});

test("critic IPC config: known keys, absolute paths, output not a root or the input itself", () => {
  const root = path.parse(process.cwd()).root;
  const input = path.join(root, "sprites", "hero");
  const ok = validateCriticConfig({ name: "hero", input: [input], output: `${input}-atlas`, formats: ["phaser-hash"], padding: 2 });
  assert.deepEqual(ok.input, [input]);
  assert.throws(() => validateCriticConfig({ input: [input], output: `${input}-atlas`, shell: "calc" }), /ключи/);
  assert.throws(() => validateCriticConfig({ input: ["relative"], output: `${input}-atlas` }), /input/);
  assert.throws(() => validateCriticConfig({ input: [input], output: "out" }), /output/);
  assert.throws(() => validateCriticConfig({ input: [input], output: root }), /корнем/);
  assert.throws(() => validateCriticConfig({ input: [input], output: input }), /совпадать/);
  assert.throws(() => validateCriticConfig({ input: [input], output: `${input}-atlas`, name: "../x" }), /name/);
  assert.throws(() => validateCriticConfig(null), /объектом/);
  const main = readFileSync(new URL("../src/main.mjs", import.meta.url), "utf8");
  assert.match(main, /validateCriticConfig\(request\.config\)/);
  assert.match(main, /reviewedOutputs\.has/);
});

// 5, 6, 8. Build: output inside input, POT within maxSize, stale pages, atomic writes.
async function frames(dir, count, size = 24) {
  await fs.mkdir(dir, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    await sharp({ create: { width: size, height: size, channels: 4, background: { r: 40 + i * 20, g: 90, b: 200 - i * 10, alpha: 1 } } }).png().toFile(path.join(dir, `walk_${String(i).padStart(2, "0")}.png`));
  }
}

test("an output folder inside the input folder is skipped, so rebuilding is stable", async () => {
  const dir = await tmp("nested");
  try {
    await frames(dir, 6);
    const config = { input: [dir], output: path.join(dir, "out"), name: "atlas" };
    const first = await buildAtlas(config);
    const second = await buildAtlas(config);
    assert.equal(first.stats.frames, 6); assert.equal(second.stats.frames, 6);
    assert.ok(!second.atlas.frames.some((f) => f.name === "atlas"));
    const listed = await listImages([dir], { output: path.join(dir, "out") });
    assert.equal(listed.length, 6);
    await assert.rejects(buildAtlas({ input: [dir], output: dir, name: "atlas" }), /must not be the input folder/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("--pot keeps pages within --max-size: largest power of two <= max-size, error if a frame does not fit", () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ id: `f${i}`, w: 100, h: 100 }));
  const { pages } = packMaxRects(items, { maxSize: 1000, powerOfTwo: true });
  for (const page of pages) { assert.ok(page.width <= 512 && page.height <= 512, `${page.width}x${page.height}`); assert.equal(page.width & (page.width - 1), 0); }
  assert.ok(pages.length > 1);
  assert.throws(() => packMaxRects([{ id: "big", w: 600, h: 600 }], { maxSize: 1000, powerOfTwo: true }), /largest page 512x512/);
  assert.equal(packMaxRects([{ id: "big", w: 600, h: 600 }], { maxSize: 1000 }).pages[0].width, 600);
  assert.equal(packMaxRects([{ id: "a", w: 600, h: 600 }], { maxSize: 1024, powerOfTwo: true }).pages[0].width, 1024);
});

test("stale page files are removed when the page count drops; writes leave no temp files", async () => {
  const dir = await tmp("pages");
  try {
    const input = path.join(dir, "in"), output = path.join(dir, "out");
    await frames(input, 8, 40);
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, "notes.txt"), "keep");
    await fs.writeFile(path.join(output, "atlas.preset.json"), "{}");
    const base = { input: [input], output, name: "atlas", formats: ["texturepacker-hash", "phaser-hash"], powerOfTwo: false };
    const many = await buildAtlas({ ...base, maxSize: 90 });
    assert.ok(many.stats.pages > 1);
    let names = await fs.readdir(output);
    assert.ok(names.includes("atlas-0.png") && names.includes("atlas-1.png"));
    const one = await buildAtlas({ ...base, maxSize: 2048 });
    assert.equal(one.stats.pages, 1);
    names = await fs.readdir(output);
    assert.ok(names.includes("atlas.png"));
    assert.ok(!names.some((n) => /^atlas-\d+\./.test(n)), names.join(","));
    assert.ok(names.includes("notes.txt") && names.includes("atlas.preset.json"));
    assert.ok(!names.some((n) => n.endsWith(".tmp")));
    assert.ok(one.removedStale.includes("atlas-0.png"));
    // And back to several pages: the single-page files go.
    await buildAtlas({ ...base, maxSize: 90 });
    names = await fs.readdir(output);
    assert.ok(!names.includes("atlas.png") && !names.includes("atlas.json"), names.join(","));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("watch snapshot ignores the output folder (no rebuild loop)", async () => {
  const source = readFileSync(new URL("../scripts/atlas.mjs", import.meta.url), "utf8");
  assert.match(source, /listImages\(sources, \{ output: outputs \}\)/);
  assert.doesNotMatch(source, /idleMs: 5000/);
});
