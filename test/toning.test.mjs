import test from "node:test";
import assert from "node:assert/strict";
import { toneRgba } from "../src/toning.mjs";

test("toning keeps alpha and the light/dark order while changing sprite colour", () => {
  const source = Buffer.from([40, 40, 40, 255, 180, 180, 180, 128, 9, 9, 9, 0]);
  const result = toneRgba(source, { channels: 4 }, { color: "#ff8040", strength: 65 });
  assert.deepEqual([result[3], result[7], result[11]], [255, 128, 0]);
  assert.ok(result[0] > result[1] && result[1] > result[2]);
  assert.ok(result[4] > result[0] && result[5] > result[1]);
  assert.deepEqual([...result.subarray(8)], [9, 9, 9, 0]);
  assert.deepEqual([...source.subarray(0, 4)], [40, 40, 40, 255]);
});
