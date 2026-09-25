import assert from "node:assert/strict";
import test from "node:test";
import { planSuggestions, planTaskScenarios, stepOperations } from "../src/copilot-rules.mjs";

test("a detected sprite sheet offers grid layout first, with other intentions still available", () => {
  const scenarios = planTaskScenarios({ source: { kind: "sheet", frameCount: 6 }, aiPlan: { measurements: { transparentShare: 0.7, borderOpaqueRatio: 0.1 } } });
  assert.equal(scenarios[0].task, "layout");
  assert.equal(scenarios[0].recommended, true);
  assert.ok(scenarios.some((item) => item.task === "remove"));
  assert.equal(scenarios.some((item) => item.task === "background"), false);
});

test("a video with a selected removal leads with that job and keeps animation available", () => {
  const scenarios = planTaskScenarios({ source: { kind: "video", estimatedFrames: 30 }, ui: { maskEdits: 1 } });
  assert.equal(scenarios[0].task, "remove");
  assert.ok(scenarios.some((item) => item.task === "animation"));
});

test("mixed frame sizes surface alignment as a task", () => {
  const scenarios = planTaskScenarios({ source: { kind: "frames", frameCount: 8, mixedSizes: true } });
  assert.equal(scenarios[0].task, "match");
  assert.ok(scenarios.some((item) => item.task === "edit"));
});

test("a single image suggests more frames or objects, while a sheet offers extraction", () => {
  const single = planTaskScenarios({ source: { kind: "frames", frameCount: 1 } });
  assert.ok(single.some((item) => item.task === "animation"));
  assert.ok(single.some((item) => item.task === "combine"));
  const sheet = planTaskScenarios({ source: { kind: "sheet", frameCount: 7 } });
  assert.ok(sheet.some((item) => item.task === "extract"));
  assert.ok(sheet.some((item) => item.task === "objectEdit"));
});

function ids(snapshot) {
  return planSuggestions(snapshot).map((suggestion) => suggestion.id);
}

function find(snapshot, id) {
  return planSuggestions(snapshot).find((suggestion) => suggestion.id === id);
}

const settled = { resultDirty: false, hasOutputFolder: true };

test("a project without a result is only asked to build one", () => {
  const list = planSuggestions({ source: { kind: "frames", estimatedFrames: 3 }, options: {}, ui: settled });
  assert.deepEqual(list.map((suggestion) => suggestion.id), ["build-preview"]);
  assert.deepEqual(list[0].steps, [{ op: "rebuild" }]);
});

test("a stale preview is offered before anything else", () => {
  const list = planSuggestions({
    source: { kind: "frames" },
    built: { warnings: [], frameIssues: [], atlasIssues: [] },
    options: {},
    ui: { resultDirty: true, hasOutputFolder: true },
  });
  assert.equal(list[0].id, "rebuild-stale");
  assert.equal(list[0].severity, "info");
});

test("an atlas over the limit explains the numbers and offers scaling", () => {
  const suggestion = find({
    source: { kind: "frames" },
    built: { atlas: { exceeds: true, applied: "warn", naturalWidth: 6000, naturalHeight: 2000, limit: 4096 }, warnings: [], frameIssues: [], atlasIssues: [] },
    options: {},
    ui: settled,
  }, "atlas-over-limit");
  assert.ok(suggestion);
  assert.equal(suggestion.severity, "warn");
  assert.match(suggestion.why, /6000×2000/);
  assert.match(suggestion.why, /4096/);
  assert.deepEqual(suggestion.steps, [{ op: "option", control: "atlasOverflow", value: "scale" }, { op: "rebuild" }]);
});

test("opaque images switch the background key mode", () => {
  const suggestion = find({
    source: { kind: "frames", opaqueImages: 4, suggestedKeyMode: "white" },
    built: { warnings: [], frameIssues: [], atlasIssues: [] },
    options: { keyMode: "alpha" },
    ui: settled,
  }, "opaque-images");
  assert.ok(suggestion);
  assert.deepEqual(suggestion.steps, [{ op: "keyMode", value: "white" }, { op: "rebuild" }]);
  // Already removing the background: nothing to suggest.
  assert.equal(find({
    source: { kind: "frames", opaqueImages: 4 },
    built: { warnings: [], frameIssues: [], atlasIssues: [] },
    options: { keyMode: "white" },
    ui: settled,
  }, "opaque-images"), undefined);
});

