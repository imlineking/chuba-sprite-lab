// Main-process wiring for the "Конвейер" window: IPC handlers, real stage implementations,
// the persistent queue and the watch folder. Kept out of main.mjs so the engine stays testable.
import fs from "node:fs/promises";
import path from "node:path";
import { detectInput } from "./input-types.mjs";
import { capabilitiesFor } from "./capabilities.mjs";
import { ConveyorQueue, PresetStore, createFolderWatcher, quickOutputDir, runConveyor, writeJsonAtomic } from "./conveyor.mjs";
import { videoFormats } from "./input-types.mjs";

export function createConveyorStages({ appRoot, sharp, describePaths, describeSpriteSheet, executeProcessing, buildAtlas, reviewAtlas, runtime, modelsDirectory, onProgress = () => {} }) {
  return {
    detect: (paths) => detectInput(paths, { sharp }),
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
    async clean({ source, outputDir, name, options, signal }) {
      await fs.mkdir(outputDir, { recursive: true });
      const result = await executeProcessing("processSprites", { source, outputDir, name, options: { aiModelDirs: [modelsDirectory()], ...options }, appRoot, signal, onProgress });
      return { ...result, framesDir: path.join(result.outputDir, "frames") };
    },
    pack: (config) => buildAtlas(config, { write: true }),
    async check(built, preset) {
      const rt = runtime?.();
      const usable = Boolean(preset.useModel && rt?.status().available);
      const review = await reviewAtlas(built, { runtime: usable ? rt : null, skillsDir: rt?.paths?.skills, useModel: usable });
      if (preset.useModel && !usable) review.fallbackReason = "Встроенная модель недоступна, только алгоритмы";
      review.verdictLabel = { accepted: "Принято", needs_fix: "Нужны правки", rejected: "Отклонено" }[review.verdict] || review.verdict;
      await fs.writeFile(path.join(built.config.output, "review.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), atlas: built.config.name, ...review }, null, 2)}\n`);
      return review;
    },
    async exportResult({ detection, cleaned, built, review, preset, quick, outputDir }) {
      const files = [];
      if (detection.type === "image" && cleaned.imagePaths?.[0]) {
        const target = path.join(outputDir, `${path.parse(detection.files[0]).name}.png`);
        await fs.copyFile(path.join(cleaned.framesDir, "0000.png"), target).catch(() => fs.copyFile(cleaned.imagePaths[0], target));
        files.push(target);
      }
      if (cleaned.sheetPath) files.push(cleaned.sheetPath);
      if (built) files.push(...(built.pages || []).map((p) => p.path || p.file).filter(Boolean).map((f) => path.resolve(built.config.output, f)));
      const summary = { generatedAt: new Date().toISOString(), input: detection.paths, type: detection.type, preset: preset.id, quick, review: review ? { verdict: review.verdict, issues: review.issues?.length ?? 0 } : null, files };
      await writeJsonAtomic(path.join(outputDir, "conveyor.json"), summary);
      return { files, summary: `${files.length} файлов` };
    },
  };
}

export function registerConveyorIpc({ ipcMain, userData, stages, getWindow, isBusy = () => false, chooseDirectory, chooseFiles = null }) {
  const presets = new PresetStore(path.join(userData, "conveyor-presets.json"));
  const send = (channel, payload) => getWindow()?.webContents.send(channel, payload);
  let running = null;
  async function runItem(item, { signal, onStage } = {}) {
    const preset = await presets.get(item.presetId);
    return runConveyor({ paths: item.paths, preset, outputDir: item.outputDir, quick: item.quick, deps: stages, signal, onStage: (s) => { onStage?.(s); send("conveyor:progress", { itemId: item.id, ...s }); } });
  }
  const queue = new ConveyorQueue({ file: path.join(userData, "conveyor-queue.json"), run: runItem, onChange: (snap) => send("conveyor:queue", snap) });
  const ready = queue.load();
  let watcher = null; let watchConfig = null;
  const watchFile = path.join(userData, "conveyor-watch.json");

  async function enqueue(paths, presetId, outputDir, quick, origin) {
    const detection = await stages.detect(paths);
    // Several videos become separate jobs: one atlas per clip.
    if (detection.type === "video-batch") { for (const file of detection.files) await queue.add({ paths: [file], presetId, outputDir: outputDir ? path.join(outputDir) : null, quick: quick || !outputDir, origin }); }
    else await queue.add({ paths, presetId, outputDir, quick: quick || !outputDir, origin });
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
  ipcMain.handle("conveyor:presets", () => presets.list());
  ipcMain.handle("conveyor:save-preset", (_e, preset) => presets.save(preset));
  ipcMain.handle("conveyor:remove-preset", (_e, id) => presets.remove(String(id)));
  ipcMain.handle("conveyor:run", async (_e, { paths, presetId, outputDir = null, quick = false, quickOptions = {} } = {}) => {
    if (isBusy() || running) throw new Error("Обработка уже выполняется.");
    if (!Array.isArray(paths) || !paths.length) throw new Error("Перетащите файл или папку.");
    let preset = await presets.get(quick ? "quick" : presetId);
    // Quick mode has two switches only: remove background, build an atlas.
    if (quick) preset = { ...preset, background: quickOptions.background === false ? "none" : "auto", edgeCleanup: quickOptions.background !== false, pack: quickOptions.atlas !== false };
    const controller = new AbortController(); running = controller;
    try { return await runConveyor({ paths, preset, outputDir: outputDir ? path.resolve(outputDir) : null, quick: quick || !outputDir, deps: stages, signal: controller.signal, onStage: (s) => send("conveyor:progress", s) }); }
    finally { running = null; void queue.drain(); }
  });
  ipcMain.handle("conveyor:cancel", () => { running?.abort(); return Boolean(running); });
  ipcMain.handle("conveyor:quick-target", (_e, file) => quickOutputDir(String(file)));
  ipcMain.handle("conveyor:queue", async () => { await ready; return queue.snapshot(); });
  ipcMain.handle("conveyor:queue-add", async (_e, { paths, presetId, outputDir = null, quick = false } = {}) => { await ready; return enqueue(paths, presetId, outputDir, quick, "user"); });
  ipcMain.handle("conveyor:queue-remove", async (_e, id) => { await queue.remove(String(id)); return queue.snapshot(); });
  ipcMain.handle("conveyor:queue-cancel", async (_e, id) => { await queue.cancel(String(id)); return queue.snapshot(); });
  ipcMain.handle("conveyor:queue-pause", async () => { await queue.pause(); return queue.snapshot(); });
  ipcMain.handle("conveyor:queue-resume", async () => { void queue.resume(); return queue.snapshot(); });
  ipcMain.handle("conveyor:queue-clear", async () => { await queue.clearFinished(); return queue.snapshot(); });
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
