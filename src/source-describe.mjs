import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inspectSource } from "./processor.mjs";
import { sliceSpriteSheet } from "./sheet-slicer.mjs";
import { finishSheetImport, makeTempWorkspace } from "./temp-workspace.mjs";
import { matchSheetFrameNames, readSheetFrameRects } from "./sheet-metadata.mjs";

// Describing a source is shared by the desktop window and the command line, so both
// accept exactly the same inputs and produce exactly the same descriptor. The
// application root is passed in because the processor resolves FFmpeg and the model
// relative to it.

export async function describePaths(appRoot, kind, paths) {
  if (!paths?.length) return null;
  const source = await inspectSource({ kind, paths, appRoot });
  return {
    ...source,
    previewUrl: source.previewPath ? pathToFileURL(source.previewPath).href : null,
    sampleUrls: (source.samplePaths || []).map((item) => pathToFileURL(item).href),
  };
}

export async function describeVideoBatch(appRoot, paths) {
  const first = await describePaths(appRoot, "video", [paths[0]]);
  return {
    ...first,
    kind: "video-batch",
    paths,
    batchCount: paths.length,
    title: `${paths.length} видео`,
    detail: `${paths.length} роликов · настройки по ${path.basename(paths[0])}`,
  };
}

export async function describeSpriteSheet(appRoot, sheetPath, options = {}) {
  const outputDir = await makeTempWorkspace("chuba-sprite-sheet-");
  const sliced = await sliceSpriteSheet(sheetPath, outputDir, options);
  const source = await describePaths(appRoot, "frames", sliced.framePaths);
  // Later builds read the extracted frames on demand, so the workspace only becomes
  // disposable now that the source descriptor points at real files.
  await finishSheetImport(outputDir);
  const siblingJson = path.join(path.dirname(sheetPath), `${path.parse(sheetPath).name}.json`);
  const oldMetadata = await fs.readFile(siblingJson, "utf8").then(JSON.parse).catch(() => null);
  const sheetFrameNames = matchSheetFrameNames(sliced.cells, readSheetFrameRects(oldMetadata));
  return {
    ...source,
    kind: "sheet",
    sheetPath,
    sheetMode: sliced.mode,
    sheetCells: sliced.cells,
    sheetFrameNames,
    sheetWidth: sliced.width,
    sheetHeight: sliced.height,
    sheetUrl: pathToFileURL(sheetPath).href,
    sheetBackground: sliced.background,
    title: path.basename(sheetPath),
    detail: `${sliced.width}×${sliced.height} · найдено объектов: ${sliced.framePaths.length}`,
    estimatedFrames: sliced.framePaths.length,
    recommendations: { ...source.recommendations, anchor: "center" },
  };
}
