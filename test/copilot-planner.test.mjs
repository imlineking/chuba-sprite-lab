import test from "node:test";
import assert from "node:assert/strict";
import { planWithCopilot, validatePlannerResponse } from "../src/copilot-planner.mjs";
const snapshot = { source: { kind: "frames", frameCount: 3 }, options: { pixelPerfect: true } };
// Fake embedded runtime (llama.cpp child process is not started in unit tests).
function fakeRuntime({ available = true, reply = null, calls = [] } = {}) {
  return { calls, status: () => ({ available, missing: available ? [] : ["vendor/llm"], backend: null }),
    completeJson: async (request) => { calls.push(request); if (reply instanceof Error) throw reply; return { text: JSON.stringify(reply), elapsedMs: 1 }; } };
}
test("unavailable embedded model falls back transparently, without downloading anything", async () => {
  const runtime = fakeRuntime({ available: false });
  const result = await planWithCopilot({ planner: "qwen", snapshot }, runtime);
  assert.equal(result.fallback, true); assert.equal(result.planner, "rules"); assert.match(result.error, /не установлена/);
  assert.equal(runtime.calls.length, 0);
});
test("model cannot invent tools, unknown advice or unsafe pixel-art scaling", () => {
  for (const task of ["shell", "upscale"]) assert.throws(() => validatePlannerResponse({ scenarios: [{ task, why: "Do this" }], advice: [] }, snapshot));
  assert.throws(() => validatePlannerResponse({ scenarios: [{ task: "edit", why: "Edit" }], advice: ["download-arbitrary-model"] }, snapshot));
});
test("schema-validated model plan returns supported one-click scenarios without executing", async () => {
  const runtime = fakeRuntime({ reply: { scenarios: [{ task: "edit", why: "Независимые изображения: сохраняем размер" }], advice: [] } });
  const result = await planWithCopilot({ planner: "qwen", snapshot }, runtime);
  assert.equal(result.fallback, false); assert.equal(result.scenarios[0].task, "edit"); assert.equal(result.runtime, "embedded");
  assert.ok(runtime.calls[0].schema.properties.scenarios); assert.equal(runtime.calls[0].temperature, 0);
});
test("explicit selected job outranks guesses in the lightweight copilot too", async () => {
  const result = await planWithCopilot({ snapshot: { ...snapshot, ui: { goal: "combine" } } });
  assert.equal(result.scenarios[0].task, "combine");
});
test("model cannot replace the user's explicitly chosen job", () => {
  const chosen = { ...snapshot, ui: { goal: "edit" } };
  assert.throws(() => validatePlannerResponse({ scenarios: [{ task: "animation", why: "Guess" }], advice: [] }, chosen), /выбранную задачу/);
  assert.equal(validatePlannerResponse({ scenarios: [{ task: "edit", why: "Respect choice" }], advice: [] }, chosen).scenarios[0].task, "edit");
});
test("an image background task stays first even when edit would otherwise outrank it", async () => {
  const result = await planWithCopilot({ snapshot: { source: { kind: "frames", frameCount: 1 }, ui: { goal: "background" } } });
  assert.equal(result.scenarios[0].task, "background");
});
test("no supported advice yields an empty schema array, not an invalid none tool", async () => {
  const runtime = fakeRuntime({ reply: { scenarios: [{ task: "edit", why: "Правка" }], advice: [] } });
  const result = await planWithCopilot({ planner: "qwen", snapshot: { ...snapshot, ui: { goal: "edit", intent: "images" } } }, runtime);
  assert.equal(runtime.calls[0].schema.properties.advice.maxItems, 0);
  assert.equal(result.fallback, false);
});
test("removed Gemma planner degrades to the light mode without calling any model", async () => {
  const runtime = fakeRuntime(); const urls = runtime.calls;
  const result = await planWithCopilot({ planner: "gemma", snapshot }, runtime);
  assert.equal(result.planner, "rules"); assert.equal(result.fallback, true); assert.equal(result.requestedPlanner, "gemma");
  assert.ok(result.scenarios.length > 0); assert.deepEqual(urls, []);
});
test("a broken model reply degrades to the light mode", async () => {
  const result = await planWithCopilot({ planner: "qwen", snapshot }, fakeRuntime({ reply: new Error("llama-server HTTP 500") }));
  assert.equal(result.fallback, true); assert.equal(result.planner, "rules"); assert.match(result.error, /llama-server/);
});
