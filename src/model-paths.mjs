import fs from "node:fs/promises";
import path from "node:path";
import { modelById } from "./ai-models.mjs";

export function modelSearchDirectories(model, { appRoot, aiModelDirs = [], resourcesPath = process.resourcesPath } = {}) {
  const bundled = [resourcesPath && path.join(resourcesPath, "models"), appRoot && path.join(appRoot, "models")].filter(Boolean);
  return [...new Set(model?.bundled ? [...bundled, ...aiModelDirs] : [...aiModelDirs, ...bundled])];
}

// Auxiliary models must resolve their own file; a matting fallback cannot implement
// inpainting or interpolation. The same lookup serves the pipeline and diagnostics.
export async function resolveAuxModel(id, { appRoot, aiModelDirs = [], resourcesPath = process.resourcesPath } = {}) {
  const model = modelById(id);
  if (!model) throw new Error(`Неизвестная модель: ${id}.`);
  const directories = modelSearchDirectories(model, { appRoot, aiModelDirs, resourcesPath });
  for (const directory of directories) {
    const candidate = path.join(directory, model.file);
    try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch { /* Try the next location. */ }
  }
  throw new Error(`Модель ${model.name} не найдена. Проверьте комплект программы или откройте «Модели ИИ».`);
}
