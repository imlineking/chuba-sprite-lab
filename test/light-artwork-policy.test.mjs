import test from "node:test";
import assert from "node:assert/strict";
import { chooseLightArtworkPolicy, measureLightArtworkRgba } from "../src/light-artwork-policy.mjs";

function fixture(patches) {
  const width = 500, height = 300;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 35; y < 265; y += 1) for (let x = 35; x < 465; x += 1) {
    data.set([78, 112, 45, 255], (y * width + x) * 4);
  }
  for (const [left, top, size] of patches) for (let y = top; y < top + size; y += 1) for (let x = left; x < left + size; x += 1) {
    data.set([245, 244, 240, 255], (y * width + x) * 4);
  }
  const light = measureLightArtworkRgba(data, { width, height, channels: 4 });
  return { lightLargestShare: light.largestShare, lightPaleShare: light.paleShare,
    lightFragments: light.fragments, width, height, transparentShare: .34,
    hasTransparency: true, edgeMeasurement: "native" };
}

test("automatic light-detail policy removes fragmented pale residue but protects a white flower and small eyes", () => {
  const fragments = [];
  for (let row = 0; row < 6; row += 1) for (let column = 0; column < 10; column += 1) {
    fragments.push([55 + column * 38, 45 + row * 35, 6]);
  }
  const residue = chooseLightArtworkPolicy(fixture(fragments));
  assert.equal(residue.policy, "none");
  assert.equal(residue.confidence, "medium");
  assert.equal(chooseLightArtworkPolicy(fixture([[170, 100, 50]])).policy, "protect");
  assert.equal(chooseLightArtworkPolicy(fixture([[170, 100, 3], [184, 100, 3]])).policy, "protect");
});

test("explicit palette choice overrides the conservative automatic decision", () => {
  const whiteFlower = fixture([[170, 100, 50]]);
  assert.equal(chooseLightArtworkPolicy(whiteFlower, "none").policy, "none");
  assert.equal(chooseLightArtworkPolicy(whiteFlower, "protect").policy, "protect");
  assert.equal(chooseLightArtworkPolicy(null, "auto").policy, "protect");
});
