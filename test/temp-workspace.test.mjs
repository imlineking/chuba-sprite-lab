import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { discardTempWorkspace, finishQuickPreview, finishSheetImport, makeTempWorkspace } from "../src/temp-workspace.mjs";

async function exists(candidate) {
  try { await fs.access(candidate); return true; } catch { return false; }
}

test("sheet imports are retired into a bounded pool instead of filling %TEMP%", async () => {
  const first = await makeTempWorkspace("chuba-sprite-sheet-test-");
  const second = await makeTempWorkspace("chuba-sprite-sheet-test-");
  const third = await makeTempWorkspace("chuba-sprite-sheet-test-");
  const fourth = await makeTempWorkspace("chuba-sprite-sheet-test-");

  await finishSheetImport(first);
  await finishSheetImport(second);
  assert.ok(await exists(first), "the pool must keep the newest workspaces");
  assert.ok(await exists(second));

  await finishSheetImport(third);
  assert.equal(await exists(first), false, "the oldest sheet workspace must be removed");
  assert.ok(await exists(third));

  await finishSheetImport(fourth);
  assert.equal(await exists(second), false);
  assert.ok(await exists(third));
  assert.ok(await exists(fourth), "the active sheet workspace is always kept");

  await discardTempWorkspace(third);
  await discardTempWorkspace(fourth);
  assert.equal(await exists(fourth), false);
});

test("quick previews never evict sheet import workspaces", async () => {
  const sheet = await makeTempWorkspace("chuba-sprite-sheet-test-");
  await finishSheetImport(sheet);
  for (let index = 0; index < 8; index += 1) {
    await finishQuickPreview(await makeTempWorkspace("chuba-sprite-live-test-"));
  }
  assert.ok(await exists(sheet), "a burst of previews must not evict the sheet frames");

  const previews = await fs.readdir(path.resolve(process.env.TEMP || process.env.TMP || "/tmp"));
  const live = previews.filter((name) => name.startsWith("chuba-sprite-live-test-")).length;
  assert.ok(live <= 6, `preview pool must stay bounded, saw ${live}`);

  await discardTempWorkspace(sheet);
});
