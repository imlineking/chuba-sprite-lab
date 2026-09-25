import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  addEmptyLayer,
  closeSession,
  deleteLayer,
  eraseTransparent,
  exportFrame,
  fill,
  layerPixel,
  openSession,
  paint,
  pick,
  readState,
  resetSessionsForTests,
  stepHistory,
  updateLayer,
} from "../src/editor-session.mjs";

afterEach(() => resetSessionsForTests());

// A 2×1 frame: the left pixel is black, the right one is transparent.
function basePixels() {
  return new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 0]);
}

test("an opened session keeps the frame pixels and reports its size", () => {
  const session = openSession({ width: 2, height: 1, pixels: basePixels(), name: "Кадр", frameIndex: 3 });
  assert.equal(session.width, 2);
  assert.equal(session.height, 1);
  assert.equal(session.frameIndex, 3);
  assert.equal(session.layers.length, 1);
  assert.equal(session.layers[0].name, "Кадр");
  assert.deepEqual([...session.composite], [...basePixels()]);
  assert.equal(session.canUndo, false);
});

test("painting changes the composite and one undo brings the pixel back", () => {
  const session = openSession({ width: 2, height: 1, pixels: basePixels() });
  const painted = paint(session.sessionId, { from: [1, 0], to: [1, 0], color: [255, 0, 0, 255] });
  assert.equal(painted.composite[4], 255);
  assert.equal(painted.composite[7], 255);
  assert.equal(painted.canUndo, true);
  assert.equal(painted.label, "Карандаш");

  const undone = stepHistory(session.sessionId, "undo");
  assert.equal(undone.composite[4], 0);
  assert.equal(undone.composite[7], 0);
  assert.equal(undone.canRedo, true);

  const redone = stepHistory(session.sessionId, "redo");
  assert.equal(redone.composite[4], 255);
  assert.equal(redone.composite[7], 255);
});

test("a stroke between two points is a single undo step", () => {
  const session = openSession({ width: 5, height: 1 });
  paint(session.sessionId, { from: [0, 0], to: [4, 0], color: [255, 255, 255, 255] });
  assert.equal(session.sessionId ? readState(session.sessionId).canUndo : false, true);
  const undone = stepHistory(session.sessionId, "undo");
  assert.deepEqual([...undone.composite].filter((_value, index) => index % 4 === 3), [0, 0, 0, 0, 0]);
  assert.equal(undone.canUndo, false);
});

test("the eraser clears pixels instead of painting them", () => {
  const session = openSession({ width: 2, height: 1, pixels: basePixels() });
  const erased = paint(session.sessionId, { from: [0, 0], to: [0, 0], erase: true });
  assert.equal(erased.composite[3], 0);
});

test("filling the transparent half leaves the drawn pixel alone", () => {
  const session = openSession({ width: 2, height: 1, pixels: basePixels() });
  const filled = fill(session.sessionId, { x: 1, y: 0, color: [0, 255, 0, 255] });
  assert.equal(filled.composite[3], 255);
  assert.deepEqual([...filled.composite.slice(0, 3)], [0, 0, 0]);
  assert.deepEqual([...filled.composite.slice(4, 8)], [0, 255, 0, 255]);
});

test("the eyedropper and the layer probe read different things", () => {
  const session = openSession({ width: 2, height: 1, pixels: basePixels() });
  addEmptyLayer(session.sessionId);
  paint(session.sessionId, { from: [1, 0], to: [1, 0], color: [10, 20, 30, 255] });
  // The composite holds both layers; the new layer holds only what was just drawn on it.
  assert.deepEqual(pick(session.sessionId, { x: 1, y: 0 }).color, [10, 20, 30, 255]);
  assert.deepEqual(layerPixel(session.sessionId, { x: 1, y: 0 }).color, [10, 20, 30, 255]);
  assert.deepEqual(layerPixel(session.sessionId, { x: 0, y: 0 }).color, [0, 0, 0, 0]);
});

test("hiding a layer removes it from the composite", () => {
  const session = openSession({ width: 2, height: 1, pixels: basePixels() });
  const hidden = updateLayer(session.sessionId, { layerId: session.layers[0].id, visible: false });
  assert.equal(hidden.composite[3], 0);
  const shown = updateLayer(session.sessionId, { layerId: session.layers[0].id, visible: true });
  assert.equal(shown.composite[3], 255);
});

test("a locked layer refuses to draw and says why", () => {
  const session = openSession({ width: 2, height: 1, pixels: basePixels() });
  updateLayer(session.sessionId, { layerId: session.layers[0].id, locked: true });
  const answer = paint(session.sessionId, { from: [0, 0], to: [0, 0], color: [255, 0, 0, 255] });
  assert.match(answer.blocked, /заблокирован/);
  assert.equal(answer.canUndo, false);
  assert.equal(answer.composite[0], 0);
});

test("the last layer cannot be removed and a new one becomes active", () => {
  const session = openSession({ width: 2, height: 1 });
  const blocked = deleteLayer(session.sessionId, { layerId: session.layers[0].id });
  assert.match(blocked.blocked, /последний/);
  const added = addEmptyLayer(session.sessionId, { name: "Тень" });
  assert.equal(added.layers.length, 2);
  assert.equal(added.activeLayerId, added.layers[1].id);
  const removed = deleteLayer(session.sessionId, { layerId: added.activeLayerId });
  assert.equal(removed.layers.length, 1);
});

test("erasing the transparent fringe clears a soft halo in one step", () => {
  // A keyed edge: alphas 10, 40, 255 and a fully transparent pixel.
  const halo = new Uint8ClampedArray([
    255, 255, 255, 10,
    255, 255, 255, 40,
    255, 255, 255, 255,
    0, 0, 0, 0,
  ]);
  const session = openSession({ width: 4, height: 1, pixels: halo });
  const cleared = eraseTransparent(session.sessionId, { threshold: 24 });
  assert.equal(cleared.label, "Стёрта прозрачная кайма");
  assert.deepEqual([...cleared.composite].filter((_value, index) => index % 4 === 3), [0, 40, 255, 0]);
  assert.equal(cleared.canUndo, true);
  const undone = stepHistory(session.sessionId, "undo");
  assert.equal(undone.composite[3], 10);
});

test("erasing the transparent fringe does nothing when there is no halo to remove", () => {
  const session = openSession({ width: 2, height: 1, pixels: basePixels() });
  const answer = eraseTransparent(session.sessionId, { threshold: 24 });
  assert.equal(answer.canUndo, false);
  assert.equal(answer.label, undefined);
  assert.equal(answer.composite[3], 255);
});

test("exporting gives the pixels sharp needs and closing forgets the session", () => {
  const session = openSession({ width: 2, height: 1, pixels: basePixels(), name: "frame", frameIndex: 7 });
  const frame = exportFrame(session.sessionId);
  assert.equal(frame.width, 2);
  assert.equal(frame.height, 1);
  assert.equal(frame.frameIndex, 7);
  assert.equal(frame.composite.constructor, Uint8ClampedArray);
  assert.equal(closeSession(session.sessionId), true);
  assert.throws(() => readState(session.sessionId), /закрыт/);
});

test("an unknown session is reported instead of silently doing nothing", () => {
  assert.throws(() => paint("missing", { from: [0, 0], to: [0, 0] }), /закрыт/);
  assert.throws(() => stepHistory("missing", "undo"), /закрыт/);
});
