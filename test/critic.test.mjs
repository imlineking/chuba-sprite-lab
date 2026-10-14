import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { buildAtlas } from "../src/pipeline/build.mjs";
import { reviewAtlas, validateCriticResponse, applyFix, loadSkills } from "../src/critic/critic.mjs";
import { EmbeddedRuntime, runtimePaths } from "../src/critic/llm-runtime.mjs";
import { makeGoldenCases } from "./critic-golden.mjs";

import { existsSync } from "node:fs";
const skillsDir = path.resolve(import.meta.dirname, "../models/qwen3-vl-4b/skills");
// The skill pack ships with the model files (models/ is not in git): skip, do not fail, without it.
const noSkills = existsSync(path.join(skillsDir, "manifest.json")) ? false : "models/qwen3-vl-4b/skills is not installed";
async function build(config) {
  try { return { built: await buildAtlas(config, { write: false }), error: null }; } catch (error) { return { built: null, error: error.message }; }
}

test("golden cases: every broken input is caught, every clean input is accepted (light mode)", async () => {
  const { dir, cases } = await makeGoldenCases();
  try {
    const rows = [];
    for (const item of cases) {
      const { built, error } = await build(item.config);
      const review = await reviewAtlas(built || { atlas: null, pages: [] }, { buildError: error, useModel: false });
      rows.push({ id: item.id, verdict: review.verdict, codes: review.issues.map((i) => i.code) });
      if (item.expectBad) assert.notEqual(review.verdict, "accepted", `${item.id} должен быть пойман: ${JSON.stringify(review.issues)}`);
      else assert.equal(review.verdict, "accepted", `${item.id} ложная тревога: ${JSON.stringify(review.issues)}`);
    }
    const codes = Object.fromEntries(rows.map((r) => [r.id, r.codes]));
    assert.ok(codes["broken-leftover-bg"].includes("leftover_background"));
    assert.ok(codes["broken-wrong-grid"].includes("wrong_grid"));
    assert.ok(codes["broken-pivot-jitter"].includes("pivot_jitter"));
    assert.ok(codes["broken-missing-frame"].includes("missing_frame"));
    assert.ok(codes["broken-overflow"].includes("atlas_overflow"));
    assert.ok(codes["broken-frame-too-big"].includes("atlas_overflow"));
    assert.ok(codes["broken-order"].includes("frame_order"));
    assert.ok(codes["broken-empty-frame"].includes("empty_frame"));
    assert.ok(codes["broken-no-padding"].includes("padding_small"));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("suggested fixes are concrete pipeline parameters and repair the build", async () => {
  const { dir, cases } = await makeGoldenCases();
  try {
    for (const id of ["broken-leftover-bg", "broken-wrong-grid", "broken-overflow"]) {
      const item = cases.find((c) => c.id === id);
      const first = await reviewAtlas((await build(item.config)).built, { useModel: false });
      const fix = first.issues.find((i) => i.fix)?.fix;
      assert.ok(fix, `${id}: нет fix`);
      const second = await reviewAtlas((await build(applyFix(item.config, fix))).built, { useModel: false });
      assert.equal(second.verdict, "accepted", `${id} после fix: ${JSON.stringify(second.issues)}`);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

function fakeRuntime(replies) {
  const calls = [];
  return { calls, stats: { coldStartMs: 5 }, completeJson: async (request) => { calls.push(request); const next = replies.shift(); if (next instanceof Error) throw next; return { text: typeof next === "string" ? next : JSON.stringify(next), elapsedMs: 3 }; } };
}

test("the model cannot override a hard algorithmic failure and its near-duplicate/OCR calls are ignored", { skip: noSkills }, async () => {
  const { dir, cases } = await makeGoldenCases();
  try {
    const bad = cases.find((c) => c.id === "broken-missing-frame");
    const runtime = fakeRuntime([{ verdict: "accepted", score: 99, issues: [] }]);
    const review = await reviewAtlas((await build(bad.config)).built, { runtime, skillsDir });
    assert.equal(review.mode, "qwen"); assert.notEqual(review.verdict, "accepted");
    const clean = cases.find((c) => c.id === "clean-walk");
    const runtime2 = fakeRuntime([{ verdict: "rejected", score: 10, issues: [{ code: "near_duplicate", severity: "error", target: "walk", reason: "Дубли", fix: null }, { code: "text_ocr", severity: "error", target: "walk", reason: "Текст", fix: null }] }]);
    const review2 = await reviewAtlas((await build(clean.config)).built, { runtime: runtime2, skillsDir });
    assert.equal(review2.verdict, "accepted"); assert.equal(review2.issues.length, 0);
    const runtime3 = fakeRuntime([{ verdict: "needs_fix", score: 60, issues: [{ code: "halo", severity: "error", target: "walk", reason: "Светлый ореол по краю", fix: { background: { mode: "auto", tolerance: 32 } } }] }]);
    const review3 = await reviewAtlas((await build(clean.config)).built, { runtime: runtime3, skillsDir });
    assert.equal(review3.verdict, "needs_fix"); assert.equal(review3.issues[0].severity, "warning"); assert.equal(review3.issues[0].source, "qwen");
    assert.ok(runtime3.calls[0].images.length === 1 && runtime3.calls[0].schema.properties.verdict);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("bad JSON is retried once, then the light-mode verdict is used and labeled", { skip: noSkills }, async () => {
  const { dir, cases } = await makeGoldenCases();
  try {
    const clean = cases.find((c) => c.id === "clean-walk");
    const built = (await build(clean.config)).built;
    const retried = fakeRuntime(["{not json", { verdict: "accepted", score: 90, issues: [] }]);
    const ok = await reviewAtlas(built, { runtime: retried, skillsDir });
    assert.equal(ok.mode, "qwen"); assert.equal(ok.attempts, 2); assert.match(retried.calls[1].user, /некорректен/);
    const failing = fakeRuntime([new Error("llama-server HTTP 500"), "{}"]);
    const fallback = await reviewAtlas(built, { runtime: failing, skillsDir });
    assert.equal(fallback.mode, "light"); assert.match(fallback.fallbackReason, /только алгоритмами/); assert.equal(fallback.verdict, "accepted");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("critic response validation and the versioned skill pack", { skip: noSkills }, async () => {
  const skills = await loadSkills(skillsDir);
  assert.equal(skills.version, "critic-v1");
  assert.deepEqual(skills.calibration.distrustCodes, ["near_duplicate", "text_ocr"]);
  assert.ok(skills.examples.length >= 3 && skills.system.includes("JSON"));
  assert.throws(() => validateCriticResponse({ verdict: "ok", score: 1, issues: [] }));
  assert.throws(() => validateCriticResponse({ verdict: "accepted", score: 101, issues: [] }));
  assert.throws(() => validateCriticResponse({ verdict: "accepted", score: 50, issues: [{ code: "shell", severity: "error", reason: "x", fix: null }] }, { allowedCodes: skills.rubric.codes }));
});

test("embedded runtime: missing files are reported, GPU backend first then CPU fallback, health check, idle stop", async () => {
  const missing = new EmbeddedRuntime({ paths: { servers: [], weights: null, mmproj: null, skills: null } });
  assert.equal(missing.status().available, false);
  await assert.rejects(() => missing.ensure(), /недоступна/);
  const spawned = [];
  const fakeChild = (fail) => { const listeners = {}; const child = { stderr: { on() {} }, once: (e, cb) => { listeners[e] = cb; if (fail && e === "exit") setTimeout(() => cb(1), 5); }, kill: () => { child.killed = true; listeners.exit?.(0); } }; return child; };
  const runtime = new EmbeddedRuntime({ idleMs: 50, startTimeoutMs: 2000,
    paths: { servers: [{ backend: "vulkan", file: "/x/vulkan/llama-server" }, { backend: "cpu", file: "/x/cpu/llama-server" }], weights: "/w.gguf", mmproj: "/m.gguf", skills: null },
    spawnImpl: (file, args) => { spawned.push({ file, args }); return fakeChild(file.includes("vulkan")); },
    fetchImpl: async (url) => { if (url.endsWith("/health")) { if (spawned.length < 2) throw new Error("not up"); return { ok: true }; } return { ok: true, json: async () => ({ choices: [{ message: { content: "{\"a\":1}" } }] }) }; } });
  const reply = await runtime.completeJson({ system: "s", user: "u", images: [Buffer.from([0x89, 0x50])], schema: { type: "object" } });
  assert.equal(reply.text, "{\"a\":1}"); assert.equal(runtime.backend, "cpu");
  assert.ok(spawned[0].args.includes("--mmproj") && spawned[0].args.includes("127.0.0.1"));
  assert.equal(spawned[1].args[spawned[1].args.indexOf("-ngl") + 1], "0");
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(runtime.status().running, false);
  assert.ok(runtimePaths("/nonexistent").servers.length === 0);
});
