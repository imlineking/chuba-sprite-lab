// Main-process wiring for the "Конвейер" window: IPC handlers, real stage implementations,
// the persistent queue and the watch folder. Kept out of main.mjs so the engine stays testable.
import fs from "node:fs/promises";
import path from "node:path";
import { ConveyorSessions } from "./conveyor-sessions.mjs";
import { reviewPngs } from "./png-review.mjs";
import { pathToFileURL } from "node:url";
import { independentOptions } from "./conveyor-working.mjs";
import { rebuildWorkingResult } from "./conveyor-rebuild.mjs";
import { detectInput } from "./input-types.mjs";
import { capabilitiesFor } from "./capabilities.mjs";
import { ConveyorQueue, PresetStore, createFolderWatcher, quickOutputDir, runConveyor, safeAtlasName, writeJsonAtomic } from "./conveyor.mjs";
import { applyFixToPreset } from "./copilot-conveyor.mjs";
import { videoFormats } from "./input-types.mjs";

export function createConveyorStages({ appRoot, sharp, describePaths, describeSpriteSheet, executeProcessing, buildAtlas, reviewAtlas, runtime, modelsDirectory, onProgress = () => {} }) {
  const stages = {
    detect: (paths) => detectInput(paths, { sharp }),
    async preview(paths) {
      const detection = await stages.detect(paths);
      if (!capabilitiesFor(detection.type).supported) return null;
      // A static preview of native images does not need full GIF/APNG extraction.
      const source = ["video", "video-batch", "aseprite", "atlas-json"].includes(detection.type) ? await stages.describe(detection) : null;
      const file = source ? source.previewPath || source.samplePaths?.[0] || source.paths?.[0] : detection.files[0];
      if (!file) return null;
      const buffer = await sharp(file).resize({ width: 1024, height: 768, fit: "inside", withoutEnlargement: true }).png().toBuffer();
      return { url: `data:image/png;base64,${buffer.toString("base64")}` };
    },
    async describe(detection) {
      const files = detection.files;
      switch (detection.type) {
        case "video": return describePaths("video", files.slice(0, 1));
        case "sprite-sheet": return describeSpriteSheet(files[0], { mode: "objects" });
        case "atlas-json": {
          const { normalizeSheetManifest } = await import("./sheet-metadata.mjs");
          const normalized = normalizeSheetManifest(JSON.parse(await fs.readFile(files[0], "utf8")));
          return describeSpriteSheet(path.resolve(path.dirname(files[0]), normalized.pages[0].image), { mode: "metadata", metadataPath: files[0] });
        }
        case "aseprite": case "animated-image": case "image": case "image-set": case "frames-folder":
          return describePaths("frames", files);
        default: throw new Error(capabilitiesFor(detection.type).message || "Тип не поддерживается.");
      }
    },
    async clean({ source, outputDir, name, options, intent, signal }) {
      await fs.mkdir(outputDir, { recursive: true });
      const separate = ["images", "atlas"].includes(intent);
      const independentIndices = source.paths.map((_, i) => i).filter(i => !(options.excludedFrames || []).includes(i));
      const animations = separate ? independentIndices.map(index => ({ name: `${index + 1}-${safeAtlasName(path.parse(source.paths[index]).name)}`, source: { ...source, paths: [source.paths[index]], frameCount: 1, frameMetadata: source.frameMetadata?.[index] ? { 0: source.frameMetadata[index] } : {}, importedAnimations: undefined }, options: independentOptions(options, index) })) : null;
      const result = await executeProcessing(separate ? "processAnimationSet" : "processSprites", { ...(separate ? { animations } : { source }), outputDir, name, options: { aiModelDirs: [modelsDirectory()], ...options }, appRoot, signal, onProgress });
      // The processor already owns the timeline and transformed frame metadata.
      // Map it to the emitted PNGs instead of guessing animation names from 0000.png.
      const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
      if (manifest.frames.length !== result.framePaths.length) throw new Error("Число PNG не совпадает с таймлайном после очистки.");
      const packingMetadata = {
        frameMetadata: Object.fromEntries(manifest.frames.map((frame, index) => [path.resolve(result.framePaths[index]), {
          name: frame.name, animation: manifest.animations.find((tag) => tag.from <= index && index <= tag.to)?.name || frame.animation, index,
          durationMs: frame.durationMs, pivot: frame.pivot,
        }])),
        animationMetadata: Object.fromEntries(manifest.animations.map((animation) => [animation.name, animation])),
        ...(manifest.animationLoop != null ? { animationLoop: manifest.animationLoop } : {}),
      };
      return { ...result, playbackFrames: manifest.frames.map((frame, index) => ({ sourceIndex: separate ? independentIndices[index] : frame.sourceFrameIndex, path: result.framePaths[index], url: pathToFileURL(result.framePaths[index]).href, name: frame.name, animation: manifest.animations.find(tag => tag.from <= index && index <= tag.to)?.name || frame.animation || "animation", durationMs: frame.durationMs || 100 })), packingMetadata, framesDir: path.join(result.outputDir, "frames") };
    },
    checkImages: reviewPngs,
    pack: (config) => buildAtlas(config, { write: true }),
    async check(built, preset, cleaned) {
      const rt = runtime?.();
      const usable = Boolean(preset.useModel && rt?.status().available);
      const review = await reviewAtlas(built, { runtime: usable ? rt : null, skillsDir: rt?.paths?.skills, useModel: usable });
      if (preset.useModel && !usable) review.fallbackReason = "Встроенная модель недоступна, только алгоритмы";
      if (cleaned) {
        const png = await reviewPngs(cleaned, preset);
        review.issues.push(...png.issues); review.metrics = png.metrics; review.score = Math.min(review.score, png.score);
        if (png.verdict === "rejected") review.verdict = "rejected";
        else if (png.verdict === "needs_fix" && review.verdict === "accepted") review.verdict = "needs_fix";
      }
      review.verdictLabel = { accepted: "Принято", needs_fix: "Нужны правки", rejected: "Отклонено" }[review.verdict] || review.verdict;
      await fs.writeFile(path.join(built.config.output, "review.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), atlas: built.config.name, ...review }, null, 2)}\n`);
      return review;
    },
    async exportResult({ detection, source, cleaned, built, review, preset, quick, intent, outputDir }) {
      const files = [];
      const warnings = built?.config.formats.includes("godot-spriteframes") && built.atlas.animationLoop > 1
        ? ["Godot SpriteFrames: конечное число повторов нужно задать в игровом коде; в .tres включён цикл. Исходное число сохранено в JSON."] : [];
      if (detection.type === "image" && cleaned.imagePaths?.[0]) {
        const target = path.join(outputDir, `${safeAtlasName(cleaned.name || path.parse(detection.files[0]).name)}.png`);
        await fs.copyFile(path.join(cleaned.framesDir, "0000.png"), target).catch(() => fs.copyFile(cleaned.imagePaths[0], target));
        files.push(target);
      }
      if (intent === "images") {
        const dir = path.join(outputDir, "PNG"); await fs.mkdir(dir, { recursive: true });
        for (const [index, file] of cleaned.framePaths.entries()) {
          const target = path.join(dir, `${index + 1}-${safeAtlasName(path.parse((detection.files.length === source.paths.length ? detection.files : source.paths)[cleaned.playbackFrames?.[index]?.sourceIndex ?? index]).name)}.png`);
          await fs.copyFile(file, target); files.push(target);
        }
      } else if (cleaned.sheetPath) files.push(cleaned.sheetPath);
      if (built) files.push(...(built.pages || []).map((p) => p.path || p.file).filter(Boolean).map((f) => path.resolve(built.config.output, f)));
      const summary = { generatedAt: new Date().toISOString(), input: detection.paths, type: detection.type, preset: preset.id, quick, intent, review: review ? { verdict: review.verdict, issues: review.issues?.length ?? 0 } : null, files, ...(warnings.length ? { warnings } : {}) };
      await writeJsonAtomic(path.join(outputDir, "conveyor.json"), summary);
      return { files, summary: `${files.length} файлов${warnings.length ? ` · ${warnings.join(" ")}` : ""}` };
    },
  };
  return stages;
}

export function registerConveyorIpc({ ipcMain, userData, stages, getWindow, isBusy = () => false, chooseDirectory, chooseFiles = null }) {
  const presets = new PresetStore(path.join(userData, "conveyor-presets.json"));
  const send = (channel, payload) => getWindow()?.webContents.send(channel, payload);
  let running = null;
  const sessions = new ConveyorSessions(stages, { directory: path.join(userData, "conveyor-checkpoints") });
  async function runItem(item, { signal, onStage } = {}) {
    const preset = await presets.get(item.presetId);
    const slot = "queue-" + item.id;
    const pending = item.resumeId || item.interrupted ? await sessions.pending(slot) : null;
    return sessions.run({ paths: item.paths, preset, outputDir: item.outputDir, quick: item.quick, intent: item.intent, slot, resumeId: item.resumeId || pending?.resumeId, signal,
      onSaved: async ({ resumeId, stage }) => { item.resumeId = resumeId; item.checkpointStage = stage; await queue.persist(); },
      onStage: s => { onStage?.(s); send("conveyor:progress", { itemId: item.id, ...s }); } });
  }
  const queue = new ConveyorQueue({ file: path.join(userData, "conveyor-queue.json"), run: runItem, onChange: (snap) => send("conveyor:queue", snap) });
  const ready = queue.load();
  let watcher = null; let watchConfig = null;
  const watchFile = path.join(userData, "conveyor-watch.json");

  async function enqueue(paths, presetId, outputDir, quick, origin, intent) {
    const detection = await stages.detect(paths);
    if (["image-set", "frames-folder"].includes(detection.type) && !["images", "atlas", "animation"].includes(intent)) throw new Error("Выберите цель для набора изображений перед добавлением в очередь.");
    // Several videos become separate jobs: one atlas per clip.
    if (detection.type === "video-batch") { for (const file of detection.files) await queue.add({ paths: [file], presetId, outputDir: outputDir ? path.join(outputDir) : null, quick: quick || !outputDir, origin }); }
    else await queue.add({ paths, presetId, outputDir, intent, quick: quick || !outputDir, origin });
    if (!isBusy() && !running) void queue.drain();
    return queue.snapshot();
  }

  async function startWatch(config) {
    watcher?.stop();
    const dir = path.resolve(String(config.dir || ""));
    if (!(await fs.stat(dir)).isDirectory()) throw new Error("Папка наблюдения не найдена.");
    const outputDir = config.outputDir ? path.resolve(config.outputDir) : path.join(dir, "SpriteLab-out");
    watchConfig = { dir, presetId: config.presetId || "phaser", outputDir };
    watcher = createFolderWatcher({
      dir, ignore: [outputDir],
      accept: (file) => /\.(png|jpe?g|webp|tiff?|avif|gif|apng|mp4|webm|mov|mkv|avi|ase|aseprite)$/i.test(file),
      onFiles: async (files) => { for (const file of files) await queue.add({ paths: [file], presetId: watchConfig.presetId, outputDir: watchConfig.outputDir, origin: "watch" }); if (!isBusy()) void queue.drain(); },
    });
    await watcher.primeExisting();
    watcher.start();
    await writeJsonAtomic(watchFile, watchConfig);
    return watchConfig;
  }
  fs.readFile(watchFile, "utf8").then((t) => startWatch(JSON.parse(t))).catch(() => {});

  ipcMain.handle("conveyor:detect", async (_e, { paths } = {}) => {
    const detection = await stages.detect(Array.isArray(paths) ? paths : []);
    return { detection, capabilities: capabilitiesFor(detection.type) };
  });
  ipcMain.handle("conveyor:review-png", async (_e, paths) => {
    const detection = await stages.detect(paths);
    if (detection.type !== "image") throw new Error("Эта проверка предназначена для одного изображения.");
    return reviewPngs({ framePaths: detection.files }, { background: "none" });
  });
  ipcMain.handle("conveyor:preview", (_e, paths) => stages.preview(paths));
  ipcMain.handle("conveyor:open", async (_e, paths) => stages.describe(await stages.detect(paths)));
  ipcMain.handle("conveyor:presets", () => presets.list());
  ipcMain.handle("conveyor:save-preset", (_e, preset) => presets.save(preset));
  ipcMain.handle("conveyor:remove-preset", (_e, id) => presets.remove(String(id)));
  ipcMain.handle("conveyor:run", async (_e, { paths, presetId, outputDir = null, quick = false, quickOptions = {}, fix = null, intent = null, resumeId = null } = {}) => {
    if (isBusy() || running || queue.running) throw new Error("Обработка уже выполняется.");
    if (!Array.isArray(paths) || !paths.length) throw new Error("Перетащите файл или папку.");
    let preset = await presets.get(quick ? "quick" : presetId);
    // Quick mode has two switches only: remove background, build an atlas.
    // A critic remark accepted from the copilot: only padding / extrude / page size / background.
    if (fix && !quick) preset = applyFixToPreset(preset, fix);
    if (quick) preset = { ...preset, background: quickOptions.background === false ? "none" : "auto", edgeCleanup: quickOptions.background !== false, pack: quickOptions.atlas !== false };
    const controller = new AbortController(); running = controller;
    try { return await sessions.run({ paths, preset, intent, resumeId, outputDir: outputDir ? path.resolve(outputDir) : null, quick: quick || !outputDir, deps: stages, signal: controller.signal, onStage: (s) => send("conveyor:progress", s) }); }
    finally { running = null; void queue.drain(); }
  });
  ipcMain.handle("conveyor:rebuild", async (_e, request) => {
    if (isBusy() || running || queue.running) throw new Error("Обработка уже выполняется.");
    const controller = new AbortController(); running = controller;
    try { return await rebuildWorkingResult({ ...request, preset: await presets.get(request.presetId), deps: stages, signal: controller.signal, onStage: s => send("conveyor:progress", s) }); }
    finally { running = null; void queue.drain(); }
  });
  ipcMain.handle("conveyor:recovery", () => sessions.pending());
  ipcMain.handle("conveyor:resume-saved", async (_e, request = {}) => {
    if (isBusy() || running || queue.running) throw new Error("Обработка уже выполняется.");
    const controller = new AbortController(); running = controller;
    try { return await sessions.resumeSaved({ resumeId: request.resumeId, ...(request.outputDir !== undefined ? { outputDir: request.outputDir ? path.resolve(request.outputDir) : null } : {}), signal: controller.signal, onStage: s => send("conveyor:progress", s) }); }
    finally { running = null; void queue.drain(); }
  });
  ipcMain.handle("conveyor:forget-recovery", () => sessions.discard());
  ipcMain.handle("conveyor:cancel", () => { running?.abort(); return Boolean(running); });
  ipcMain.handle("conveyor:quick-target", (_e, file) => quickOutputDir(String(file)));
  ipcMain.handle("conveyor:queue", async () => { await ready; return queue.snapshot(); });
  ipcMain.handle("conveyor:queue-add", async (_e, { paths, presetId, outputDir = null, quick = false, intent = null } = {}) => { await ready; return enqueue(paths, presetId, outputDir, quick, "user", intent); });
  ipcMain.handle("conveyor:queue-remove", async (_e, id) => { await queue.remove(String(id)); await sessions.discard("queue-" + id); return queue.snapshot(); });
  ipcMain.handle("conveyor:queue-cancel", async (_e, id) => { await queue.cancel(String(id)); if (queue.running !== id) await sessions.discard("queue-" + id); return queue.snapshot(); });
  ipcMain.handle("conveyor:queue-retry", async (_e, { id, pickOutput = false, fresh = false } = {}) => {
    await ready;
    let outputDir;
    if (pickOutput) { outputDir = await chooseDirectory("Новая папка результата"); if (!outputDir) return queue.snapshot(); }
    if (fresh) await sessions.discard("queue-" + id);
    await queue.retry(id, { outputDir, fresh });
    if (!running && !isBusy()) void queue.drain();
    return queue.snapshot();
  });
  ipcMain.handle("conveyor:queue-pause", async () => { await queue.pause(); return queue.snapshot(); });
  ipcMain.handle("conveyor:queue-resume", async () => { void queue.resume(); return queue.snapshot(); });
  ipcMain.handle("conveyor:queue-clear", async () => { const ids = queue.items.filter(i => ["done", "failed", "cancelled"].includes(i.status)).map(i => i.id); await queue.clearFinished(); for (const id of ids) await sessions.discard("queue-" + id); return queue.snapshot(); });
  ipcMain.handle("conveyor:queue-summary", async () => queue.summary());
  ipcMain.handle("conveyor:watch-get", () => watchConfig);
  ipcMain.handle("conveyor:watch-set", async (_e, config = {}) => {
    if (config.pick) { const dir = await chooseDirectory("Папка наблюдения"); if (!dir) return watchConfig; config = { ...config, dir }; }
    return startWatch(config);
  });
  ipcMain.handle("conveyor:watch-stop", async () => { watcher?.stop(); watcher = null; watchConfig = null; await fs.rm(watchFile, { force: true }); return null; });
  ipcMain.handle("conveyor:pick-output", () => chooseDirectory("Папка для результата"));
  ipcMain.handle("conveyor:pick-input", async (_e, { folder = false } = {}) => (folder ? [await chooseDirectory("Папка с кадрами")].filter(Boolean) : chooseFiles ? await chooseFiles("Выберите файлы") : []));
  return { queue, presets, stopWatch: () => watcher?.stop() };
}

export { videoFormats };
