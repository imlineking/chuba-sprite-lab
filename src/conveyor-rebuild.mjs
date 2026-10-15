import path from "node:path";
import { randomUUID } from "node:crypto";
import { runConveyor, safeAtlasName } from "./conveyor.mjs";

// Rebuild the linked studio source, never its already filtered preview. Old exports survive.
export async function rebuildWorkingResult({ source, options, intent, preset, outputDir, name = path.basename(outputDir || "edited"), targetRoot = null, deps, signal, onStage }) {
  if (!source?.paths?.length || !outputDir) throw new Error("Нет связанного результата для обновления.");
  const cleanName = safeAtlasName(name);
  const target = path.join(targetRoot ? path.resolve(targetRoot) : path.dirname(outputDir), `${cleanName}-edit-${randomUUID().slice(0, 8)}`);
  const type = intent === "images" || intent === "atlas" ? "image-set" : source.paths.length > 1 ? "frames-folder" : "image";
  const detection = { type, paths: source.paths, files: source.paths, warnings: [] };
  const buildOptions = { ...options, preserveFrameCanvas: true, exports: { sheet: true, metadata: true, frames: true, preview: false }, pixelate: options.pixelate || null };
  return runConveyor({ paths: source.paths, preset, outputDir: target, name: cleanName, intent: intent || "animation", deps: {
    ...deps, detect: async () => detection, describe: async () => source,
    clean: args => deps.clean({ ...args, options: buildOptions }),
  }, signal, onStage });
}
