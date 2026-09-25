import assert from "node:assert/strict";
import test from "node:test";
import { applyMaskEdits } from "../src/mask-edits.mjs";

const width = 20;
const height = 20;
const channels = 4;
const info = { width, height, channels };

function fixture() {
  const data = Buffer.alloc(width * height * channels);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * channels;
    data[offset] = 0;
    data[offset + 1] = 0;
    data[offset + 2] = 0;
    data[offset + 3] = 255;
  }
  // A five by five red square at (5, 5), used as the tracked region.
  for (let y = 5; y < 10; y += 1) {
    for (let x = 5; x < 10; x += 1) {
      const offset = (y * width + x) * channels;
      data[offset] = 255;
      data[offset + 1] = 0;
      data[offset + 2] = 0;
    }
  }
  return data;
}

function alphaAt(data, x, y) {
  return data[(y * width + x) * channels + 3];
}

test("a brush erase clears the painted area and reports no tracking", () => {
  const original = fixture();
  const data = Buffer.from(original);
  const { tracked } = applyMaskEdits(data, original, info, [{ type: "brush", mode: "erase", x: 0.5, y: 0.5, radius: 0.2, frameIndex: 0 }], 0);
  assert.deepEqual(tracked, []);
  assert.equal(alphaAt(data, 9, 9), 0, "the painted centre must be erased");
  assert.equal(alphaAt(data, 0, 0), 255, "untouched pixels must keep their alpha");
});

test("a keep brush restores alpha from the original frame", () => {
  const original = fixture();
  const data = Buffer.from(original);
  for (let index = 0; index < width * height; index += 1) data[index * channels + 3] = 0;
  applyMaskEdits(data, original, info, [{ type: "brush", mode: "keep", x: 0.5, y: 0.5, radius: 0.5, frameIndex: 0 }], 0);
  assert.equal(alphaAt(data, 9, 9), 255, "the protected centre must come back");
  assert.equal(alphaAt(data, 0, 0), 0, "far away pixels must stay erased");
});

test("a brush edit applies only to its own frame unless it is marked for all", () => {
  const original = fixture();
  const perFrame = Buffer.from(original);
  applyMaskEdits(perFrame, original, info, [{ type: "brush", mode: "erase", x: 0.5, y: 0.5, radius: 0.2, frameIndex: 0 }], 1);
  assert.equal(alphaAt(perFrame, 9, 9), 255, "a frame edit must not leak into another frame");

  const everywhere = Buffer.from(original);
  applyMaskEdits(everywhere, original, info, [{ type: "brush", mode: "erase", x: 0.5, y: 0.5, radius: 0.2, frameIndex: 0, applyAll: true }], 1);
  assert.equal(alphaAt(everywhere, 9, 9), 0, "applyAll must reach every frame");
});

test("a tracked region is found by colour and removed with its halo", () => {
  const original = fixture();
  const data = Buffer.from(original);
  const edit = {
    type: "tracked-region", strokeId: "s1", color: [255, 0, 0], tolerance: 42,
    centroidX: 7 / (width - 1), centroidY: 7 / (height - 1), area: 25 / (width * height),
    selectionWidth: 5 / width, selectionHeight: 5 / height,
    x: 7 / (width - 1), y: 7 / (height - 1), frameIndex: 0, searchRadius: 0.28,
  };
  const { tracked } = applyMaskEdits(data, original, info, [edit], 0);
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0].strokeId, "s1");
  assert.equal(tracked[0].matched, true);
  assert.equal(tracked[0].pixels, 25, "the whole five by five square is one region");
  assert.ok(tracked[0].confidence > 0.9, `a pixel-exact seed must be confident, got ${tracked[0].confidence}`);
  assert.equal(alphaAt(data, 7, 7), 0, "the tracked region must be removed");
  assert.equal(alphaAt(data, 0, 0), 255, "the rest of the frame must survive");
});

test("a tracked region that is not in the frame is reported instead of guessed", () => {
  const original = fixture();
  const data = Buffer.from(original);
  const edit = {
    type: "tracked-region", strokeId: "s1", color: [0, 255, 0], tolerance: 42,
    centroidX: 7 / (width - 1), centroidY: 7 / (height - 1), area: 25 / (width * height),
    selectionWidth: 5 / width, selectionHeight: 5 / height,
    x: 7 / (width - 1), y: 7 / (height - 1), frameIndex: 0, searchRadius: 0.28,
  };
  const { tracked } = applyMaskEdits(data, original, info, [edit], 0);
  assert.equal(tracked[0].matched, false);
  assert.equal(tracked[0].pixels, 0);
  assert.deepEqual(data, original, "nothing may be erased when the region was not found");
});

test("no edits leave the buffer completely alone", () => {
  const original = fixture();
  const data = Buffer.from(original);
  const result = applyMaskEdits(data, original, info, [], 0);
  assert.deepEqual(result.data, original);
  assert.deepEqual(result.tracked, []);
});
