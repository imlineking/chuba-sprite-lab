import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { planAtlas, extrudeSprite } from "../src/atlas-packing.mjs";
import { processSprites, inspectSource } from "../src/processor.mjs";

test("MaxRects is deterministic, supports rotation and pages without overlap", () => {
  const groups = [{ cellWidth: 1, cellHeight: 1, columns: 4, items: [[25, 13], [13, 25], [12, 19], [19, 12], [7, 7], [14, 14]].map(([width, height], id) => ({ width, height, id })) }];
  const options = { packing: "maxrects", maxSize: 40, overflow: "split", rotate: true, extrude: 1, gap: 2 };
  const first = planAtlas(groups, options);
  assert.deepEqual(first, planAtlas(groups, options));
  assert.equal(first.pages.flatMap(p => p.rects).length, 6);
  for (const page of first.pages) {
    assert.ok(page.width <= 40 && page.height <= 40);
    const rects = page.rects.map(r => ({ x: r.x - 1, y: r.y - 1, w: (r.rotated ? r.item.height : r.item.width) + 2, h: (r.rotated ? r.item.width : r.item.height) + 2 }));
    rects.forEach((r, i) => { assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= page.width && r.y + r.h <= page.height); for (const q of rects.slice(i + 1)) assert.ok(r.x + r.w <= q.x || q.x + q.w <= r.x || r.y + r.h <= q.y || q.y + q.h <= r.y); });
  }
  const rotation = planAtlas([{ ...groups[0], items: [{ width: 8, height: 18 }, { width: 18, height: 8 }] }], { packing: "maxrects", maxSize: 26, gap: 0, rotate: true, overflow: "split" });
  assert.ok(rotation.pages.flatMap(p => p.rects).some(r => r.rotated));
});

test("extrusion copies RGBA corners and never changes original pixels", async () => {
  const rgba = Buffer.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 255, 255, 255, 255]);
  const input = await sharp(rgba, { raw: { width: 2, height: 2, channels: 4 } }).png().toBuffer();
  const output = await sharp(await extrudeSprite(input, 2)).raw().toBuffer({ resolveWithObject: true });
  assert.equal(output.info.width, 6);
  assert.deepEqual(output.data.subarray(0, 4), rgba.subarray(0, 4));
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) assert.deepEqual(output.data.subarray(((y + 2) * 6 + x + 2) * 4, ((y + 2) * 6 + x + 2) * 4 + 4), rgba.subarray((y * 2 + x) * 4, (y * 2 + x) * 4 + 4));
});

test("small exact geometry survives sheet and rotated atlas PNG/JSON roundtrip", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-p1-atlas-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputs = [];
  for (const [i, [w, h]] of [[8, 18], [18, 8]].entries()) {
    const input = path.join(root, `${i}.png`); inputs.push(input);
    const data = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([x * 11, y * 11, i * 100, 255], (y * w + x) * 4);
    await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toFile(input);
  }
  const appRoot = path.resolve("."); const source = await inspectSource({ kind: "frames", paths: inputs, appRoot });
  for (const packing of ["grid", "maxrects"]) {
    const result = await processSprites({ source, appRoot, outputDir: root, name: packing, options: { keyMode: "alpha", autoSize: false, cellWidth: 32, cellHeight: 24, padding: 0, imageGeometry: { mode: "contain", width: 32, height: 24, kernel: "nearest", trimToObject: true }, removeDuplicates: false, packing, atlasRotate: packing !== "grid", atlasExtrude: packing === "grid" ? 0 : 2, atlasGap: 2, exportFormat: "texturepacker", exports: { sheet: true, metadata: true, frames: true, preview: false } } });
    const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.frameWidth, 32); assert.equal(manifest.frameHeight, 24);
    for (const [i, frame] of manifest.frames.entries()) {
      let sprite = await sharp(path.join(path.dirname(result.manifestPath), manifest.pages[frame.page].image)).extract({ left: frame.x, top: frame.y, width: frame.width, height: frame.height }).png().toBuffer();
      if (frame.rotated) sprite = await sharp(sprite).rotate(270).png().toBuffer();
      const reconstructed = await sharp({ create: { width: frame.sourceSize.w, height: frame.sourceSize.h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: sprite, left: frame.spriteSourceSize.x, top: frame.spriteSourceSize.y }]).raw().toBuffer();
      assert.deepEqual(reconstructed, await sharp(result.framePaths[i]).raw().toBuffer());
    }
    await assert.rejects(processSprites({ source, appRoot, outputDir: root, name: "bad", options: { packing: "maxrects", atlasRotate: true, exportFormat: "godot" } }), /Поворот/);
  }
});
