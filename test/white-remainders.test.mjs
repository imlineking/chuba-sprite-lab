import assert from "node:assert/strict";
import test from "node:test";
import { findWhiteRemainders } from "../src/white-remainders.mjs";

test("white remainder hint finds enclosed white pixels without altering the sprite", () => {
  const width = 80;
  const height = 80;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 8; y < 72; y += 1) {
    for (let x = 8; x < 72; x += 1) {
      const offset = (y * width + x) * 4;
      rgba.set(x >= 30 && x < 46 && y >= 30 && y < 46 ? [255, 255, 255, 255] : [20, 120, 200, 255], offset);
    }
  }
  const original = Buffer.from(rgba);
  const found = findWhiteRemainders(rgba, { width, height, channels: 4 }, [255, 255, 255]);
  assert.equal(found.count, 1);
  assert.deepEqual(found.regions[0], { x: 30, y: 30, width: 16, height: 16, pixels: 256 });
  assert.deepEqual(rgba, original);
});
