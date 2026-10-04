import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inspectSource } from "./processor.mjs";
import { sliceSpriteSheet } from "./sheet-slicer.mjs";
import { finishSheetImport, makeTempWorkspace } from "./temp-workspace.mjs";
import { importSheetManifest, matchSheetFrameNames, readSheetFrameRects } from "./sheet-metadata.mjs";
import sharp from 'sharp';
import { hasAnimatedPNG, readAnimatedImage } from './animated-images.mjs';

// Describing a source is shared by the desktop window and the command line, so both
// accept exactly the same inputs and produce exactly the same descriptor. The
// application root is passed in because the processor resolves FFmpeg and the model
// relative to it.

export async function describePaths(appRoot, kind, paths) {
  if (!paths?.length) return null;
  if(paths.length===1&&(path.extname(paths[0]).toLowerCase()==='.gif'||await hasAnimatedPNG(paths[0]))){
    const image=await readAnimatedImage(paths[0]),directory=await makeTempWorkspace('chuba-animated-image-'),framePaths=[];
    for(const [index,frame]of image.frames.entries()){const file=path.join(directory,String(index).padStart(4,'0')+'.png');await sharp(frame.pixels,{raw:{width:image.width,height:image.height,channels:4}}).png().toFile(file);framePaths.push(file);}
    await finishSheetImport(directory);const source=await inspectSource({kind:'frames',paths:framePaths,appRoot});
    return{...source,previewUrl:source.previewPath?pathToFileURL(source.previewPath).href:null,sampleUrls:(source.samplePaths||[]).map(file=>pathToFileURL(file).href),title:path.basename(paths[0]),animatedImport:true,originalAnimation:paths[0],maskPrepared:true,frameMetadata:Object.fromEntries(image.frames.map((frame,i)=>[i,{durationMs:frame.durationMs}])),importedAnimations:[{name:path.parse(paths[0]).name,from:0,to:image.frames.length-1}],importedMetadata:{animationLoop:image.loop},detail:`${image.frames.length} кадров · исходные длительности · RGBA`,recommendations:{...source.recommendations,keyMode:'alpha'}};
  }
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
  const stem = path.parse(sheetPath).name;
  const candidates = options.metadataPath ? [options.metadataPath] : [path.join(path.dirname(sheetPath), stem + ".json"), path.join(path.dirname(sheetPath), stem.replace(/\.sheet(?:-\d+)?$/, "") + ".json"), path.join(path.dirname(sheetPath), stem.replace(/\.sheet(?:-\d+)?$/, "") + ".texturepacker.json")];
  const metadataPath = options.mode === "manual" || options.mode === "grid" ? null : (await Promise.all(candidates.map(p => fs.stat(p).then(s => s.isFile() ? p : null, () => null)))).find(Boolean);
  if (metadataPath) {
    const imported = await importSheetManifest(metadataPath, outputDir, path.basename(sheetPath));
    const source = await describePaths(appRoot, "frames", imported.framePaths);
    await finishSheetImport(outputDir);
    const meta = await import("sharp").then(m => m.default(sheetPath).metadata());
    return { ...source, kind: "sheet", sheetPath, sheetMode: "metadata", metadataPath, sheetWidth: meta.width, sheetHeight: meta.height, sheetUrl: pathToFileURL(sheetPath).href, sheetCells: imported.frames.filter(f => f.page === 0).map(f => ({ left: f.x, top: f.y, width: f.width, height: f.height })), sheetFrameNames: imported.frames.map(f => f.name), frameMetadata: Object.fromEntries(imported.frames.map((f, i) => [i, { name: f.name, durationMs: f.durationMs, pivot: f.pivot, anchorPoints: f.anchorPoints, tag: f.tag, extra: f.extra }])), importedMetadata: imported.extra, importedAnimations: imported.animations, sourceIssues: imported.warnings.map(message => ({ code: "metadata-extension", message })), maskPrepared: true, title: path.basename(sheetPath), detail: `${imported.frames.length} кадров из PNG + JSON · ${imported.pages.length} страниц`, recommendations: { ...source.recommendations, keyMode: "alpha", anchor: "center" } };
  }
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
    maskPrepared: sliced.maskPrepared,
    sourceIssues: sliced.issues,
    title: path.basename(sheetPath),
    detail: `${sliced.width}×${sliced.height} · найдено объектов: ${sliced.framePaths.length}`,
    estimatedFrames: sliced.framePaths.length,
    suggestedKeyMode: sliced.maskPrepared ? "alpha" : source.suggestedKeyMode,
    recommendations: { ...source.recommendations, ...(sliced.maskPrepared ? { keyMode: "alpha" } : {}), anchor: "center" },
  };
}
