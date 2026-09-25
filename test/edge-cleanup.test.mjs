import assert from "node:assert/strict";
import test from "node:test";
import { cleanMagentaFringe } from "../src/edge-cleanup.mjs";

// The cleanup only touches magenta pixels that sit next to transparency, so every fixture
// needs more than one row: a one-pixel-tall image counts as "near the edge" everywhere,
// because the scan leaves the image and treats that as transparency.
const width = 12;
const height = 7;
const channels = 4;
const middle = 3;

function fixture() {
  const data = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels;
      const transparent = x === 0;
      data[offset] = transparent ? 0 : 128;
      data[offset + 1] = transparent ? 0 : 128;
      data[offset + 2] = transparent ? 0 : 128;
      data[offset + 3] = transparent ? 0 : 255;
    }
  }
  // One magenta pixel against the transparent column, one far away from any transparency.
  for (const x of [1, 8]) {
    const offset = (middle * width + x) * channels;
    data[offset] = 255;
    data[offset + 1] = 0;
    data[offset + 2] = 255;
  }
  return data;
}

function rgb(data, x, y = middle) {
  const offset = (y * width + x) * channels;
  return [data[offset], data[offset + 1], data[offset + 2]];
}

test("a zero strength leaves the frame untouched", () => {
  const data = fixture();
  const before = Buffer.from(data);
  const result = cleanMagentaFringe(data, { width, height, channels }, 0);
  assert.deepEqual(result, before);
});

test("only the magenta pixel next to transparency is repaired", () => {
  const data = fixture();
  cleanMagentaFringe(data, { width, height, channels }, 55);

  const edge = rgb(data, 1);
  assert.notDeepEqual(edge, [255, 0, 255], "the edge pixel must be repaired");
  assert.ok(edge[0] < 255 && edge[1] > 0, `expected a blend towards the neighbours, got ${edge}`);
  assert.equal(data[(middle * width + 1) * channels + 3], 255, "cleanup must not touch alpha");

  assert.deepEqual(rgb(data, 8), [255, 0, 255], "a magenta pixel away from transparency must stay");
  assert.deepEqual(rgb(data, 0), [0, 0, 0], "transparent pixels must stay transparent");
  assert.deepEqual(rgb(data, 5), [128, 128, 128], "neutral pixels must stay neutral");
});

test("a stronger strength repairs more of the fringe", () => {
  const light = fixture();
  cleanMagentaFringe(light, { width, height, channels }, 20);
  const strong = fixture();
  cleanMagentaFringe(strong, { width, height, channels }, 100);

  const lightGreen = rgb(light, 1)[1];
  const strongGreen = rgb(strong, 1)[1];
  assert.ok(strongGreen > lightGreen, `a stronger strength must blend further: ${strongGreen} vs ${lightGreen}`);
});
