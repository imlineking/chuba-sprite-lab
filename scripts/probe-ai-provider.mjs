// Reports which accelerator this machine offers for the local segmentation model and how fast
// each one runs. Use it when the automatic choice looks wrong or before trusting a timing:
//
//   node scripts/probe-ai-provider.mjs [runs]
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-node";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelPath = path.join(appRoot, "models", "u2netp.onnx");
const input = new Float32Array(3 * 320 * 320).fill(0.5);

async function measure(provider, runs) {
  const started = performance.now();
  const session = await ort.InferenceSession.create(modelPath, { executionProviders: [provider], graphOptimizationLevel: "all" });
  const createMs = Math.round(performance.now() - started);
  const tensor = new ort.Tensor("float32", input, [1, 3, 320, 320]);
  const inputName = session.inputNames[0];
  const runMs = [];
  for (let index = 0; index < runs; index += 1) {
    const mark = performance.now();
    await session.run({ [inputName]: tensor });
    runMs.push(Math.round(performance.now() - mark));
  }
  return { createMs, runMs, average: Math.round(runMs.reduce((sum, value) => sum + value, 0) / runMs.length) };
}

const runs = Number(process.argv[2]) || 4;
console.log(`Модель: ${modelPath}`);
for (const provider of ["cpu", "dml"]) {
  try {
    const result = await measure(provider, runs);
    console.log(`${provider.padEnd(4)} старт ${String(result.createMs).padStart(5)} мс · кадр ${String(result.average).padStart(4)} мс · замеры ${result.runMs.join(", ")}`);
  } catch (error) {
    console.log(`${provider.padEnd(4)} недоступен: ${error?.message || error}`);
  }
}
