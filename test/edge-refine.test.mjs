import test from "node:test";
import assert from "node:assert/strict";
import { refineEdgeRgba } from "../src/edge-refine.mjs";

function canvas(width, height, fill = [0, 0, 0, 0]) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) data.set(fill, i * 4);
  const paint = (x, y, rgba) => data.set(rgba, (y * width + x) * 4);
  const at = (pixels, x, y) => [...pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
  return { data, info: { width, height, channels: 4 }, paint, at };
}

test("one and three pixel edge removal change only the requested silhouette ring", () => {
  const frame = canvas(11, 11);
  for (let y = 1; y <= 9; y += 1) for (let x = 1; x <= 9; x += 1) frame.paint(x, y, [40, 90, 50, 255]);
  const one = refineEdgeRgba(frame.data, frame.info, { mode: "trim", width: 1 });
  const three = refineEdgeRgba(frame.data, frame.info, { mode: "trim", width: 3 });
  assert.equal(frame.at(one, 1, 5)[3], 0);
  assert.equal(frame.at(one, 2, 5)[3], 255);
  assert.equal(frame.at(three, 3, 5)[3], 0);
  assert.equal(frame.at(three, 4, 5)[3], 255);
  assert.equal(frame.at(frame.data, 1, 5)[3], 255);
});

test("manual contour repair follows local colour and configurable depth without changing alpha", () => {
  const frame = canvas(61, 41);
  for (let y = 2; y <= 38; y++) for (let x = 2; x <= 58; x++) frame.paint(x, y, [x * 3, y * 4, 30, 255]);
  frame.paint(2, 20, [255, 255, 255, 120]);
  const original = Buffer.from(frame.data);
  const shallow = refineEdgeRgba(frame.data, frame.info, { mode: "recolor", width: 1, depth: 2, whiteOnly: false });
  const deep = refineEdgeRgba(frame.data, frame.info, { mode: "recolor", width: 1, depth: 8, whiteOnly: false });
  assert.notDeepEqual(frame.at(shallow, 2, 20).slice(0, 3), frame.at(deep, 2, 20).slice(0, 3));
  assert.notDeepEqual(frame.at(deep, 2, 10).slice(0, 3), frame.at(deep, 2, 30).slice(0, 3), "each contour point retains its local colour");
  for (let i = 3; i < original.length; i += 4) assert.equal(deep[i], original[i]);
  assert.deepEqual(frame.data, original);
});

test("white edge is coloured from inside while an enclosed white flower stays white", () => {
  const frame = canvas(17, 17);
  for (let y = 2; y <= 14; y += 1) for (let x = 2; x <= 14; x += 1) frame.paint(x, y, [20, 130, 30, 255]);
  for (let y = 2; y <= 14; y += 1) { frame.paint(2, y, [255, 255, 255, 255]); frame.paint(14, y, [255, 255, 255, 255]); }
  frame.paint(8, 8, [255, 255, 255, 255]);
  const result = refineEdgeRgba(frame.data, frame.info, { mode: "recolor", width: 1, depth: 5, whiteOnly: true });
  assert.deepEqual(frame.at(result, 2, 8), [20, 130, 30, 255]);
  assert.deepEqual(frame.at(result, 8, 8), [255, 255, 255, 255]);
});

test("neutral grey export fringe is recoloured without touching a dark outline", () => {
  const frame = canvas(17, 17);
  for (let y = 2; y <= 14; y += 1) for (let x = 2; x <= 14; x += 1) frame.paint(x, y, [18, 78, 54, 255]);
  for (let y = 2; y <= 14; y += 1) {
    frame.paint(2, y, [168, 165, 162, 255]);
    frame.paint(14, y, [16, 19, 18, 255]);
  }
  const result = refineEdgeRgba(frame.data, frame.info, {
    mode: "recolor",
    width: 1,
    depth: 4,
    whiteOnly: true,
    whiteThreshold: 140,
    neutralTolerance: 40,
  });
  assert.deepEqual(frame.at(result, 2, 8), [18, 78, 54, 255]);
  assert.deepEqual(frame.at(result, 14, 8), [16, 19, 18, 255]);
});

test("grey fringe on a one-pixel needle borrows colour two pixels along the same thin stroke", () => {
  const frame = canvas(9, 9);
  frame.paint(3, 4, [165, 164, 160, 255]);
  frame.paint(4, 4, [12, 62, 48, 255]);
  frame.paint(5, 4, [10, 48, 38, 255]);
  const result = refineEdgeRgba(frame.data, frame.info, {
    mode: "recolor",
    width: 1,
    depth: 4,
    whiteOnly: true,
    whiteThreshold: 140,
    neutralTolerance: 40,
  });
  assert.deepEqual(frame.at(result, 3, 4), [10, 48, 38, 255]);
});

