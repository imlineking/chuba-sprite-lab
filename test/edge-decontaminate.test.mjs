import assert from "node:assert/strict";
import test from "node:test";
import { decontaminateEdges } from "../src/edge-decontaminate.mjs";

const info = { width: 1, height: 1, channels: 4 };

function blend(subject, background, alpha) {
  const ratio = alpha / 255;
  return Buffer.from([
    ...subject.map((channel, index) => Math.round(ratio * channel + (1 - ratio) * background[index])),
    alpha,
  ]);
}

test("recovers the subject colour from a blended edge pixel", () => {
  const background = [255, 255, 255];
  const subject = [200, 60, 20];
  const data = blend(subject, background, 128);
  decontaminateEdges(data, info, background);
  for (let channel = 0; channel < 3; channel += 1) {
    assert.ok(Math.abs(data[channel] - subject[channel]) <= 3, `channel ${channel} came back as ${data[channel]}, expected about ${subject[channel]}`);
  }
  assert.equal(data[3], 128, "alpha must not change");
});

test("works just as well against a dark background", () => {
  const background = [12, 14, 20];
  const subject = [230, 140, 40];
  const data = blend(subject, background, 96);
  decontaminateEdges(data, info, background);
  for (let channel = 0; channel < 3; channel += 1) {
    assert.ok(Math.abs(data[channel] - subject[channel]) <= 6, `channel ${channel} came back as ${data[channel]}, expected about ${subject[channel]}`);
  }
});

test("opaque and transparent pixels are left exactly as they are", () => {
  const background = [255, 255, 255];
  const opaque = Buffer.from([10, 20, 30, 255]);
  const transparent = Buffer.from([10, 20, 30, 0]);
  const opaqueBefore = Buffer.from(opaque);
  const transparentBefore = Buffer.from(transparent);
  decontaminateEdges(opaque, info, background);
  decontaminateEdges(transparent, info, background);
  assert.deepEqual(opaque, opaqueBefore);
  assert.deepEqual(transparent, transparentBefore);
});

test("a tiny alpha is clamped instead of exploding", () => {
  const background = [255, 255, 255];
  const data = Buffer.from([250, 250, 250, 3]);
  decontaminateEdges(data, info, background);
  for (let channel = 0; channel < 4; channel += 1) {
    assert.ok(data[channel] >= 0 && data[channel] <= 255, `channel ${channel} left the byte range: ${data[channel]}`);
  }
});

test("a missing background leaves the buffer untouched", () => {
  const data = Buffer.from([200, 100, 50, 120]);
  const before = Buffer.from(data);
  decontaminateEdges(data, info, null);
  assert.deepEqual(data, before);
});

test("the whole frame is processed, not just the first pixel", () => {
  const background = [255, 255, 255];
  const subject = [10, 10, 10];
  const frame = Buffer.concat([blend(subject, background, 128), blend(subject, background, 128)]);
  decontaminateEdges(frame, { width: 2, height: 1, channels: 4 }, background);
  for (const offset of [0, 4]) {
    assert.ok(frame[offset] < 30, `pixel at ${offset} was not unconmined: ${frame[offset]}`);
  }
});
