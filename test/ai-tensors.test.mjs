import test from "node:test";
import assert from "node:assert/strict";
import { segmentationContract, segmentationInput, segmentationProbabilities } from "../src/ai-tensors.mjs";
import { modelById } from "../src/ai-models.mjs";

test("IS-Net exports use their own RGB centring rather than ImageNet standard deviation", () => {
  const general = segmentationInput(Buffer.from([255, 128, 0]), modelById("isnet-general"));
  assert.ok(Math.abs(general[0] - .5) < 1e-6);
  assert.ok(Math.abs(general[1] - (128/255-.5)) < 1e-6);
  assert.equal(general[2], -.5);
  const anime = segmentationInput(Buffer.from([255, 128, 0]), modelById("isnet-anime"));
  assert.ok(Math.abs(anime[0] - (1-.485)) < 1e-6);
  assert.ok(Math.abs(anime[1] - (128/255-.456)) < 1e-6);
  assert.ok(Math.abs(anime[2] + .406) < 1e-6);
});
test("rembg inputs use image maximum while the verified ToonOut export retains fixed /255", () => {
  const input = Buffer.from([64, 128, 32, 128, 32, 0]);
  const rembg = segmentationInput(input, modelById("birefnet-tiny"));
  const toon = segmentationInput(input, modelById("toonout"));
  assert.ok(Math.abs(rembg[0] - (.5-.485)/.229) < 1e-6);
  assert.ok(Math.abs(rembg[1] - (1-.485)/.229) < 1e-6, "RGB must become channel-first");
  assert.ok(Math.abs(toon[0] - (64/255-.485)/.229) < 1e-6);
  assert.ok(segmentationInput(Buffer.alloc(6), modelById("isnet-general")).every(Number.isFinite));
});
test("BiRefNet logits use sigmoid before rescaling so a positive subject survives extreme logits", () => {
  const bytes = segmentationProbabilities([Float32Array.from([-100, 2, 100])], modelById("birefnet-tiny"));
  assert.deepEqual([...bytes], [0, 225, 255]);
  for(const id of ["birefnet-general","birefnet-hr-matting","birefnet-portrait"]) assert.equal(segmentationContract(modelById(id)).outputLogits,true);
});
test("ToonOut calibrated probabilities are neither stretched nor passed through sigmoid twice", () => {
  assert.deepEqual([...segmentationProbabilities([Float32Array.from([.2, .7, .7])],modelById("toonout"))],[51,178,178]);
  assert.deepEqual([...segmentationProbabilities([Float32Array.from([.7,.7])],modelById("toonout"))],[178,178]);
  assert.equal(segmentationContract(modelById("toonout")).outputLogits,false);
});
test("mirrored inference combines probabilities; invalid output maps are rejected", () => {
  const mask = segmentationProbabilities([Float32Array.from([-100,2,100]),Float32Array.from([-100,2,100])],modelById("birefnet-tiny"));
  assert.equal(mask[1],225);
  assert.throws(()=>segmentationProbabilities([Float32Array.from([NaN])],modelById("birefnet-tiny")),/нечисловую/);
  assert.throws(()=>segmentationProbabilities([[0,1],[1]],modelById("toonout")),/разного размера/);
});