test("only a large white exterior is removed, not a small border highlight or inner text", () => {
  const frame = canvas(30, 30, [255, 255, 255, 255]);
  for (let y = 6; y <= 23; y += 1) for (let x = 6; x <= 23; x += 1) frame.paint(x, y, [10, 80, 180, 255]);
  frame.paint(15, 15, [255, 255, 255, 255]);
  const result = refineEdgeRgba(frame.data, frame.info, { removeWhiteExterior: true });
  assert.equal(frame.at(result, 0, 0)[3], 0);
  assert.equal(frame.at(result, 15, 15)[3], 255);
});

test("automatic pale cleanup removes a narrow background pocket and protects white artwork", () => {
  const options = { mode: "recolor", width: 2, depth: 3, whiteOnly: true, whiteThreshold: 175, neutralTolerance: 45, autoPaleCleanup: true };
  const sprite = canvas(100, 100);
  for (let y = 5; y <= 94; y += 1) for (let x = 5; x <= 94; x += 1) sprite.paint(x, y, [30, 90, 40, 255]);
  for (let y = 20; y <= 49; y += 1) for (let x = 48; x <= 49; x += 1) sprite.paint(x, y, [255, 255, 255, 255]);
  sprite.paint(47, 30, [0, 0, 0, 0]); sprite.paint(50, 30, [0, 0, 0, 0]);
  // The component is small relative to the full sprite but reaches alpha on both sides.
  const result = refineEdgeRgba(sprite.data, sprite.info, options);
  assert.equal(sprite.at(result, 48, 30)[3], 0);
  const flower = canvas(30, 30);
  for (let y = 3; y <= 26; y += 1) for (let x = 3; x <= 26; x += 1) flower.paint(x, y, [30, 90, 40, 255]);
  for (let y = 5; y <= 15; y += 1) for (let x = 8; x <= 20; x += 1) flower.paint(x, y, [248, 246, 238, 255]);
  const protectedResult = refineEdgeRgba(flower.data, flower.info, options);
  assert.deepEqual(flower.at(protectedResult, 10, 10), [248, 246, 238, 255]);
  const outerHighlight = canvas(100, 100);
  for (let y = 5; y <= 94; y += 1) for (let x = 5; x <= 94; x += 1) outerHighlight.paint(x, y, [30, 90, 40, 255]);
  for (let y = 22; y <= 45; y += 1) outerHighlight.paint(5, y, [255, 255, 255, 255]);
  const guarded = refineEdgeRgba(outerHighlight.data, outerHighlight.info, options);
  assert.equal(outerHighlight.at(guarded, 5, 30)[3], 255, "an outer highlight is not a trapped pocket");
});

test("explicit no-light-artwork profile removes neutral matte without changing green, brown or black", () => {
  const frame = canvas(13, 13);
  for (let y = 2; y <= 10; y += 1) for (let x = 2; x <= 10; x += 1) frame.paint(x, y, [27, 92, 38, 255]);
  frame.paint(5, 5, [249, 249, 248, 255]);
  frame.paint(6, 5, [134, 134, 132, 255]);
  frame.paint(7, 5, [96, 96, 96, 255]);
  frame.paint(8, 5, [119, 82, 44, 255]);
  frame.paint(9, 5, [12, 15, 13, 255]);
  frame.paint(5, 6, [184, 202, 143, 255]);
  const original = Buffer.from(frame.data);
  const safe = refineEdgeRgba(frame.data, frame.info, { mode: "none" });
  assert.equal(frame.at(safe, 5, 5)[3], 255, "without the explicit choice, white artwork is preserved");
  const result = refineEdgeRgba(frame.data, frame.info, { mode: "none", noLightArtwork: true });
  for (const x of [5, 6, 7]) assert.equal(frame.at(result, x, 5)[3], 0);
  for (const [x, y] of [[4, 5], [8, 5], [9, 5], [5, 6]]) {
    assert.equal(frame.at(result, x, y)[3], 255, "contour repaint must not cut coloured artwork");
  }
  assert.deepEqual(frame.data, original, "the source must not change");
});

