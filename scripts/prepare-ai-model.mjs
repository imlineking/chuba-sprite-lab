import path from "node:path";
import { fileURLToPath } from "node:url";
import { modelById } from "../src/ai-models.mjs";
import { verifiedModel } from "./prepare-portable-models.mjs";

// ToonOut is exported from the pinned official checkpoint by the developer.
// Preparation never replaces it with another segmentation model or an unverified download.
export async function prepareAIModel(appRoot) {
  const model = modelById("toonout"), modelPath = path.join(appRoot, "models", model.file);
  if (!await verifiedModel(modelPath, model)) throw new Error("Не найден проверенный ToonOut ONNX-export. См. docs/TOONOUT.md.");
  return modelPath;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await prepareAIModel(path.resolve(import.meta.dirname, "..")));
}
