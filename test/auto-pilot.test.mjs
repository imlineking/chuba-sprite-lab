import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { analyseFrame, catalogSummary, measureSource, mergeFrameAnalyses, planAutoPilot } from "../src/auto-pilot.mjs";

// Synthetic frames: the measurements are checked against pictures whose answer is known by hand.

function frame(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = paint(x, y);
      const offset = (y * width + x) * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = a;
    }
  }
  return { data, info: { width, height } };
}

// A fully opaque, single-colour picture: a solid background that needs no model.
function solidFrame(width = 32, height = 32) {
  return frame(width, height, () => [200, 40, 40, 255]);
}

// A sprite on a transparent background, with a light almost transparent rim around it.
function fringedFrame() {
  return frame(32, 32, (x, y) => {
    const inside = x >= 8 && x < 24 && y >= 8 && y < 24;
    const ring = x >= 6 && x < 26 && y >= 6 && y < 26;
    if (inside) return [30, 60, 90, 255];
    if (ring) return [250, 250, 250, 90];
    return [0, 0, 0, 0];
  });
}

// A comb: many thin vertical teeth, which is what fur and hair look like to this measurement.
function hairyFrame() {
  return frame(32, 32, (x) => (x % 2 === 0 ? [40, 40, 40, 255] : [220, 200, 180, 255]));
}

// A smooth gradient: no flat areas, small steps — a photograph, not a drawing.
function gradientFrame() {
  return frame(32, 32, (x, y) => [x * 8, y * 8, 128, 255]);
}

test("a fully opaque flat picture reads as a solid background", () => {
  const { data, info } = solidFrame();
  const measured = analyseFrame(data, info);
  assert.equal(measured.borderOpaqueRatio, 1);
  assert.equal(measured.borderColourCount, 1);
  assert.equal(measured.colourCount, 1);
  assert.equal(measured.softShare, 0);
  // The frame is opaque to its own edge, so there is no perimeter to speak of.
  assert.equal(measured.thinStructure, 0);
  assert.equal(measured.detailDensity, 0);
  assert.equal(measured.flatShare, 1);
});

test("a light almost transparent rim is recognised as a ring left by the key", () => {
  const { data, info } = fringedFrame();
  const measured = analyseFrame(data, info);
  assert.ok(measured.softShare > 0.1, `ожидалась мягкая кайма, получено ${measured.softShare}`);
  assert.equal(measured.fringeScore, 1);
  assert.equal(measured.hasTransparency, true);
});

test("thin teeth raise the perimeter and the detail density", () => {
  const hairy = analyseFrame(...Object.values(hairyFrame()));
  const smooth = analyseFrame(...Object.values(solidFrame()));
  assert.ok(hairy.detailDensity > 0.9, `плотность деталей ${hairy.detailDensity}`);
  assert.ok(hairy.detailDensity > smooth.detailDensity);
  assert.ok(hairy.colourCount > smooth.colourCount);
});

test("a gradient has no flat areas, a drawing has plenty", () => {
  const gradient = analyseFrame(...Object.values(gradientFrame()));
  const solid = analyseFrame(...Object.values(solidFrame()));
  assert.equal(gradient.flatShare, 0);
  assert.ok(gradient.gradientShare > 0.8, `плавные переходы ${gradient.gradientShare}`);
  assert.ok(solid.flatShare > gradient.flatShare);
});

test("measurements from several frames are merged sensibly", () => {
  const merged = mergeFrameAnalyses([
    { width: 10, height: 10, softShare: 0, flatShare: 1, transparentShare: 0, colourCount: 2, borderOpaqueRatio: 1, borderColourCount: 1, thinStructure: 0, detailDensity: 0, fringeScore: 0, gradientShare: 0, opaqueShare: 1, hasTransparency: false },
    { width: 40, height: 20, softShare: 0.5, flatShare: 0.5, transparentShare: 0.5, colourCount: 8, borderOpaqueRatio: 0.5, borderColourCount: 4, thinStructure: 0.6, detailDensity: 0.4, fringeScore: 0.2, gradientShare: 0.1, opaqueShare: 0.5, hasTransparency: true },
  ]);
  assert.equal(merged.width, 40);
  assert.equal(merged.height, 20);
  assert.equal(merged.colourCount, 8);
  assert.equal(merged.borderColourCount, 4);
  assert.equal(merged.softShare, 0.25);
  assert.equal(merged.hasTransparency, true);
  assert.equal(merged.sampled, 2);
  assert.equal(mergeFrameAnalyses([]), null);
});

/* ------------------------------------------------------------------ planning */

