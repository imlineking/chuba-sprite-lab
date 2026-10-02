import assert from "node:assert/strict";
import { test } from "node:test";
import { planAutoPilot } from "../src/auto-pilot.mjs";
import { modelById } from "../src/ai-models.mjs";
const installed = ["toonout"];
const base = { width: 1308, height: 743, edgeMeasurement: "native", detailDensity: 0.108,
  colourCount: 2000, flatShare: 0.002, gradientShare: 0.3, softShare: 0.04, transparentShare: 0.64,
  borderOpaqueRatio: 0, borderColourCount: 0, borderSolidRatio: 0, solidBackground: false, checkerPixels: 37000,
  outlineComplexity: 22.7, thinStructure: 0.05, fringeScore: 0 };
const plan = (overrides = {}, source = {}, available = installed) => planAutoPilot({ measurements: { ...base, ...overrides }, source, installed: available, target: { intent: "images", cleanupRequested: true } });
test("complex baked checker vegetation uses ToonOut once, without a second checker deletion", () => {
  const result = plan();
  assert.equal(result.settings.modelId, "toonout");
  assert.equal(result.settings.quality, "fast");
  assert.equal(result.steps.filter(s => s.stage === "matting").length, 1);
  assert.ok(!result.steps.some(s => s.stage === "checker"));
});
test("complex comic on flat white uses ToonOut, but simple flowers still use the contour", () => {
  const comic = { width: 2035, height: 773, solidBackground: true, borderSolidRatio: 1, transparentShare: 0, borderOpaqueRatio: 1, flatShare: 0.185, detailDensity: 0.096 };
  assert.equal(plan(comic).settings.modelId, "toonout");
  const flowers = plan({ ...comic, width: 400, height: 336, detailDensity: 0.064, flatShare: 0.53 });
  assert.ok(flowers.steps.some(s => s.stage === "key" && s.tool === "key"));
  assert.ok(!flowers.steps.some(s => s.stage === "checker"));
});
test("prepared masks remain unchanged; all other model tasks use ToonOut or report it missing", () => {
  const prepared = plan({}, { maskPrepared: true });
  assert.equal(prepared.settings.modelId, "toonout");
  assert.ok(!prepared.steps.some(s => s.stage === "checker" || s.stage === "matting"));
  const missing=plan({}, {}, []);
  assert.equal(missing.steps.find(step=>step.stage==="matting").status,"blocked");
  assert.equal(plan({edgeMeasurement:"thumbnail"}).steps.find(step=>step.stage==="matting").tool,"toonout");
  assert.equal(plan({checkerPixels:0,detailDensity:.006,transparentShare:0}).steps.find(step=>step.stage==="matting").tool,"toonout");
});
test("ToonOut has a pinned local export with calibrated probabilities and whole-image inference", () => {
  const model = modelById("toonout");
  assert.equal(model.wholeImage, true); assert.equal(model.probabilityOutput, true);
  assert.equal(model.flattenBackground, "#ffffff"); assert.match(model.sha256, /^[a-f0-9]{64}$/);
  assert.equal(model.localExport, true); assert.equal(model.bundled, true);
});
