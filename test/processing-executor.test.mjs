import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { ProcessingExecutor } from "../src/processing-executor.mjs";

test("isolated executor handles real processing and reports errors without losing next job", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-executor-"));
  const executor = new ProcessingExecutor(); t.after(async () => { executor.close(); await fs.rm(root, { recursive: true, force: true }); });
  const inputPath = path.join(root, "sprite.png");
  await sharp({ create: { width: 9, height: 11, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toFile(inputPath);
  await assert.rejects(executor.run("bad-operation", {}), /неизвестна/);
  const request = { inputPath, appRoot: path.resolve("."), options: { keyMode: "alpha" } };
  const [a, b] = await Promise.all([executor.run("processFramePreview", request), executor.run("processFramePreview", request)]);
  assert.equal((await sharp(a.afterPath).metadata()).width, 9);
  assert.equal((await sharp(b.afterPath).metadata()).height, 11);
  assert.ok(executor.child.pid !== process.pid);
});

test("cancel kills a native-style blocking job, keeps parent responsive and restarts queue", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-executor-cancel-"));
  const workerPath = path.join(root, "worker.mjs");
  await fs.writeFile(workerPath, 'process.on("message", m => { if(m.operation === "block") { const end=Date.now()+5000; while(Date.now()<end){} } process.send({type:"result", id:m.id, result:m.operation}); });');
  const executor = new ProcessingExecutor({ workerPath }); t.after(async () => { executor.close(); await fs.rm(root, { recursive: true, force: true }); });
  const controller = new AbortController(); const start = Date.now();
  const first = executor.run("block", {}, { signal: controller.signal });
  const second = executor.run("next", {});
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(first, /отменена/);
  assert.equal(await second, "next");
  assert.ok(Date.now() - start < 2500);
});