function measure(overrides = {}) {
  return {
    width: 512,
    height: 512,
    opaqueShare: 0.4,
    softShare: 0.01,
    transparentShare: 0.59,
    borderOpaqueRatio: 0.3,
    borderColourCount: 9,
    colourCount: 18,
    thinStructure: 0.1,
    detailDensity: 0.03,
    fringeScore: 0,
    flatShare: 0.6,
    gradientShare: 0.05,
    hasTransparency: true,
    frameCount: 12,
    ...overrides,
  };
}

test("a solid background is cut by the contour and no model is required", () => {
  const plan = planAutoPilot({
    measurements: measure({ borderOpaqueRatio: 1, borderColourCount: 1 }),
    target: { cellWidth: 128, cellHeight: 128, atlasMaxSize: 4096 },
    source: { kind: "video", frameCount: 24 },
    installed: ["u2netp"],
  });
  assert.equal(plan.steps[0].stage, "key");
  assert.equal(plan.steps[0].status, "ready");
  assert.equal(plan.steps.at(-1).stage, "inspect");
  assert.equal(plan.needed.length, 0, "для однотонного фона модель не нужна");
  assert.match(plan.summary, /без модели|однотонный/i);
});

test("an existing transparent border keeps its alpha instead of asking for matting", () => {
  const { data, info } = fringedFrame();
  const plan = planAutoPilot({
    measurements: analyseFrame(data, info),
    target: { cellWidth: 64 },
    source: { kind: "frames", frameCount: 4 },
    installed: ["u2netp"],
  });
  assert.equal(plan.steps[0].tool, "alpha");
  assert.equal(plan.steps.some((step) => step.stage === "matting"), false);
  assert.match(plan.summary, /прозрачность/i);
});

test("a complex edge asks for the best installed matting model", () => {
  const plan = planAutoPilot({
    measurements: measure({ thinStructure: 0.6, detailDensity: 0.3, softShare: 0.2 }),
    target: { cellWidth: 128 },
    source: { kind: "video", frameCount: 24 },
    installed: ["u2netp", "isnet-general"],
  });
  const matting = plan.steps.find((step) => step.stage === "matting");
  assert.equal(matting.tool, "isnet-general");
  assert.equal(matting.status, "ready");
  assert.match(matting.why, /мех|волос/i);
  // Better models are still offered, but the step itself can run.
  assert.ok(plan.needed.some((entry) => entry.id === "birefnet-hr-matting"));
  assert.ok(plan.needed.every((entry) => entry.kind === "improve"));
});

test("with nothing but the bundled model the plan still runs, and says what would be better", () => {
  const plan = planAutoPilot({
    measurements: measure({ thinStructure: 0.6, detailDensity: 0.3 }),
    target: { cellWidth: 128 },
    source: { kind: "video", frameCount: 24 },
    installed: ["u2netp"],
  });
  const matting = plan.steps.find((step) => step.stage === "matting");
  assert.equal(matting.status, "ready");
  assert.equal(matting.tool, "u2netp");
  assert.ok(plan.needed.length > 0);
  assert.ok(plan.needed.every((entry) => entry.canDownload || entry.ready));
});

test("the plan never pretends a missing model is available", () => {
  const plan = planAutoPilot({
    measurements: measure({ width: 96, height: 96 }),
    target: { cellWidth: 256, cellHeight: 256, atlasMaxSize: 4096 },
    source: { kind: "images", frameCount: 6 },
    installed: ["u2netp"],
  });
  const upscale = plan.steps.find((step) => step.stage === "upscale");
  assert.equal(upscale.status, "blocked");
  assert.equal(upscale.modelId, "real-esrgan");
  assert.equal(plan.needed.some((entry) => entry.id === "real-esrgan" && entry.required), true);
});

test("few frames in a video call for interpolation", () => {
  const plan = planAutoPilot({
    measurements: measure({ frameCount: 5 }),
    target: { cellWidth: 128 },
    source: { kind: "video", frameCount: 5 },
    installed: ["u2netp"],
  });
  const step = plan.steps.find((entry) => entry.stage === "interpolate");
  assert.equal(step.modelId, "rife");
  assert.equal(step.status, "blocked");
  assert.equal(plan.needed.some((entry) => entry.id === "rife" && entry.required), true);
});

test("a light rim adds the decontamination step", () => {
  const plan = planAutoPilot({
    measurements: measure({ fringeScore: 0.3 }),
    target: { cellWidth: 128 },
    source: { kind: "images", frameCount: 8 },
    installed: ["u2netp"],
  });
  const step = plan.steps.find((entry) => entry.stage === "fringe");
  assert.equal(step.tool, "edge-decontaminate");
  assert.match(step.why, /30%/);
});