test("a long high-rate video is offered a lower frame rate", () => {
  const suggestion = find({
    source: { kind: "video", estimatedFrames: 900 },
    built: { warnings: [], frameIssues: [], atlasIssues: [] },
    options: { fps: 60 },
    ui: settled,
  }, "video-fps");
  assert.ok(suggestion);
  assert.deepEqual(suggestion.steps, [{ op: "option", control: "fps", value: 12 }, { op: "rebuild" }]);
  assert.equal(find({
    source: { kind: "video", estimatedFrames: 120 },
    built: { warnings: [], frameIssues: [], atlasIssues: [] },
    options: { fps: 60 },
    ui: settled,
  }, "video-fps"), undefined, "a short clip is fine at 60 fps");
});

test("silhouette spread and a loop seam each offer their own fix", () => {
  const spread = find({
    source: { kind: "frames" },
    built: { warnings: [], frameIssues: [{ frameIndex: 2, message: "Кадр 3: ширина силуэта отличается более чем на 20%." }], atlasIssues: [] },
    options: {},
    ui: settled,
  }, "size-spread");
  assert.deepEqual(spread.steps, [{ op: "openConsistency" }]);

  const seam = find({
    source: { kind: "frames" },
    built: { warnings: ["Цикл: заметный скачок силуэта между кадрами 8 и 1."], frameIssues: [], atlasIssues: [] },
    options: {},
    ui: settled,
  }, "loop-seam");
  assert.equal(seam.severity, "warn");
  assert.deepEqual(seam.steps, [{ op: "loopMode", value: "pingpong" }, { op: "rebuild" }]);
});

test("atlas errors quote the first problem and open the export tab", () => {
  const suggestion = find({
    source: { kind: "frames" },
    built: { warnings: [], frameIssues: [], atlasIssues: [{ severity: "error", code: "hitbox-outside-cell", message: "Кадр run_0003: хитбокс выходит за пределы ячейки." }] },
    options: {},
    ui: settled,
  }, "atlas-issues");
  assert.ok(suggestion);
  assert.match(suggestion.why, /хитбокс выходит за пределы ячейки/);
  assert.deepEqual(suggestion.steps, [{ op: "tab", value: "export" }]);
});

test("a stretched sheet and a missing destination are both noticed", () => {
  const fit = find({
    source: { kind: "sheet" },
    built: { warnings: [], frameIssues: [], atlasIssues: [] },
    options: { fitEachFrame: true },
    ui: settled,
  }, "sheet-fit-each");
  assert.deepEqual(fit.steps, [{ op: "check", control: "sheetFitEach", value: false }, { op: "rebuild" }]);

  const destination = find({
    source: { kind: "frames" },
    built: { warnings: [], frameIssues: [], atlasIssues: [] },
    options: {},
    ui: { resultDirty: false, hasOutputFolder: false },
  }, "no-destination");
  assert.deepEqual(destination.steps, [{ op: "tab", value: "export" }, { op: "chooseOutput" }]);
});

test("every step stays inside the known vocabulary", () => {
  const crowded = planSuggestions({
    source: { kind: "frames", opaqueImages: 3, suggestedKeyMode: "white" },
    built: {
      warnings: ["Цикл: заметный скачок силуэта между кадрами 8 и 1.", "Кадр 1: умная область не найдена уверенно."],
      frameIssues: [{ frameIndex: 1, message: "Кадр 1: высота силуэта отличается более чем на 20%." }],
      atlasIssues: [{ severity: "error", code: "frame-outside-page", message: "Кадр run_0001 выходит за пределы страницы 1." }],
      atlas: { exceeds: true, applied: "warn", naturalWidth: 9000, naturalHeight: 9000, limit: 2048, width: 9000, height: 9000 },
    },
    options: { keyMode: "alpha", packing: "grid", fps: 30, fitEachFrame: false },
    ui: { resultDirty: true, hasOutputFolder: false },
  });
  assert.ok(crowded.length >= 6, `expected several suggestions, got ${crowded.length}`);
  for (const suggestion of crowded) {
    assert.ok(suggestion.title && suggestion.why && suggestion.effect, `incomplete suggestion ${suggestion.id}`);
    for (const step of suggestion.steps) {
      assert.ok(stepOperations.includes(step.op), `unknown step ${step.op} in ${suggestion.id}`);
    }
  }
  // Warnings must be shown before information.
  assert.equal(crowded[0].severity, "warn");
  assert.equal(crowded.at(-1).severity, "info");
});
