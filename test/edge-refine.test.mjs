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

test("grey fringe on a one-pixel needle borrows colour from the same thin stroke", () => {
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
  assert.deepEqual(frame.at(result, 3, 4), [12, 62, 48, 255]);
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
