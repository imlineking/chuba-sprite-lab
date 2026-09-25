import assert from "node:assert/strict";
import test from "node:test";
import { frameNameWithoutExtension, matchSheetFrameNames, readSheetFrameRects } from "../src/sheet-metadata.mjs";

test("reads frame names from an array manifest (Chuba and Aseprite shapes)", () => {
  const chuba = {
    frameWidth: 512,
    frameHeight: 512,
    frames: [
      { name: "run_0000", x: 0, y: 0, width: 512, height: 512 },
      { name: "run_0001", x: 512, y: 0, width: 512, height: 512 },
    ],
  };
  assert.deepEqual(readSheetFrameRects(chuba), [
    { name: "run_0000", x: 0, y: 0, width: 512, height: 512 },
    { name: "run_0001", x: 512, y: 0, width: 512, height: 512 },
  ]);

  const aseprite = {
    frames: [
      { filename: "run_0000.png", frame: { x: 0, y: 0, w: 512, h: 512 } },
      { filename: "run_0001.png", frame: { x: 512, y: 0, w: 512, h: 512 } },
    ],
  };
  assert.deepEqual(readSheetFrameRects(aseprite).map((entry) => entry.name), ["run_0000", "run_0001"]);
});

test("keeps object-style manifests (TexturePacker) working", () => {
  const packer = {
    frames: {
      "hero/run_0000.png": { frame: { x: 0, y: 0, w: 64, h: 64 } },
      "hero/run_0001.png": { frame: { x: 64, y: 0, w: 64, h: 64 } },
    },
  };
  assert.deepEqual(readSheetFrameRects(packer).map((entry) => entry.name), ["run_0000", "run_0001"]);
});

test("falls back to the manifest cell size and drops unusable rectangles", () => {
  const manifest = {
    frameWidth: 128,
    frameHeight: 96,
    frames: [
      { name: "good", x: 0, y: 0 },
      { name: "broken", x: "nope", y: 0, width: 10, height: 10 },
    ],
  };
  assert.deepEqual(readSheetFrameRects(manifest), [{ name: "good", x: 0, y: 0, width: 128, height: 96 }]);
});

test("matches detected cells to the rectangle containing their centre", () => {
  const rects = [
    { name: "a", x: 0, y: 0, width: 100, height: 100 },
    { name: "b", x: 100, y: 0, width: 100, height: 100 },
  ];
  const cells = [
    { left: 10, top: 10, width: 40, height: 40 },
    { left: 120, top: 20, width: 40, height: 40 },
    { left: 400, top: 400, width: 10, height: 10 },
  ];
  assert.deepEqual(matchSheetFrameNames(cells, rects), ["a", "b", null]);
});

test("normalises paths and extensions", () => {
  assert.equal(frameNameWithoutExtension("hero\\run_0000.PNG"), "run_0000");
  assert.equal(frameNameWithoutExtension("frames/run_0001.webp"), "run_0001");
  assert.equal(frameNameWithoutExtension(undefined), "");
});
