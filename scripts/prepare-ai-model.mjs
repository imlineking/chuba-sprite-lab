import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const aiModelFileName = "u2netp.onnx";
export const aiModelUrl = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx";
export const aiModelMd5 = "8e83ca70e441ab06c318d82300c84806";

async function digest(filePath) {
  return crypto.createHash("md5").update(await fs.readFile(filePath)).digest("hex");
}

export async function prepareAIModel(appRoot) {
  const modelDir = path.join(appRoot, "models");
  const modelPath = path.join(modelDir, aiModelFileName);
  await fs.mkdir(modelDir, { recursive: true });
  try {
    if (await digest(modelPath) === aiModelMd5) return modelPath;
  } catch {
    // Download a fresh verified copy below.
  }

  const response = await fetch(aiModelUrl, { redirect: "follow" });
  if (!response.ok) throw new Error(`Не удалось загрузить ИИ-модель: HTTP ${response.status}.`);
  const temporaryPath = `${modelPath}.download`;
  await fs.writeFile(temporaryPath, Buffer.from(await response.arrayBuffer()));
  if (await digest(temporaryPath) !== aiModelMd5) {
    await fs.rm(temporaryPath, { force: true });
    throw new Error("Контрольная сумма ИИ-модели не совпала.");
  }
  await fs.rename(temporaryPath, modelPath);
  return modelPath;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const modelPath = await prepareAIModel(appRoot);
  console.log(`AI model prepared:\n${modelPath}`);
}
