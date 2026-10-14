import test from "node:test";
import assert from "node:assert/strict";
import { packMaxRects } from "../src/pipeline/maxrects.mjs";
import { parseFrameName, groupAnimations, deduplicate, frameHash, tagsFor } from "../src/pipeline/grouping.mjs";
import { createImage, removeBackground, detectBackground, trim, sliceGrid, sliceAuto, blit, rotateClockwise, decodeBmp, encodeBmp } from "../src/pipeline/image-ops.mjs";

function fill(image, x, y, w, h, rgba) {
  for (let yy = y; yy < y + h; yy += 1) for (let xx = x; xx < x + w; xx += 1) image.rgba.set(rgba, (yy * image.width + xx) * 4);
}

function overlaps(a, b) { return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h; }

test("maxrects places every item without overlap inside the page", () => {
  const items = Array.from({ length: 40 }, (_, i) => ({ id: `f${i}`, w: 5 + (i * 7) % 23, h: 4 + (i * 11) % 19 }));
  const { pages } = packMaxRects(items, { maxSize: 128 });
  const rects = pages.flatMap((page) => page.rects.map((rect) => ({ ...rect, page })));
  assert.equal(rects.length, items.length);
  for (const rect of rects) assert.ok(rect.x + rect.w <= rect.page.width && rect.y + rect.h <= rect.page.height);
  for (const page of pages) for (let i = 0; i < page.rects.length; i += 1) for (let j = i + 1; j < page.rects.length; j += 1) assert.ok(!overlaps(page.rects[i], page.rects[j]));
});

test("maxrects splits into several pages, honours power of two and rejects oversize frames", () => {
  const items = Array.from({ length: 9 }, (_, i) => ({ id: i, w: 30, h: 30 }));
  const { pages } = packMaxRects(items, { maxSize: 64, powerOfTwo: true });
  assert.ok(pages.length >= 3);
  for (const page of pages) assert.ok([1, 2, 4, 8, 16, 32, 64].includes(page.width) && [1, 2, 4, 8, 16, 32, 64].includes(page.height));
  assert.throws(() => packMaxRects([{ id: "big", w: 70, h: 10 }], { maxSize: 64 }), /does not fit/);
});

test("maxrects rotation lets a tall frame fit a wide free slot", () => {
  const { pages } = packMaxRects([{ id: "wide", w: 64, h: 48 }, { id: "tall", w: 16, h: 64 }], { maxSize: 64, rotate: true });
  assert.equal(pages.length, 1);
  assert.equal(pages[0].rects.find((r) => r.id === "tall").rotated, true);
});

test("frame names group into animations in numeric order", () => {
  assert.deepEqual(parseFrameName("walk_01.png"), { base: "walk_01", animation: "walk", index: 1 });
  assert.deepEqual(parseFrameName("Run-12.gif"), { base: "Run-12", animation: "Run", index: 12 });
  assert.deepEqual(parseFrameName("idle.png"), { base: "idle", animation: "idle", index: 0 });
  const groups = groupAnimations(["walk_10", "walk_2", "idle", "walk_1"].map((name) => ({ name, ...parseFrameName(name) })));
  assert.deepEqual(Object.keys(groups), ["idle", "walk"]);
  assert.deepEqual(groups.walk.map((f) => f.name), ["walk_1", "walk_2", "walk_10"]);
});

test("identical frames are deduplicated by content hash, tags come from rules and folders", () => {
  const a = createImage(2, 2); fill(a, 0, 0, 2, 2, [1, 2, 3, 255]);
  const b = createImage(2, 2); fill(b, 0, 0, 2, 2, [1, 2, 3, 255]);
  const c = createImage(2, 2);
  const frames = [{ name: "a", ...a }, { name: "b", ...b }, { name: "c", ...c }].map((f) => ({ ...f, hash: frameHash(f) }));
  const { unique, aliasOf } = deduplicate(frames);
  assert.deepEqual(unique.map((f) => f.name), ["a", "c"]);
  assert.equal(aliasOf.get("b"), "a");
  assert.deepEqual(tagsFor({ name: "walk_1", animation: "walk", folderTag: "hero" }, { "wa*": ["loop"], idle: ["x"] }), ["hero", "loop"]);
});

test("auto background keeps enclosed pixels of the same color, color key removes all", () => {
  const image = createImage(7, 7); fill(image, 0, 0, 7, 7, [255, 255, 255, 255]); fill(image, 1, 1, 5, 5, [200, 0, 0, 255]); fill(image, 3, 3, 1, 1, [255, 255, 255, 255]);
  assert.deepEqual(detectBackground(image), { r: 255, g: 255, b: 255 });
  const auto = removeBackground(image, { mode: "auto" }).image;
  assert.equal(auto.rgba[3], 0);
  assert.equal(auto.rgba[(3 * 7 + 3) * 4 + 3], 255);
  const key = removeBackground(image, { mode: "key", color: "#ffffff" }).image;
  assert.equal(key.rgba[(3 * 7 + 3) * 4 + 3], 0);
  const transparent = createImage(3, 3);
  assert.equal(removeBackground(transparent).color, null);
});

test("trim, grid and auto slicing", () => {
  const sheet = createImage(12, 6);
  fill(sheet, 1, 1, 2, 3, [9, 9, 9, 255]); fill(sheet, 7, 2, 3, 2, [9, 9, 9, 255]); fill(sheet, 11, 2, 1, 1, [9, 9, 9, 255]);
  const { image, offset } = trim(sheet);
  assert.deepEqual([image.width, image.height, offset.x, offset.y], [11, 3, 1, 1]);
  assert.deepEqual(sliceGrid(sheet, { cols: 2, rows: 1 }).map((c) => [c.x, c.width]), [[0, 6], [6, 6]]);
  const boxes = sliceAuto(sheet, { mergeDistance: 1 });
  assert.deepEqual(boxes.map((b) => [b.x, b.y, b.width, b.height]), [[1, 1, 2, 3], [7, 2, 5, 2]]);
});

test("blit with extrude repeats edge pixels and rotation is clockwise", () => {
  const sprite = createImage(2, 1); fill(sprite, 0, 0, 1, 1, [255, 0, 0, 255]); fill(sprite, 1, 0, 1, 1, [0, 0, 255, 255]);
  const page = createImage(4, 3);
  blit(page, sprite, 1, 1, { extrude: 1 });
  assert.deepEqual([...page.rgba.subarray(4 * 4, 4 * 4 + 4)], [255, 0, 0, 255]);
  assert.deepEqual([...page.rgba.subarray(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...page.rgba.subarray((3) * 4, 3 * 4 + 4)], [0, 0, 255, 255]);
  const rotated = rotateClockwise(sprite);
  assert.deepEqual([rotated.width, rotated.height], [1, 2]);
  assert.deepEqual([...rotated.rgba.subarray(0, 4)], [255, 0, 0, 255]);
});

test("BMP decode round trip", () => {
  const image = createImage(3, 2); fill(image, 0, 0, 3, 2, [10, 20, 30, 255]); fill(image, 2, 1, 1, 1, [1, 2, 3, 0]);
  const decoded = decodeBmp(encodeBmp(image));
  assert.deepEqual([decoded.width, decoded.height], [3, 2]);
  assert.deepEqual([...decoded.rgba], [...image.rgba]);
});
