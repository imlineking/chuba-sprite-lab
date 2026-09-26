import test from "node:test";
import assert from "node:assert/strict";
import { planWithCopilot, validatePlannerResponse } from "../src/copilot-planner.mjs";
const snapshot = { source: { kind: "frames", frameCount: 3 }, options: { pixelPerfect: true } };
test("unavailable local model falls back transparently, without downloading anything", async () => {
  const urls = [];
  const result = await planWithCopilot({ planner: "qwen", snapshot }, async url => { urls.push(url); throw new Error("Ollama is off"); });
  assert.equal(result.fallback, true); assert.equal(result.planner, "rules"); assert.match(result.error, /не установлен/);
  assert.deepEqual(urls, ["http://127.0.0.1:11434/api/tags"]);
});
test("model cannot invent tools, unknown advice or unsafe pixel-art scaling", () => {
  for (const task of ["shell", "upscale"]) assert.throws(() => validatePlannerResponse({ scenarios: [{ task, why: "Do this" }], advice: [] }, snapshot));
  assert.throws(() => validatePlannerResponse({ scenarios: [{ task: "edit", why: "Edit" }], advice: ["download-arbitrary-model"] }, snapshot));
});
test("schema-validated model plan returns supported one-click scenarios without executing", async () => {
  const requests = [];
  const result = await planWithCopilot({ planner: "qwen", snapshot }, async (url, request) => {
    requests.push({ url, request });
    return { ok: true, json: async () => url.endsWith("tags") ? { models: [{ name: "qwen3-vl:4b-instruct", size: 3300000000 }] } : { response: JSON.stringify({ scenarios: [{ task: "edit", why: "Независимые изображения: сохраните отдельные PNG." }], advice: [] }), eval_count: 30 } };
  });
  assert.equal(result.fallback, false); assert.equal(result.scenarios[0].task, "edit");
  const payload = JSON.parse(requests[1].request.body);
  assert.equal(payload.keep_alive, 0); assert.equal(payload.stream, false); assert.ok(payload.format.properties.scenarios);
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
