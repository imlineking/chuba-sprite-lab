import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { buildAtlas } from "../src/pipeline/build.mjs";
import { reviewAtlas, applyFix } from "../src/critic/critic.mjs";
import { makeGoldenCases } from "./critic-golden.mjs";

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