test("no-light-artwork profile repaints a warm pale branch rim from its own interior", () => {
  const frame = canvas(32, 18);
  for (let y = 5; y <= 12; y += 1) for (let x = 3; x <= 28; x += 1) frame.paint(x, y, [130, 100, 65, 255]);
  for (let x = 8; x <= 18; x += 1) frame.paint(x, 5, [190, 175, 139, 255]);
  frame.paint(21, 5, [184, 202, 143, 255]);
  const result = refineEdgeRgba(frame.data, frame.info, { mode: "none", noLightArtwork: true });
  const rim = frame.at(result, 12, 5);
  assert.ok(rim[0] < 190 && rim[1] < 175 && rim[2] < 139, "the beige fringe is sampled from the branch, not left bright");
  assert.equal(rim[3], 255, "recolouring keeps the branch silhouette");
  assert.deepEqual(frame.at(result, 12, 8), [130, 100, 65, 255]);
  assert.equal(frame.at(result, 21, 5)[3], 255, "a green edge pixel stays in the silhouette");
});

test("contour pixels take separate colours from their own inward detail", () => {
  const frame = canvas(34, 18);
  for (let y = 3; y <= 14; y += 1) for (let x = 2; x <= 31; x += 1) {
    frame.paint(x, y, x < 17 ? [32, 104, 46, 255] : [126, 74, 32, 255]);
  }
  frame.paint(5, 3, [204, 179, 117, 255]);
  frame.paint(27, 3, [204, 179, 117, 255]);
  const result = refineEdgeRgba(frame.data, frame.info,
    { mode: "none", noLightArtwork: true, contourWidth: 2 });
  assert.deepEqual(frame.at(result, 5, 3), [32, 104, 46, 255]);
  assert.deepEqual(frame.at(result, 27, 3), [126, 74, 32, 255]);
  assert.deepEqual(frame.at(result, 5, 9), [32, 104, 46, 255], "the interior is not flattened");
});

test("thin line borrows from two pixels along the same line", () => {
  const frame = canvas(12, 9);
  for (let x = 2; x <= 9; x += 1) frame.paint(x, 4, [40, 100, 50, 255]);
  frame.paint(2, 4, [208, 177, 116, 255]);
  frame.paint(3, 4, [70, 120, 60, 255]);
  frame.paint(4, 4, [28, 88, 44, 255]);
  frame.paint(5, 4, [52, 108, 56, 255]);
  const result = refineEdgeRgba(frame.data, frame.info,
    { mode: "none", noLightArtwork: true, contourWidth: 2 });
  assert.deepEqual(frame.at(result, 2, 4), [28, 88, 44, 255]);
  assert.equal(frame.at(result, 2, 4)[3], 255);
});

test("broad contour samples five pixels inside without a shared outline colour", () => {
  const frame = canvas(15, 17);
  for (let y = 2; y <= 14; y += 1) for (let x = 2; x <= 12; x += 1) {
    frame.paint(x, y, [44, 99, 55, 255]);
  }
  frame.paint(7, 2, [190, 165, 112, 255]);
  frame.paint(7, 4, [36, 91, 48, 255]);
  frame.paint(7, 6, [31, 82, 45, 255]);
  frame.paint(7, 7, [24, 75, 42, 255]);
  frame.paint(7, 8, [17, 68, 39, 255]);
  const result = refineEdgeRgba(frame.data, frame.info,
    { mode: "none", noLightArtwork: true, contourWidth: 2 });
  assert.deepEqual(frame.at(result, 7, 2), [24, 75, 42, 255]);
});

test("explicit no-light palette repairs small warm-white flecks behind the contour", () => {
  const frame = canvas(21, 21);
  for (let y = 2; y <= 18; y += 1) for (let x = 2; x <= 18; x += 1) {
    frame.paint(x, y, [75, 118, 42, 255]);
  }
  for (let y = 9; y <= 11; y += 1) for (let x = 9; x <= 11; x += 1) {
    frame.paint(x, y, [232, 216, 180, 255]);
  }
  frame.paint(15, 15, [186, 164, 72, 255]);
  const before = Buffer.from(frame.data);
  const result = refineEdgeRgba(frame.data, frame.info,
    { mode: "none", noLightArtwork: true, contourWidth: 2 });
  assert.deepEqual(frame.at(result, 10, 10), [75, 118, 42, 255]);
  assert.deepEqual(frame.at(result, 15, 15), [186, 164, 72, 255], "yellow-green artwork remains");
  assert.deepEqual(frame.data, before, "the original sprite remains untouched");
});
