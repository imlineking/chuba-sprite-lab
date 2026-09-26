import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { aiModelCatalog, modelById } from "../src/ai-models.mjs";
import { resolveAuxModel } from "../src/model-paths.mjs";
import { verifiedModel } from "../scripts/prepare-portable-models.mjs";

test("portable resources include every bundled model and no optional download", async () => {
  const config = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url)));
  const resource = config.build.extraResources.find((entry) => entry.to === "models");
  const bundled = aiModelCatalog.filter((entry) => entry.bundled);
  assert.deepEqual(bundled.map((entry) => entry.id), ["u2netp", "lama", "rife", "real-esrgan", "depth-anything-v2"]);
  assert.deepEqual(resource.filter.filter((file) => file.endsWith(".onnx")).sort(), bundled.map((entry) => entry.file).sort());
  assert.ok(resource.filter.includes("bundled-models.json"));
  for (const model of bundled.filter((entry) => entry.id !== "u2netp")) assert.match(model.sha256, /^[a-f0-9]{64}$/);
});

test("auxiliary lookup works with empty user cache, packaged resources and source checkout", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-model-path-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cache = path.join(root, "cache"); const resourcesPath = path.join(root, "resources"); const appRoot = path.join(root, "app");
  const file = modelById("rife").file;
  await fs.mkdir(path.join(resourcesPath, "models"), { recursive: true });
  await fs.mkdir(path.join(appRoot, "models"), { recursive: true });
  const packaged = path.join(resourcesPath, "models", file); const source = path.join(appRoot, "models", file);
  await fs.writeFile(packaged, "packaged"); await fs.writeFile(source, "source");
  assert.equal(await resolveAuxModel("rife", { appRoot, resourcesPath, aiModelDirs: [cache] }), packaged);
  await fs.rm(packaged);
  assert.equal(await resolveAuxModel("rife", { appRoot, resourcesPath, aiModelDirs: [cache] }), source);
  // A directory with the model's name must never be accepted as a model file.
  await fs.rm(source); await fs.mkdir(source);
  await assert.rejects(resolveAuxModel("rife", { appRoot, resourcesPath }), /не найдена/);
  await assert.rejects(resolveAuxModel("lama", { appRoot, resourcesPath }), /не найдена/);
});

test("model preparation rejects a corrupt file even when its size is correct", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-model-hash-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "weights.onnx"); const bytes = Buffer.from("verified weights");
  const model = { sizeBytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  await fs.writeFile(file, bytes);
  assert.equal(await verifiedModel(file, model), true);
  bytes[0] ^= 1; await fs.writeFile(file, bytes);
  assert.equal(await verifiedModel(file, model), false);
});
