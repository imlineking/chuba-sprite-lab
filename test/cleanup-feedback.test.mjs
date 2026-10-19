import test from 'node:test';
import assert from 'node:assert/strict';
import { compareCleanupPixels, proposeContourRetry } from '../src/cleanup-feedback.mjs';
const fixture = () => {
  const width = 50, height = 40, data = Buffer.alloc(width * height * 4);
  for (let y = 8; y < 32; y++) for (let x = 8; x < 42; x++) data.set(x === 8 || x === 41 || y === 8 || y === 31 ? [220, 220, 220, 255] : [20 + x, 85 + y, 25, 255], (y * width + x) * 4);
  return { data, info: { width, height, channels: 4 } };
};
test('cleanup reports real alpha and RGB changes without counting invisible RGB', () => {
  const a = Buffer.from([20, 30, 40, 255, 0, 0, 0, 0]), b = Buffer.from([40, 30, 40, 255, 255, 255, 255, 0]);
  assert.deepEqual(compareCleanupPixels(a, b), { changed: 1, alphaChanged: 0, rgbChanged: 1, alphaLowered: 0, alphaRaised: 0, alphaPreserved: true });
  b[3] = 128; assert.equal(compareCleanupPixels(a, b).alphaLowered, 1);
});
test('one contour trial improves the neutral edge, preserves every alpha and leaves source immutable', () => {
  const { data, info } = fixture(), original = Buffer.from(data), result = proposeContourRetry(data, info);
  assert.equal(result.report.attempts, 1); assert.equal(result.report.accepted, true);
  assert.ok(result.report.afterNeutralEdge < result.report.beforeNeutralEdge); assert.deepEqual(data, original);
  for (let p = 3; p < data.length; p += 4) assert.equal(result.data[p], data[p]);
});
test('coherent white artwork is protected, unchanged trial keeps original and cannot erode', () => {
  const { data, info } = fixture();
  for (let y = 8; y < 19; y++) for (let x = 8; x < 22; x++) data.set([255, 252, 243, 255], (y * info.width + x) * 4);
  const result = proposeContourRetry(data, info);
  for (let y = 8; y < 19; y++) for (let x = 8; x < 22; x++) assert.deepEqual(result.data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4), data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4));
  const empty = Buffer.alloc(20 * 20 * 4), trial = proposeContourRetry(empty, { width: 20, height: 20, channels: 4 });
  assert.equal(trial.report.accepted, false); assert.deepEqual(trial.data, empty);
});