test("the pixel-art style follows the frame, not a preset", () => {
  const drawn = planAutoPilot({
    measurements: measure({ flatShare: 0.8, gradientShare: 0.02, colourCount: 12 }),
    target: { cellWidth: 48, cellHeight: 48, pixelArt: true },
    source: { kind: "images", frameCount: 8 },
    installed: ["u2netp"],
  }).steps.find((step) => step.stage === "pixelate");
  assert.equal(drawn.settings.mode, "clean");
  assert.equal(drawn.settings.dither, "none");
  assert.equal(drawn.settings.size, 2);
  assert.equal(drawn.settings.colors, 12);

  const photo = planAutoPilot({
    measurements: measure({ flatShare: 0.05, gradientShare: 0.6, colourCount: 220 }),
    target: { cellWidth: 96, cellHeight: 96, pixelArt: true },
    source: { kind: "images", frameCount: 8 },
    installed: ["u2netp"],
  }).steps.find((step) => step.stage === "pixelate");
  assert.equal(photo.settings.mode, "shaded");
  assert.equal(photo.settings.dither, "bayer4");
  assert.equal(photo.settings.size, 4);
  assert.equal(photo.settings.colors, 48);
  assert.match(photo.why, /Плавные переходы/);
});

test("a sheet larger than the limit is split into pages", () => {
  const plan = planAutoPilot({
    measurements: measure({ frameCount: 60 }),
    target: { cellWidth: 128, cellHeight: 128, atlasMaxSize: 4096 },
    source: { kind: "video", frameCount: 60 },
    installed: ["u2netp"],
  });
  const step = plan.steps.find((entry) => entry.stage === "atlas");
  assert.equal(step.stage, "atlas");
  assert.match(step.why, /7680|4096/);
});

test("a heavy model asks for the highest quality and warns about memory", () => {
  const plan = planAutoPilot({
    measurements: measure({ width: 1600, height: 1200, thinStructure: 0.6, detailDensity: 0.3 }),
    target: { cellWidth: 256 },
    source: { kind: "video", frameCount: 24 },
    installed: ["u2netp", "birefnet-hr-matting"],
  });
  assert.equal(plan.settings.quality, "max");
  assert.equal(plan.steps.find((step) => step.stage === "matting").tool, "birefnet-hr-matting");
  assert.ok(plan.notes.some((note) => /памяти/.test(note)));
});

test("a small frame with the bundled model runs quickly instead of heavily", () => {
  const plan = planAutoPilot({
    measurements: measure({ width: 320, height: 320 }),
    target: { cellWidth: 128 },
    source: { kind: "images", frameCount: 10 },
    installed: ["u2netp"],
  });
  assert.equal(plan.settings.quality, "fast");
});

test("with no frames at all the plan says so instead of inventing steps", () => {
  const plan = planAutoPilot({ measurements: null, target: {}, source: {}, installed: [] });
  assert.deepEqual(plan.steps, []);
  assert.equal(plan.needed.length, 0);
  assert.match(plan.notes[0], /добавьте источник/i);
});

/* ------------------------------------------------------------------ real files */

// The measurement runs on a reduced copy, but the size it reports has to be the real one: a big frame
// must never look small, or the plan would suggest upscaling what is already large.
test("a real frame is measured from a small copy but reports its true size", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "csl-measure-"));
  try {
    const file = path.join(directory, "frame.png");
    await sharp({ create: { width: 400, height: 300, channels: 4, background: { r: 250, g: 250, b: 250, alpha: 1 } } })
      .png()
      .toFile(file);
    const measured = await measureSource([file]);
    assert.equal(measured.width, 400);
    assert.equal(measured.height, 300);
    assert.equal(measured.sampled, 1);
    assert.ok(measured.sampledWidth <= 192, `образец ${measured.sampledWidth}`);
    assert.equal(measured.frameCount, 1);
    assert.equal(measured.borderOpaqueRatio, 1);
    assert.deepEqual(measured.failures, []);

    // And the plan built from it treats the frame as large: 400 px is smaller than a 640 px cell, but
    // the reported size is what the interface shows.
    const plan = planAutoPilot({ measurements: measured, target: { cellWidth: 256, cellHeight: 256 }, source: { kind: "images", frameCount: 1 }, installed: ["u2netp"] });
    assert.equal(plan.steps.some((step) => step.stage === "upscale"), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("an unreadable file is reported instead of measured", async () => {
  const measured = await measureSource([path.join(os.tmpdir(), "this-file-does-not-exist.png")]);
  assert.equal(measured, null);
});

test("a catalogue summary carries what the window has to show", () => {
  const list = catalogSummary();
  assert.ok(list.length > 10);
  const entry = list.find((model) => model.id === "vitmatte-small");
  assert.equal(entry.sha256.length, 64);
  assert.equal(entry.licence.commercial, true);
  assert.ok(entry.totalBytes > 0);
  const bundled = list.find((model) => model.id === "u2netp");
  assert.equal(bundled.bundled, true);
  assert.equal(bundled.url, null);
});
