import assert from "node:assert/strict";
import test from "node:test";
import { adjustImageRgba } from "../src/color-adjust.mjs";

test("brightness, contrast and warmth adjust RGB without changing alpha or source", () => {
  const original = Buffer.from([100, 100, 100, 255, 40, 90, 180, 100, 0, 0, 0, 0]);
  const adjusted = adjustImageRgba(original, { brightness: 12, contrast: 20, warmth: 35 });
  assert.ok(adjusted[0] > adjusted[2], "warmth raises red and lowers blue");
  assert.ok(adjusted[0] > original[0], "brightness raises visible pixels");
  assert.deepEqual([adjusted[3], adjusted[7], adjusted[11]], [255, 100, 0]);
  assert.deepEqual(adjusted.subarray(8), original.subarray(8));
  assert.deepEqual(original, Buffer.from([100, 100, 100, 255, 40, 90, 180, 100, 0, 0, 0, 0]));
});
