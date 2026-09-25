import assert from "node:assert/strict";
import test from "node:test";
import { collectAtlasErrors, inspectAtlas } from "../src/atlas-inspector.mjs";

function frame(overrides = {}) {
  return {
    index: 0,
    sourceFrameIndex: overrides.index ?? 0,
    name: "run_0000",
    page: 0,
    x: 0, y: 0, width: 64, height: 64,
    trimmed: false,
    spriteSourceSize: { x: 0, y: 0, w: 64, h: 64 },
    sourceSize: { w: 64, h: 64 },
    durationMs: 125,
    pivot: { x: 0.5, y: 1 },
    hitbox: { x: 10, y: 4, width: 40, height: 60 },
    hitboxSpace: "cell",
    ...overrides,
  };
}

function validManifest() {
  return {
    frameCount: 2,
    pivot: { x: 0.5, y: 1 },
    pages: [{ image: "run.sheet.png", width: 128, height: 64 }],
    animations: [{ name: "run", from: 0, to: 1, frameCount: 2, fps: 8, loop: { mode: "loop", from: 0, to: 1 } }],
    frames: [frame(), frame({ index: 1, name: "run_0001", x: 64, hitbox: { x: 12, y: 4, width: 40, height: 60 } })],
  };
}

function codes(manifest, options) {
  return inspectAtlas(manifest, options).issues.map((issue) => issue.code);
}

test("a healthy manifest reports nothing", () => {
  const report = inspectAtlas(validManifest(), { maxSize: 4096 });
  assert.deepEqual(report.issues, []);
  assert.deepEqual([report.errors, report.warnings, report.frames, report.pages, report.tags], [0, 0, 2, 1, 1]);
});

test("a frame reused twice in the timeline is not an overlap", () => {
  const manifest = validManifest();
  // Grid packing points both timeline positions at the same image.
  manifest.frames.push(frame({ index: 2, name: "run_0000_again" }));
  manifest.frameCount = 3;
  manifest.animations[0].to = 2;
  manifest.animations[0].frameCount = 3;
  assert.deepEqual(codes(manifest), []);
});

test("geometry problems outside the page or the cell are errors", () => {
  const outside = validManifest();
  outside.frames[1].x = 96;
  assert.ok(codes(outside).includes("frame-outside-page"));

  const badHitbox = validManifest();
  badHitbox.frames[0].hitbox = { x: 40, y: 4, width: 40, height: 60 };
  assert.ok(codes(badHitbox).includes("hitbox-outside-cell"));

  const badTrim = validManifest();
  badTrim.frames[0] = frame({ trimmed: true, spriteSourceSize: { x: 40, y: 0, w: 40, h: 64 } });
  assert.ok(codes(badTrim).includes("frame-trim-box"));

  const overlap = validManifest();
  overlap.frames[1] = frame({ index: 1, name: "run_0001", x: 32 });
  assert.ok(codes(overlap).includes("frame-overlap"));
});

test("the atlas limit is only enforced when the plan claims to honour it", () => {
  const manifest = validManifest();
  assert.deepEqual(codes(manifest, { maxSize: 64 }), ["page-over-limit"]);
  assert.deepEqual(codes(manifest, { maxSize: 0 }), []);
  assert.deepEqual(codes(manifest), []);
});

test("tag ranges, frameCount, durations and pivot are validated", () => {
  const badTag = validManifest();
  badTag.animations[0].to = 9;
  assert.ok(codes(badTag).includes("tag-range"));

  const badTagCount = validManifest();
  badTagCount.animations[0].frameCount = 5;
  assert.ok(codes(badTagCount).includes("tag-count"));

  const badCount = validManifest();
  badCount.frameCount = 7;
  assert.ok(codes(badCount).includes("frame-count"));

  const badDuration = validManifest();
  badDuration.frames[0].durationMs = 0;
  assert.ok(codes(badDuration).includes("frame-duration"));

  const badPivot = validManifest();
  badPivot.pivot = { x: 0.5, y: 1.4 };
  assert.ok(codes(badPivot).includes("pivot-range"));
});

test("duplicate frame names and missing pages are reported", () => {
  const duplicate = validManifest();
  duplicate.frames[1].name = "run_0000";
  assert.ok(codes(duplicate).includes("duplicate-frame-name"));

  const missingPage = validManifest();
  missingPage.frames[0].page = 4;
  assert.ok(codes(missingPage).includes("frame-page"));

  assert.ok(codes({ frames: [], pages: [], animations: [] }).includes("no-frames"));
});

test("a missing hitbox and a pivot outside it are warnings, not errors", () => {
  const noHitbox = validManifest();
  noHitbox.frames[0].hitbox = null;
  const missing = inspectAtlas(noHitbox).issues.find((issue) => issue.code === "hitbox-missing");
  assert.equal(missing?.severity, "warning");
  assert.equal(missing.sourceFrameIndex, 0);

  const strayPivot = validManifest();
  strayPivot.frames[0].pivot = { x: 1, y: 0 };
  const outside = inspectAtlas(strayPivot).issues.find((issue) => issue.code === "pivot-outside-hitbox");
  assert.equal(outside?.severity, "warning");

  // A pivot exactly on the edge of the hitbox is not a problem.
  const onEdge = validManifest();
  onEdge.frames[0].pivot = { x: (10 + 40) / 64, y: (4 + 60) / 64 };
  assert.equal(codes(onEdge).includes("pivot-outside-hitbox"), false);
});

test("an issue that points at a frame also carries its source index", () => {
  const manifest = validManifest();
  manifest.frames[1].sourceFrameIndex = 7;
  manifest.frames[1].x = 96;
  const issue = inspectAtlas(manifest).issues.find((item) => item.code === "frame-outside-page");
  assert.ok(issue, "the frame must be reported as outside the page");
  assert.equal(issue.frameIndex, 1);
  assert.equal(issue.sourceFrameIndex, 7, "the caller needs the source index to jump to the frame");
});

test("pages must name distinct image files", () => {
  const missing = validManifest();
  delete missing.pages[0].image;
  assert.ok(codes(missing).includes("page-image"));

  const duplicate = validManifest();
  duplicate.pages.push({ image: "run.sheet.png", width: 128, height: 64 });
  assert.ok(codes(duplicate).includes("duplicate-page-image"));
});

test("the strict gate collects only blocking errors", () => {
  assert.deepEqual(collectAtlasErrors(inspectAtlas(validManifest(), { maxSize: 4096 })), []);
  assert.deepEqual(collectAtlasErrors(null), []);
  assert.deepEqual(collectAtlasErrors({}), []);
  assert.deepEqual(collectAtlasErrors({ atlasIssues: [{ severity: "warning", code: "x", message: "y" }] }), []);

  const broken = validManifest();
  broken.frames[0].hitbox = { x: 40, y: 4, width: 40, height: 60 };
  const blocking = collectAtlasErrors({ atlasIssues: inspectAtlas(broken).issues });
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0].code, "hitbox-outside-cell");
});
