import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { applyImageGeometry, validateImageGeometry } from "../src/image-geometry.mjs";
import { processImageBatch } from "../src/image-batch.mjs";

async function fixture() {
  const pixels = Buffer.alloc(20 * 16 * 4);
  for (let y = 5; y < 11; y++) for (let x = 4; x < 16; x++) pixels.set([x * 12, y * 19, 40, 255], (y * 20 + x) * 4);
  pixels.set([255, 255, 255, 255], (5 * 20 + 4) * 4);
  pixels.set([90, 130, 40, 128], (10 * 20 + 15) * 4);
  const buffer = await sharp(pixels, { raw: { width: 20, height: 16, channels: 4 } }).png().toBuffer();
  return { pixels, buffer, info: { width: 20, height: 16, channels: 4 }, bounds: { left: 4, top: 5, width: 12, height: 6 } };
}
const decode = image => sharp(image.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

test("trimming removes transparent canvas without changing white or partly transparent artwork", async () => {
  const source = await fixture();
  const trimmed = await applyImageGeometry(source, { mode: "trim" });
  const { data, info } = await decode(trimmed);
  assert.equal(info.width, 12); assert.equal(info.height, 6);
  for (let y = 0; y < 6; y++) assert.deepEqual(data.subarray(y * 12 * 4, (y + 1) * 12 * 4), source.pixels.subarray(((y + 5) * 20 + 4) * 4, ((y + 5) * 20 + 16) * 4));
  assert.equal(trimmed.geometryReport.cropped, false);
  assert.equal(await applyImageGeometry(source, null), source);
  assert.equal(await applyImageGeometry(source, { mode: "original" }), source);
});

test("contain centres a proportionate object on an exact transparent canvas, including small game resolutions", async () => {
  const source = await fixture();
  const fitted = await applyImageGeometry(source, { mode: "contain", width: 24, height: 24 });
  assert.deepEqual(fitted.bounds, { left: 0, top: 6, width: 24, height: 12 });
  const { data } = await decode(fitted);
  assert.equal(data[3], 0);
  assert.deepEqual([...data.subarray((6 * 24) * 4, (6 * 24) * 4 + 4)], [255, 255, 255, 255]);
  assert.equal(data[(17 * 24 + 23) * 4 + 3], 128);
  const one = await applyImageGeometry(source, { mode: "contain", width: 1, height: 1 });
  assert.equal(one.info.width, 1); assert.equal(one.info.height, 1);
  const keepCanvas = await applyImageGeometry(source, { mode: "contain", width: 20, height: 16, trimToObject: false });
  assert.deepEqual((await decode(keepCanvas)).data, source.pixels);
});

test("cover and stretch explicitly report cropping or altered proportions", async () => {
  const source = await fixture();
  const cover = await applyImageGeometry(source, { mode: "cover", width: 12, height: 12 });
  const stretched = await applyImageGeometry(source, { mode: "stretch", width: 12, height: 12 });
  assert.equal(cover.geometryReport.cropped, true);
  assert.equal(cover.geometryReport.stretched, false);
  assert.equal(stretched.geometryReport.stretched, true);
  assert.equal(stretched.geometryReport.cropped, false);
  assert.equal(cover.info.width, 12); assert.equal(cover.info.height, 12);
  const proportionate = await applyImageGeometry(source, { mode: "cover", width: 24, height: 12 });
  assert.equal(proportionate.geometryReport.cropped, false);
});

test("invalid geometry refuses unsafe allocations or ignored options", async () => {
  for (const options of [{ mode: "contain", width: 0, height: 2 }, { mode: "cover", width: 4097, height: 2 }, { mode: "stretch", width: 3.5, height: 2 }, { mode: "bad" }, { mode: "trim", typo: true }, { mode: "trim", kernel: "bad" }]) assert.throws(() => validateImageGeometry(options));
  const empty = await sharp({ create: { width: 2, height: 2, channels: 4, background: "#00000000" } }).png().toBuffer();
  await assert.rejects(applyImageGeometry({ buffer: empty }, { mode: "trim" }), /Нет непрозрачных/);
});

test("image batch uses the same sized pixels as preview and records crop warnings without modifying originals", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-geometry-"));
  try {
    const source = await fixture(), file = path.join(directory, "source.png"); await fs.writeFile(file, source.buffer);
    const geometry = { mode: "cover", width: 12, height: 12, kernel: "nearest" };
    const result = await processImageBatch({ paths: [file], outputDir: path.join(directory, "out"), outputKind: "images", options: { keyMode: "alpha", edgeRefine: { mode: "none" }, imageGeometry: geometry } });
    assert.equal(result.failed, 0);
    const item = result.results[0];
    assert.deepEqual(item.geometryReport.outputSize, { width: 12, height: 12 });
    assert.equal(item.changeReport.resized, true);
    assert.ok(item.qualityWarnings.some(warning => warning.includes("обрезало")));
    const expected = await applyImageGeometry(source, geometry);
    assert.deepEqual(await sharp(item.imagePath).ensureAlpha().raw().toBuffer(), (await decode(expected)).data);
    assert.deepEqual(await fs.readFile(file), source.buffer);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
