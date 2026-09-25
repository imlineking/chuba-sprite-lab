import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fingerprint, watchSources } from "../src/watch.mjs";

test("the fingerprint changes with size and with removal", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-watch-"));
  const file = path.join(temp, "frame.png");
  const missing = path.join(temp, "absent.png");
  await fs.writeFile(file, "one", "utf8");

  const initial = await fingerprint([file, missing]);
  assert.ok(initial.includes("|missing"));
  assert.equal(await fingerprint([file, missing]), initial, "an unchanged set must hash the same");

  await fs.writeFile(file, "two-longer", "utf8");
  assert.notEqual(await fingerprint([file, missing]), initial);
});

test("watching reports one call per change and stops on abort", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-watch-loop-"));
  const file = path.join(temp, "frame.png");
  await fs.writeFile(file, "one", "utf8");

  const controller = new AbortController();
  let calls = 0;
  const loop = watchSources([file], { intervalMs: 20, signal: controller.signal, onChange: async () => { calls += 1; } });
  const untilCalls = async (expected) => {
    const deadline = Date.now() + 3000;
    while (calls < expected && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(calls, expected);
  };
  try {
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.equal(calls, 0, "an unchanged file must not trigger a rebuild");
    await fs.writeFile(file, "two-longer", "utf8");
    await untilCalls(1);
    await fs.writeFile(file, "three-longer-still", "utf8");
    await untilCalls(2);
  } finally {
    controller.abort();
    await loop;
  }
  assert.equal(calls, 2, "aborting must stop the loop");
});
