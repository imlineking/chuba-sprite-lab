import assert from "node:assert/strict";
import test from "node:test";
import { reviewMatteRgba } from "../src/matte-review.mjs";

test("matte review counts real alpha and flags potential holes without changing pixels", () => {
  const data = Buffer.alloc(5 * 5 * 4);
  const put = (x, y, pixel) => data.set(pixel, (y * 5 + x) * 4);
  for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) put(x, y, [70, 120, 30, 255]);
  put(2, 2, [220, 210, 200, 120]);
  put(1, 1, [250, 245, 230, 80]);
  const before = Buffer.from(data);
  const review = reviewMatteRgba(data, { width: 5, height: 5, channels: 4 });
  assert.deepEqual({ clear: review.clear, opaque: review.opaque, partial: review.partial, palePartial: review.palePartial, innerPartial: review.innerPartial }, { clear: 16, opaque: 7, partial: 2, palePartial: 2, innerPartial: 1 });
  assert.deepEqual(review.bounds, { left: 1, top: 1, width: 3, height: 3 });
  assert.equal(review.contentFraction, 36);
  assert.equal(review.touchesCanvas, false);
  assert.deepEqual(data, before);
  put(0, 3, [30, 40, 50, 255]);
  assert.equal(reviewMatteRgba(data, { width: 5, height: 5, channels: 4 }).touchesCanvas, true);
});

test("matte review rejects non-RGBA pixels and reports an empty matte", () => {
  assert.throws(() => reviewMatteRgba(Buffer.alloc(3), { width: 1, height: 1, channels: 3 }), /RGBA/);
  const empty = reviewMatteRgba(Buffer.alloc(4), { width: 1, height: 1, channels: 4 });
  assert.equal(empty.bounds, null);
  assert.equal(empty.clear, 1);
});
