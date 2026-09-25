import assert from "node:assert/strict";
import test from "node:test";
import {
  addLayer,
  blendModes,
  compositeFrame,
  createDocument,
  createHistory,
  floodFill,
  linePoints,
  paintStroke,
  patchFromSnapshot,
  pushPatch,
  readPixel,
  redoPatch,
  removeLayer,
  resetDocumentIdsForTests,
  snapshotCel,
  undoPatch,
} from "../src/sprite-document.mjs";

const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];

function document({ width = 8, height = 8, layers = 1 } = {}) {
  resetDocumentIdsForTests();
  return createDocument({ width, height, layers });
}

test("a new document has one layer, one frame and no paint", () => {
  const doc = document();
  assert.equal(doc.width, 8);
  assert.equal(doc.height, 8);
  assert.equal(doc.layers.length, 1);
  assert.equal(doc.frames.length, 1);
  assert.deepEqual(readPixel(doc, doc.layers[0].id, 0, 0, 0), [0, 0, 0, 0], "a cel starts empty");
  assert.equal(compositeFrame(doc, 0).some((value) => value !== 0), false);
});

test("a stroke is continuous even when the mouse reports distant points", () => {
  const doc = document();
  const layer = doc.layers[0].id;
  paintStroke(doc, layer, 0, [0, 0], [7, 7], { color: RED });
  for (let step = 0; step < 8; step += 1) {
    assert.deepEqual(readPixel(doc, layer, 0, step, step), RED, `the diagonal must be unbroken at ${step}`);
  }
  const points = linePoints(0, 0, 3, 0);
  assert.deepEqual(points, [[0, 0], [1, 0], [2, 0], [3, 0]]);
  assert.deepEqual(linePoints(2, 2, 2, 2), [[2, 2]], "a single point is a valid line");
});

test("the brush covers a square and the eraser clears it back", () => {
  const doc = document();
  const layer = doc.layers[0].id;
  const rect = paintStroke(doc, layer, 0, [4, 4], [4, 4], { color: RED, size: 3 });
  assert.deepEqual(rect, { x: 3, y: 3, width: 3, height: 3 });
  assert.deepEqual(readPixel(doc, layer, 0, 3, 3), RED);
  assert.deepEqual(readPixel(doc, layer, 0, 2, 2), [0, 0, 0, 0], "outside the brush stays clean");

  paintStroke(doc, layer, 0, [4, 4], [4, 4], { size: 3, erase: true });
  assert.deepEqual(readPixel(doc, layer, 0, 4, 4), [0, 0, 0, 0]);
});

test("a fill stays inside its region and cannot leak through a one-pixel wall", () => {
  const doc = document({ width: 5, height: 5 });
  const layer = doc.layers[0].id;
  // A vertical wall down the middle splits the canvas in two.
  paintStroke(doc, layer, 0, [2, 0], [2, 4], { color: BLUE });
  const rect = floodFill(doc, layer, 0, 0, 0, RED);
  assert.deepEqual(rect, { x: 0, y: 0, width: 2, height: 5 });
  assert.deepEqual(readPixel(doc, layer, 0, 1, 3), RED, "the left half is filled");
  assert.deepEqual(readPixel(doc, layer, 0, 3, 3), [0, 0, 0, 0], "the right half is untouched");
  assert.deepEqual(readPixel(doc, layer, 0, 2, 3), BLUE, "the wall survives");
  assert.equal(floodFill(doc, layer, 0, 0, 0, RED), null, "filling with the same colour does nothing");
});

test("a fill respects the tolerance", () => {
  const doc = document({ width: 3, height: 1 });
  const layer = doc.layers[0].id;
  paintStroke(doc, layer, 0, [0, 0], [0, 0], { color: [100, 100, 100, 255] });
  paintStroke(doc, layer, 0, [1, 0], [1, 0], { color: [108, 100, 100, 255] });
  paintStroke(doc, layer, 0, [2, 0], [2, 0], { color: [200, 100, 100, 255] });
  floodFill(doc, layer, 0, 0, 0, RED, { tolerance: 10 });
  assert.deepEqual(readPixel(doc, layer, 0, 1, 0), RED, "a close colour joins the region");
  assert.deepEqual(readPixel(doc, layer, 0, 2, 0), [200, 100, 100, 255], "a far colour does not");
});

test("compositing stacks layers bottom to top and skips hidden ones", () => {
  const doc = document({ width: 2, height: 1, layers: 2 });
  const bottom = doc.layers[0];
  const top = doc.layers[1];
  paintStroke(doc, bottom.id, 0, [0, 0], [1, 0], { color: RED });
  paintStroke(doc, top.id, 0, [1, 0], [1, 0], { color: BLUE });
  const flat = compositeFrame(doc, 0);
  assert.deepEqual([flat[0], flat[1], flat[2], flat[3]], RED, "the bottom layer shows where nothing covers it");
  assert.deepEqual([flat[4], flat[5], flat[6], flat[7]], BLUE, "the top layer wins where it paints");

  top.visible = false;
  const hidden = compositeFrame(doc, 0);
  assert.deepEqual([hidden[4], hidden[5], hidden[6], hidden[7]], RED, "hiding the top layer reveals what is underneath");

  top.visible = true;
  top.opacity = 128;
  const translucent = compositeFrame(doc, 0);
  // Two opaque layers, one at half opacity: the result stays opaque but mixes both colours.
  assert.equal(translucent[7], 255, "opaque layers keep the result opaque");
  assert.ok(translucent[4] > 0 && translucent[6] > 0, `half opacity must mix the colours, got ${translucent[4]} and ${translucent[6]}`);
});

test("blend modes are applied and an unknown one falls back to normal", () => {
  const doc = document({ width: 1, height: 1, layers: 2 });
  const [bottom, top] = doc.layers;
  paintStroke(doc, bottom.id, 0, [0, 0], [0, 0], { color: [200, 200, 200, 255] });
  paintStroke(doc, top.id, 0, [0, 0], [0, 0], { color: [128, 128, 128, 255] });

  top.blendMode = "multiply";
  const multiplied = compositeFrame(doc, 0);
  assert.ok(multiplied[0] < 128, `multiply must darken, got ${multiplied[0]}`);

  top.blendMode = "screen";
  const screened = compositeFrame(doc, 0);
  assert.ok(screened[0] > 200, `screen must lighten, got ${screened[0]}`);

  top.blendMode = "invented-mode";
  const fallback = compositeFrame(doc, 0);
  assert.equal(fallback[0], 128, "an unknown mode behaves like normal instead of throwing");
  assert.ok(blendModes.includes("overlay"));
});

test("a stroke becomes one undo step through a snapshot", () => {
  const doc = document();
  const layer = doc.layers[0].id;
  const history = createHistory();

  const snapshot = snapshotCel(doc, layer, 0);
  paintStroke(doc, layer, 0, [1, 1], [5, 1], { color: RED });
  const patch = patchFromSnapshot(doc, layer, 0, snapshot, "Карандаш");
  assert.ok(patch, "a change must produce a patch");
  assert.deepEqual(patch.rect, { x: 1, y: 1, width: 5, height: 1 });
  pushPatch(history, doc, patch);

  assert.deepEqual(readPixel(doc, layer, 0, 3, 1), RED);
  undoPatch(history, doc);
  assert.deepEqual(readPixel(doc, layer, 0, 3, 1), [0, 0, 0, 0], "undo must clear the stroke");
  redoPatch(history, doc);
  assert.deepEqual(readPixel(doc, layer, 0, 3, 1), RED, "redo must bring it back");

  assert.equal(patchFromSnapshot(doc, layer, 0, snapshotCel(doc, layer, 0)), null, "no change means no patch");
});

test("undo restores what was there before, not just emptiness", () => {
  const doc = document();
  const layer = doc.layers[0].id;
  const history = createHistory();
  paintStroke(doc, layer, 0, [0, 0], [1, 0], { color: BLUE });

  const snapshot = snapshotCel(doc, layer, 0);
  paintStroke(doc, layer, 0, [0, 0], [1, 0], { color: RED });
  pushPatch(history, doc, patchFromSnapshot(doc, layer, 0, snapshot));

  undoPatch(history, doc);
  assert.deepEqual(readPixel(doc, layer, 0, 0, 0), BLUE, "the earlier colour comes back");
});

test("the last layer cannot be removed, and removing one takes its cels", () => {
  const doc = document({ layers: 2 });
  const [first, second] = doc.layers;
  paintStroke(doc, second.id, 0, [0, 0], [0, 0], { color: RED });
  assert.equal(doc.cels.size, 1);
  assert.equal(removeLayer(doc, second.id), true);
  assert.equal(doc.cels.size, 0, "the cels of a removed layer go with it");
  assert.equal(doc.layers.length, 1);
  assert.equal(removeLayer(doc, first.id), false, "one layer must remain");

  const added = addLayer(doc, "Контур");
  assert.equal(doc.layers.at(-1).id, added.id);
  assert.equal(added.blendMode, "normal");
});
