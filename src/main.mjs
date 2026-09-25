import { app, BrowserWindow, clipboard, dialog, ipcMain, net, shell } from "electron";
import crypto from "node:crypto";
import fsSync from "node:fs";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";
import { analyzeFrameConsistency, inspectSource, makeSourcePreview, processAnimationSet, processFramePreview, processSprites, processVideoBatch, resolveBinary, supportedImageExtensions } from "./processor.mjs";
import { sliceSpriteSheet } from "./sheet-slicer.mjs";
import { matchSheetFrameNames, readSheetFrameRects } from "./sheet-metadata.mjs";
import { describePaths as describePathsFrom, describeSpriteSheet as describeSpriteSheetFrom, describeVideoBatch as describeVideoBatchFrom } from "./source-describe.mjs";
import { assertGitHubDownloadUrl, compareVersions, parseSha256 } from "./update-utils.mjs";
import { resolveAIModel, segmentSubject } from "./ai-segmentation.mjs";
import { finishSheetImport, makeTempWorkspace, pruneStaleTempWorkspaces } from "./temp-workspace.mjs";
import { planSuggestions, planTaskScenarios } from "./copilot-rules.mjs";
import * as editorSession from "./editor-session.mjs";
import * as autoPilot from "./auto-pilot.mjs";
import { assertDownloadUrl, canDownload, modelById, modelFiles, rejectedModels, validateModelFile, verificationOf } from "./ai-models.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
let mainWindow = null;
let activeJob = null;
const selfTestMode = process.argv.includes("--self-test") || process.env.CHUBA_SPRITE_SELF_TEST === "1";
const startupProbePath = process.env.CHUBA_SPRITE_STARTUP_PROBE || "";

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : "";
}

// Screenshot mode renders the window offscreen and writes a PNG, so the interface can be
// reviewed without a desktop session and without capturing anything else on the screen.
const screenshotArgument = argumentValue("--screenshot") || process.env.CHUBA_SPRITE_SCREENSHOT || "";
const screenshotPath = screenshotArgument ? path.resolve(screenshotArgument) : "";
const screenshotScript = argumentValue("--screenshot-js") || process.env.CHUBA_SPRITE_SCREENSHOT_JS || "";
const videoExtensions = new Set([".mp4", ".webm", ".mov", ".mkv", ".avi", ".gif"]);
const repositoryUrl = "https://github.com/imlineking/chuba-sprite-lab";
const latestReleaseApi = "https://api.github.com/repos/imlineking/chuba-sprite-lab/releases/latest";
const updateAssetName = "Chuba-Sprite-Lab-portable.exe";

function writeStartupFailure(stage, error) {
  const message = error instanceof Error ? `${error.message}\n${error.stack || ""}` : String(error);
  try {
    fsSync.mkdirSync(app.getPath("userData"), { recursive: true });
    fsSync.appendFileSync(
      path.join(app.getPath("userData"), "startup-errors.log"),
      `${new Date().toISOString()} [${stage}] ${message}\n`,
      "utf8",
    );
  } catch {
    // A startup diagnostic must never become another startup failure.
  }
}

function reportStartupFailure(stage, error) {
  writeStartupFailure(stage, error);
  const message = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox(
    "Chuba Sprite Lab не смог загрузить интерфейс",
    `${message}\n\nДиагностика сохранена в startup-errors.log в папке данных программы.`,
  );
}

const updaterScript = [
  "param(",
  "  [int]$ParentProcessId,",
  "  [string]$DownloadedFile,",
  "  [string]$TargetFile,",
  "  [string]$LogFile",
  ")",
  "$ErrorActionPreference = 'Stop'",
  "try {",
  "  Wait-Process -Id $ParentProcessId -ErrorAction SilentlyContinue",
  "  Start-Sleep -Milliseconds 1200",
  "  $backup = \"$TargetFile.previous\"",
  "  if (Test-Path -LiteralPath $TargetFile) { Copy-Item -LiteralPath $TargetFile -Destination $backup -Force }",
  "  $installed = $false",
  "  for ($attempt = 0; $attempt -lt 60; $attempt++) {",
  "    try {",
  "      Copy-Item -LiteralPath $DownloadedFile -Destination $TargetFile -Force",
  "      $installed = $true",
  "      break",
  "    } catch {",
  "      Start-Sleep -Milliseconds 500",
  "    }",
  "  }",
  "  if (-not $installed) { throw 'Portable executable remained locked.' }",
  "  Start-Process -FilePath $TargetFile",
  "  if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }",
  "  if (Test-Path -LiteralPath $DownloadedFile) { Remove-Item -LiteralPath $DownloadedFile -Force }",
  "} catch {",
  "  Add-Content -LiteralPath $LogFile -Value \"$([DateTime]::Now.ToString('s')) $($_.Exception.Message)\"",
  "  $backup = \"$TargetFile.previous\"",
  "  if (Test-Path -LiteralPath $backup) { Copy-Item -LiteralPath $backup -Destination $TargetFile -Force }",
  "  if (Test-Path -LiteralPath $TargetFile) { Start-Process -FilePath $TargetFile }",
  "}",
].join("\r\n");

async function fetchLatestRelease() {
  const response = await net.fetch(latestReleaseApi, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "Chuba-Sprite-Lab-Updater" },
  });
  if (!response.ok) throw new Error(`GitHub не ответил: HTTP ${response.status}.`);
  return response.json();
}

async function fetchText(url) {
  const response = await net.fetch(assertGitHubDownloadUrl(url), { headers: { "User-Agent": "Chuba-Sprite-Lab-Updater" } });
  if (!response.ok) throw new Error(`Не удалось получить контрольную сумму: HTTP ${response.status}.`);
  assertGitHubDownloadUrl(response.url);
  return response.text();
}

async function downloadUpdate(url, destination) {
  const response = await net.fetch(assertGitHubDownloadUrl(url), { headers: { "User-Agent": "Chuba-Sprite-Lab-Updater" } });
  if (!response.ok || !response.body) throw new Error(`Не удалось скачать обновление: HTTP ${response.status}.`);
  assertGitHubDownloadUrl(response.url);
  const total = Number(response.headers.get("content-length")) || 0;
  let received = 0;
  const hash = crypto.createHash("sha256");
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      hash.update(chunk);
      const value = total ? received / total : 0;
      mainWindow?.webContents.send("app:update-progress", { value, message: total ? `Скачивание · ${Math.round(value * 100)}%` : "Скачивание обновления…" });
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), meter, fsSync.createWriteStream(destination));
  return hash.digest("hex");
}

async function installPortableUpdate(downloadedFile) {
  const targetFile = process.env.PORTABLE_EXECUTABLE_FILE;
  if (!targetFile || path.extname(targetFile).toLowerCase() !== ".exe") {
    throw new Error("Автоматическая установка доступна только в однофайловой portable-версии.");
  }
  const updateRoot = await fs.mkdtemp(path.join(app.getPath("temp"), "chuba-sprite-update-script-"));
  const scriptPath = path.join(updateRoot, "install-update.ps1");
  const logPath = path.join(app.getPath("temp"), "Chuba-Sprite-Lab-update.log");
  await fs.writeFile(scriptPath, updaterScript, "utf8");
  const child = spawn("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
    "-File", scriptPath,
    "-ParentProcessId", String(process.pid),
    "-DownloadedFile", downloadedFile,
    "-TargetFile", targetFile,
    "-LogFile", logPath,
  ], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  setTimeout(() => app.quit(), 500);
}

// The very first capture of a freshly created window can fail inside Chromium's
// compositor ("UnknownVizError") before it has produced a frame, so it is retried.
async function capturePageWithRetry(attempts = 6) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await mainWindow.webContents.capturePage();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1040,
    minHeight: 700,
    frame: false,
    show: true,
    center: true,
    backgroundColor: "#0b0d10",
    icon: path.join(appRoot, "assets", "app.ico"),
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Show the dark application shell immediately. Waiting exclusively for
  // ready-to-show can leave a healthy renderer hidden forever on some Windows
  // systems and GPU configurations.
  void mainWindow.loadFile(path.join(here, "index.html")).catch((error) => reportStartupFailure("load-file", error));
  if (startupProbePath) {
    const probeTimeout = setTimeout(() => {
      fsSync.writeFileSync(startupProbePath, JSON.stringify({ loaded: false, visible: mainWindow?.isVisible() || false }), "utf8");
      app.exit(1);
    }, 15_000);
    mainWindow.webContents.once("did-finish-load", () => {
      clearTimeout(probeTimeout);
      const result = {
        loaded: true,
        visible: mainWindow?.isVisible() || false,
        title: mainWindow?.getTitle() || "",
      };
      fsSync.writeFileSync(startupProbePath, JSON.stringify(result), "utf8");
      setTimeout(() => app.exit(result.visible ? 0 : 1), 250);
    });
  }
  if (screenshotPath) {
    // capturePage() renders the page into an offscreen buffer, so the result does not
    // depend on window focus, on the active desktop, or on what else is on the screen.
    const captureTimeout = setTimeout(() => {
      console.error("Снимок интерфейса не сделан: страница не загрузилась за 20 секунд.");
      app.exit(1);
    }, 20_000);
    mainWindow.webContents.once("did-finish-load", async () => {
      try {
        // Let the renderer scripts finish their first paint before capturing.
        await new Promise((resolve) => setTimeout(resolve, 900));
        if (screenshotScript) {
          await mainWindow.webContents.executeJavaScript(await fs.readFile(screenshotScript, "utf8"), true);
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        const image = await capturePageWithRetry();
        await fs.writeFile(screenshotPath, image.toPNG());
        clearTimeout(captureTimeout);
        app.exit(0);
      } catch (error) {
        clearTimeout(captureTimeout);
        console.error(error);
        app.exit(1);
      }
    });
  }
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    reportStartupFailure("renderer-gone", new Error(`Процесс интерфейса завершился: ${details.reason}.`));
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
}

// The desktop window and the command line share one implementation, so a source is
// described identically in both. These wrappers only bind the application root.
const describePaths = (kind, paths) => describePathsFrom(appRoot, kind, paths);
const describeVideoBatch = (paths) => describeVideoBatchFrom(appRoot, paths);
const describeSpriteSheet = (sheetPath, options = {}) => describeSpriteSheetFrom(appRoot, sheetPath, options);

async function restoreProjectSource(descriptor = {}) {
  const paths = Array.isArray(descriptor.paths) ? descriptor.paths.map((item) => path.resolve(String(item))) : [];
  const available = [];
  for (const filePath of paths) if (await pathExists(filePath)) available.push(filePath);
  if (descriptor.kind === "sheet") {
    const sheetPath = path.resolve(String(descriptor.sheetPath || paths[0] || ""));
    if (!await pathExists(sheetPath)) throw new Error("Исходный спрайт-лист проекта не найден.");
    return describeSpriteSheet(sheetPath, descriptor.sheetOptions || { mode: descriptor.sheetMode || "objects" });
  }
  if (!available.length) throw new Error("Исходные файлы проекта больше недоступны.");
  if (descriptor.kind === "video-batch") return describeVideoBatch(available);
  return describePaths(descriptor.kind === "video" ? "video" : "frames", available);
}

function safeOutputName(value) {
  return String(value || "sprite-animation").trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 80) || "sprite-animation";
}

async function pathExists(candidate) {
  try { await fs.access(candidate); return true; } catch { return false; }
}

async function resolveExportConflict(request) {
  if (request.previewOnly || !request.outputDir) return request;
  const baseName = safeOutputName(request.name);
  const target = path.join(request.outputDir, baseName);
  if (!await pathExists(target) || (await fs.readdir(target)).length === 0) return request;
  const choice = await dialog.showMessageBox(mainWindow, {
    type: "question",
    title: "Папка набора уже существует",
    message: `Набор «${baseName}» уже существует.`,
    detail: "Обновить созданные программой файлы или сохранить результат как новую версию? Остальные файлы в папке не затрагиваются.",
    buttons: ["Обновить", "Новая версия", "Отмена"],
    defaultId: 1,
    cancelId: 2,
    noLink: true,
  });
  if (choice.response === 2) throw new Error("Экспорт отменён.");
  if (choice.response === 0) return { ...request, name: baseName, options: { ...request.options, cleanOutput: true } };
  let version = 2;
  while (await pathExists(path.join(request.outputDir, `${baseName}-${version}`))) version += 1;
  return { ...request, name: `${baseName}-${version}` };
}

ipcMain.handle("source:any", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Выберите видео или изображения",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Видео и изображения", extensions: ["mp4", "webm", "mov", "mkv", "avi", "gif", ...supportedImageExtensions].map((ext) => ext.replace(/^\./, "")) },
    ],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const videoPaths = result.filePaths.filter((item) => videoExtensions.has(path.extname(item).toLowerCase()));
  if (videoPaths.length && videoPaths.length !== result.filePaths.length) throw new Error("Видео и изображения нельзя смешивать в одной пачке.");
  if (videoPaths.length > 1) return describeVideoBatch(videoPaths);
  return describePaths(videoPaths.length ? "video" : "frames", result.filePaths);
});

ipcMain.handle("source:add-images", async (_event, existingPaths = []) => {
  if (!Array.isArray(existingPaths) || existingPaths.length > 4096) throw new Error("Неверный список изображений.");
  const existing = existingPaths.map((item) => path.resolve(String(item)));
  for (const item of existing) {
    if (!supportedImageExtensions.has(path.extname(item).toLowerCase()) || !(await fs.stat(item)).isFile()) throw new Error("Добавлять можно только существующие изображения.");
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Добавьте кадры или отдельные объекты",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Изображения", extensions: [...supportedImageExtensions].map((ext) => ext.slice(1)) }],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const all = [...new Set([...existing, ...result.filePaths.map((item) => path.resolve(item))])];
  if (all.length === existing.length) throw new Error("Выбранные изображения уже добавлены.");
  return describePaths("frames", all);
});

ipcMain.handle("source:use-image-object", async (_event, filePath) => {
  const resolved = path.resolve(String(filePath || ""));
  if (!supportedImageExtensions.has(path.extname(resolved).toLowerCase()) || !(await fs.stat(resolved)).isFile()) throw new Error("Выбранный объект не найден.");
  return describePaths("frames", [resolved]);
});

ipcMain.handle("source:sheet", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Выберите готовый спрайт-лист",
    properties: ["openFile"],
    filters: [{ name: "Спрайт-лист", extensions: [...supportedImageExtensions].map((ext) => ext.slice(1)) }],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return describeSpriteSheet(result.filePaths[0], { mode: "objects" });
});

ipcMain.handle("source:reslice-sheet", async (_event, request = {}) => {
  const sheetPath = path.resolve(String(request.sheetPath || ""));
  if (!fsSync.existsSync(sheetPath) || !supportedImageExtensions.has(path.extname(sheetPath).toLowerCase())) throw new Error("Исходный спрайт-лист не найден.");
  return describeSpriteSheet(sheetPath, request.options || {});
});

ipcMain.handle("source:analyze-frames", async (_event, request = {}) => {
  return analyzeFrameConsistency(request.measurements, { transforms: request.transforms, referenceIndex: request.referenceIndex });
});

ipcMain.handle("source:folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Выберите папку с кадрами",
    properties: ["openDirectory"],
  });
  if (result.canceled) return null;
  const entries = await fs.readdir(result.filePaths[0], { withFileTypes: true });
  const paths = entries
    .filter((entry) => entry.isFile() && supportedImageExtensions.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(result.filePaths[0], entry.name));
  return describePaths("frames", paths);
});

ipcMain.handle("source:dropped", async (_event, payload) => {
  const paths = Array.isArray(payload?.paths) ? payload.paths : [];
  if (!paths.length) return null;
  const stats = await Promise.all(paths.map((item) => fs.stat(item)));
  if (stats.length === 1 && stats[0].isDirectory()) {
    const entries = await fs.readdir(paths[0], { withFileTypes: true });
    const imagePaths = entries
      .filter((entry) => entry.isFile() && supportedImageExtensions.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => path.join(paths[0], entry.name));
    return describePaths("frames", imagePaths);
  }
  const videoPaths = paths.filter((item) => videoExtensions.has(path.extname(item).toLowerCase()));
  if (videoPaths.length && videoPaths.length !== paths.length) throw new Error("Видео и изображения нельзя смешивать в одной пачке.");
  if (videoPaths.length > 1) return describeVideoBatch(videoPaths);
  return describePaths(videoPaths.length ? "video" : "frames", paths);
});

ipcMain.handle("profile:save", async (_event, request = {}) => {
  const profile = request?.profile;
  if (!profile || profile.format !== "chuba-sprite-lab-profile") throw new Error("Рецепт сборки не сформирован.");
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Сохранить рецепт сборки",
    defaultPath: `${safeOutputName(profile.name || "sprite-recipe")}.recipe.json`,
    filters: [{ name: "Рецепт сборки Chuba Sprite Lab", extensions: ["json"] }],
  });
  if (result.canceled || !result.filePath) return null;
  const target = result.filePath.toLowerCase().endsWith(".json") ? result.filePath : `${result.filePath}.json`;
  await fs.writeFile(target, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  return { path: target };
});

// Edited frames are working copies, so they are kept in the application data folder rather than in
// the temporary workspace: a frame override is referenced by the project and has to survive a restart.
// The pixel editor draws in the window and hands the finished frame over as PNG bytes.
// Edited frames are written next to each other in the user data folder: they are working copies, and
// a project only needs to remember the path it finally picked.
async function writeFramePng({ frameIndex = 0, name = "frame", png }) {
  if (!png || typeof png.length !== "number" || !png.length) throw new Error("Пустое изображение кадра.");
  const directory = path.join(app.getPath("userData"), "pixel-edits");
  await fs.mkdir(directory, { recursive: true });
  const safeIndex = Math.max(0, Math.round(Number(frameIndex) || 0));
  const fileName = `${safeOutputName(String(name || "frame"))}-${String(safeIndex).padStart(4, "0")}-${Date.now()}.png`;
  const target = path.join(directory, fileName);
  await fs.writeFile(target, Buffer.from(png));
  const stats = await fs.stat(target);
  return { path: target, url: `${pathToFileURL(target).href}?v=${Math.round(stats.mtimeMs)}`, modifiedAt: stats.mtimeMs };
}

/* ------------------------------------------------------------- built-in pixel editor */

// Opening reads the pixels here: a file:// image drawn into the window canvas cannot be read back,
// so the raw buffer has to come from the main process.
ipcMain.handle("editor:open", async (_event, request = {}) => {
  const filePath = path.resolve(String(request.path || ""));
  if (!filePath || !await pathExists(filePath)) throw new Error("Кадр для редактирования не найден.");
  const { data, info } = await sharp(filePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return editorSession.openSession({
    width: info.width,
    height: info.height,
    name: request.name || path.basename(filePath, path.extname(filePath)),
    frameIndex: request.frameIndex,
    pixels: data,
  });
});

// One entry point for the editing commands: the interface sends the operation name, and every answer
// has the same state shape so the window has a single redraw path.
const editorOperations = {
  paint: (request) => editorSession.paint(request.sessionId, request),
  fill: (request) => editorSession.fill(request.sessionId, request),
  eraseTransparent: (request) => editorSession.eraseTransparent(request.sessionId, request),
  pick: (request) => editorSession.pick(request.sessionId, request),
  layerPixel: (request) => editorSession.layerPixel(request.sessionId, request),
  undo: (request) => editorSession.stepHistory(request.sessionId, "undo"),
  redo: (request) => editorSession.stepHistory(request.sessionId, "redo"),
  state: (request) => editorSession.readState(request.sessionId),
  addLayer: (request) => editorSession.addEmptyLayer(request.sessionId, request),
  removeLayer: (request) => editorSession.deleteLayer(request.sessionId, request),
  updateLayer: (request) => editorSession.updateLayer(request.sessionId, request),
  close: (request) => ({ closed: editorSession.closeSession(request.sessionId) }),
};

ipcMain.handle("editor:op", async (_event, request = {}) => {
  const operation = editorOperations[String(request.op || "")];
  if (!operation) throw new Error(`Неизвестная операция редактора: ${request.op || "—"}`);
  return operation(request);
});

/* ------------------------------------------------------------------- models and auto mode */

// Downloads land in the application data folder, not next to the program: a portable build may sit in
// a read-only place, and a gigabyte of weights should not travel with the game.
function modelsDirectory() {
  return path.join(app.getPath("userData"), "models");
}

function modelsStatePath() {
  return path.join(modelsDirectory(), "installed.json");
}

async function readModelsState() {
  try {
    const state = JSON.parse(await fs.readFile(modelsStatePath(), "utf8"));
    return state && typeof state === "object" && state.models ? state : { models: {} };
  } catch {
    return { models: {} };
  }
}

async function writeModelsState(state) {
  await fs.mkdir(modelsDirectory(), { recursive: true });
  await fs.writeFile(modelsStatePath(), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

// What is on disk, where it came from, what it was verified against, and whether it was ever run. All
// of these are shown separately, because "downloaded" and "works" are different claims.
async function modelsStatus() {
  const state = await readModelsState();
  const directory = modelsDirectory();
  const bundledDirs = [
    process.resourcesPath ? path.join(process.resourcesPath, "models") : null,
    path.join(appRoot, "models"),
  ].filter(Boolean);
  const entries = [];
  for (const summary of autoPilot.catalogSummary()) {
    const record = state.models?.[summary.id] || {};
    const files = [];
    for (const file of modelFiles(summary)) {
      let bytes = 0;
      let origin = null;
      try {
        bytes = (await fs.stat(path.join(directory, file.file))).size;
        origin = "downloaded";
      } catch {
        bytes = 0;
      }
      if (!bytes) {
        for (const bundledDir of bundledDirs) {
          try {
            bytes = (await fs.stat(path.join(bundledDir, file.file))).size;
            origin = "bundled";
            break;
          } catch { /* Not in this folder. */ }
        }
      }
      const recorded = (record.files || []).find((entry) => entry.file === file.file)?.sha256 || null;
      files.push({
        file: file.file,
        present: bytes > 0,
        bytes,
        origin,
        expectedBytes: file.sizeBytes || 0,
        url: file.url || null,
        verification: verificationOf(file, { recorded }),
      });
    }
    entries.push({
      ...summary,
      files,
      installed: files.every((file) => file.present),
      bundledOnDisk: files.every((file) => file.origin === "bundled"),
      validation: record.validation || null,
      validatedAt: record.validatedAt || null,
      installedAt: record.installedAt || null,
    });
  }
  return { directory, entries, rejected: rejectedModels };
}

function installedModelIds(status) {
  return status.entries.filter((entry) => entry.installed).map((entry) => entry.id);
}

ipcMain.handle("models:status", () => modelsStatus());

ipcMain.handle("models:download", async (_event, request = {}) => {
  const entry = modelById(String(request.id || ""));
  if (!entry) throw new Error("Неизвестная модель.");
  if (entry.bundled) return { id: entry.id, skipped: "bundled" };
  if (!canDownload(entry)) {
    throw new Error(`У модели «${entry.name}» нет проверенной прямой ссылки. Откройте страницу проекта и положите файл .onnx в папку моделей.`);
  }
  const directory = modelsDirectory();
  await fs.mkdir(directory, { recursive: true });
  const state = await readModelsState();
  const record = { ...(state.models?.[entry.id] || {}), files: [] };
  const files = modelFiles(entry);
  for (const [index, file] of files.entries()) {
    const url = assertDownloadUrl(file.url);
    const target = path.join(directory, file.file);
    const temporary = `${target}.part`;
    const response = await net.fetch(url, { headers: { "User-Agent": "Chuba-Sprite-Lab-Models" } });
    if (!response.ok || !response.body) throw new Error(`Не удалось скачать ${file.file}: HTTP ${response.status}.`);
    // A redirect could leave the trusted hosts, so the address the runtime reports is checked as well.
    // It is only checked when it is reported at all: the request itself was already validated, and the
    // content is checked afterwards by size and, where published, by the SHA-256 from the catalogue.
    if (response.url) assertDownloadUrl(response.url, { redirect: true });
    const total = Number(response.headers.get("content-length")) || file.sizeBytes || 0;
    let received = 0;
    const hash = crypto.createHash("sha256");
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        hash.update(chunk);
        mainWindow?.webContents.send("models:progress", {
          id: entry.id,
          file: file.file,
          fileIndex: index,
          fileCount: files.length,
          received,
          total,
          value: total ? received / total : 0,
        });
        callback(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(response.body), meter, fsSync.createWriteStream(temporary));
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw new Error(`Не удалось скачать ${file.file}: ${error?.message || "соединение прервано"}`);
    }
    const digest = hash.digest("hex");
    // Two checks, both honest about themselves: the size is published with the file, the hash only
    // when the publisher offers one. Otherwise the hash is recorded here for later comparisons.
    if (file.sizeBytes && received !== file.sizeBytes) {
      await fs.rm(temporary, { force: true });
      throw new Error(`Размер ${file.file} не совпал: получено ${received} байт вместо ${file.sizeBytes}. Файл не установлен.`);
    }
    if (file.sha256 && digest !== file.sha256) {
      await fs.rm(temporary, { force: true });
      throw new Error(`Контрольная сумма ${file.file} не совпала с опубликованной. Файл не установлен.`);
    }
    await fs.rm(target, { force: true });
    await fs.rename(temporary, target);
    record.files.push({ file: file.file, bytes: received, sha256: digest, verification: file.sha256 ? "published" : "recorded" });
  }
  record.installedAt = Date.now();
  state.models[entry.id] = record;
  await writeModelsState(state);
  return { id: entry.id, files: record.files };
});

// Downloading proves the bytes arrived; only running the model proves it works. This is a separate,
// explicit step because a heavy model takes seconds to load and gigabytes of memory.
ipcMain.handle("models:validate", async (_event, request = {}) => {
  const entry = modelById(String(request.id || ""));
  if (!entry) throw new Error("Неизвестная модель.");
  const filePath = entry.bundled
    ? await resolveModelForValidation(entry)
    : path.join(modelsDirectory(), entry.file);
  if (!await pathExists(filePath)) throw new Error("Модель ещё не скачана. Сначала скачайте файл.");
  const report = await validateModelFile(filePath, { family: entry.family, provider: "cpu" });
  const state = await readModelsState();
  state.models[entry.id] = { ...(state.models?.[entry.id] || {}), validatedAt: Date.now(), validation: report };
  await writeModelsState(state);
  return { id: entry.id, ...report };
});

// The bundled model lives next to the program; the validator needs the same path the pipeline uses.
async function resolveModelForValidation(entry) {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, "models", entry.file) : null,
    path.join(appRoot, "models", entry.file),
  ].filter(Boolean);
  for (const candidate of candidates) if (await pathExists(candidate)) return candidate;
  return path.join(modelsDirectory(), entry.file);
}

ipcMain.handle("models:remove", async (_event, request = {}) => {
  const entry = modelById(String(request.id || ""));
  if (!entry) throw new Error("Неизвестная модель.");
  if (entry.bundled) throw new Error("Модель в комплекте удалять нельзя.");
  const directory = modelsDirectory();
  let removed = 0;
  for (const file of modelFiles(entry)) {
    for (const candidate of [path.join(directory, file.file), path.join(directory, `${file.file}.part`)]) {
      try {
        await fs.rm(candidate, { force: true });
        removed += 1;
      } catch { /* Nothing to remove. */ }
    }
  }
  const state = await readModelsState();
  delete state.models[entry.id];
  await writeModelsState(state);
  return { id: entry.id, removed };
});

ipcMain.handle("models:open-folder", async () => {
  const directory = modelsDirectory();
  await fs.mkdir(directory, { recursive: true });
  await shell.openPath(directory);
  return { directory };
});

// Only the pages written into the catalogue, and only over HTTPS.
ipcMain.handle("models:open-page", async (_event, request = {}) => {
  const entry = modelById(String(request.id || ""));
  const url = String(request.url || entry?.page || "");
  if (!/^https:\/\//.test(url)) throw new Error("Страница модели должна открываться по HTTPS.");
  await shell.openExternal(url);
  return { url };
});

// The auto mode needs two things: real measurements from the frames, and what is installed. Both are
// gathered here so the window never has to guess at either.
ipcMain.handle("autopilot:plan", async (_event, request = {}) => {
  const paths = (Array.isArray(request.paths) ? request.paths : []).map((item) => path.resolve(String(item))).filter(Boolean);
  const measurements = await autoPilot.measureSource(paths);
  const status = await modelsStatus();
  const plan = autoPilot.planAutoPilot({
    measurements,
    target: request.target || {},
    source: request.source || {},
    installed: installedModelIds(status),
  });
  return { ...plan, measuredFiles: paths.length, modelsDirectory: status.directory };
});

ipcMain.handle("editor:save", async (_event, request = {}) => {  const frame = editorSession.exportFrame(request.sessionId);
  const png = await sharp(Buffer.from(frame.composite.buffer, frame.composite.byteOffset, frame.composite.byteLength), {
    raw: { width: frame.width, height: frame.height, channels: 4 },
  }).png({ compressionLevel: 9 }).toBuffer();
  return { ...await writeFramePng({ frameIndex: frame.frameIndex, name: request.name || frame.name, png }), width: frame.width, height: frame.height };
});

ipcMain.handle("output:folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Куда сохранить готовый спрайт-лист",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("project:restore", async (_event, request = {}) => restoreProjectSource(request.source));

ipcMain.handle("project:load", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Открыть проект Chuba Sprite Lab",
    properties: ["openFile"],
    filters: [{ name: "Проект Chuba Sprite Lab", extensions: ["cslab"] }],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const projectPath = result.filePaths[0];
  const project = JSON.parse(await fs.readFile(projectPath, "utf8"));
  if (!project || project.format !== "chuba-sprite-lab-project" || !project.source) throw new Error("Файл не является проектом Chuba Sprite Lab.");
  const source = await restoreProjectSource(project.source);
  return { projectPath, project, source };
});

ipcMain.handle("project:save", async (_event, request = {}) => {
  const project = request.project;
  if (!project || project.format !== "chuba-sprite-lab-project" || !project.source) throw new Error("Проект не содержит исходника.");
  let projectPath = request.projectPath ? path.resolve(String(request.projectPath)) : null;
  if (!projectPath || request.saveAs) {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Сохранить проект Chuba Sprite Lab",
      defaultPath: project.name ? `${safeOutputName(project.name)}.cslab` : "sprite-project.cslab",
      filters: [{ name: "Проект Chuba Sprite Lab", extensions: ["cslab"] }],
    });
    if (result.canceled || !result.filePath) return null;
    projectPath = result.filePath.toLowerCase().endsWith(".cslab") ? result.filePath : `${result.filePath}.cslab`;
  }

  const assetDir = path.join(path.dirname(projectPath), `${path.basename(projectPath, ".cslab")}.assets`);
  await fs.mkdir(assetDir, { recursive: true });
  const frameOverrides = {};
  for (const [index, sourcePath] of Object.entries(project.frameOverrides || {})) {
    if (!await pathExists(sourcePath)) continue;
    const targetPath = path.join(assetDir, `frame-${String(Number(index) + 1).padStart(4, "0")}.png`);
    if (path.resolve(sourcePath) !== path.resolve(targetPath)) await sharp(sourcePath).ensureAlpha().png().toFile(targetPath);
    frameOverrides[index] = targetPath;
  }
  const attachments = [];
  for (const [index, attachment] of (project.attachments || []).entries()) {
    if (!attachment?.path || !await pathExists(attachment.path)) {
      attachments.push(attachment);
      continue;
    }
    const extension = supportedImageExtensions.has(path.extname(attachment.path).toLowerCase()) ? path.extname(attachment.path).toLowerCase() : ".png";
    const targetPath = path.join(assetDir, `attachment-${String(index + 1).padStart(3, "0")}-${safeOutputName(attachment.title || "element")}${extension}`);
    if (path.resolve(attachment.path) !== path.resolve(targetPath)) await fs.copyFile(attachment.path, targetPath);
    attachments.push({ ...attachment, path: targetPath, url: pathToFileURL(targetPath).href });
  }
  // Named animations: copy each animation's edited frames and elements next to the project.
  let animations = project.animations;
  if (Array.isArray(project.animations)) {
    animations = [];
    for (const [animIndex, animation] of project.animations.entries()) {
      const doc = animation?.document;
      if (!doc) { animations.push(animation); continue; }
      const docOverrides = {};
      for (const [index, sourcePath] of Object.entries(doc.frameOverrides || {})) {
        if (!await pathExists(sourcePath)) continue;
        const targetPath = path.join(assetDir, `anim-${animIndex + 1}-frame-${String(Number(index) + 1).padStart(4, "0")}.png`);
        if (path.resolve(sourcePath) !== path.resolve(targetPath)) await sharp(sourcePath).ensureAlpha().png().toFile(targetPath);
        docOverrides[index] = targetPath;
      }
      const docAttachments = [];
      for (const [index, attachment] of (doc.attachments || []).entries()) {
        if (!attachment?.path || !await pathExists(attachment.path)) { docAttachments.push(attachment); continue; }
        const extension = supportedImageExtensions.has(path.extname(attachment.path).toLowerCase()) ? path.extname(attachment.path).toLowerCase() : ".png";
        const targetPath = path.join(assetDir, `anim-${animIndex + 1}-attachment-${String(index + 1).padStart(3, "0")}-${safeOutputName(attachment.title || "element")}${extension}`);
        if (path.resolve(attachment.path) !== path.resolve(targetPath)) await fs.copyFile(attachment.path, targetPath);
        docAttachments.push({ ...attachment, path: targetPath, url: pathToFileURL(targetPath).href });
      }
      animations.push({ ...animation, document: { ...doc, frameOverrides: docOverrides, attachments: docAttachments } });
    }
  }
  const saved = { ...project, frameOverrides, attachments, ...(animations ? { animations } : {}), savedAt: new Date().toISOString() };
  await fs.writeFile(projectPath, `${JSON.stringify(saved, null, 2)}\n`, "utf8");
  return { projectPath, project: saved };
});

ipcMain.handle("overlay:choose", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Выберите PNG-элемент для привязки",
    properties: ["openFile"],
    filters: [{ name: "PNG с прозрачностью", extensions: ["png", "webp"] }],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const filePath = result.filePaths[0];
  const metadata = await sharp(filePath).metadata();
  if (!metadata.width || !metadata.height) throw new Error("Не удалось прочитать выбранное изображение.");
  return {
    path: filePath,
    url: pathToFileURL(filePath).href,
    title: path.basename(filePath),
    width: metadata.width,
    height: metadata.height,
    hasAlpha: Boolean(metadata.hasAlpha),
  };
});

ipcMain.handle("ai:choose-mask", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Белая область на PNG-маске будет дорисована LaMa",
    properties: ["openFile"],
    filters: [{ name: "PNG-маска", extensions: ["png"] }],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const filePath = result.filePaths[0];
  const info = await sharp(filePath).metadata();
  if (!info.width || !info.height) throw new Error("Не удалось прочитать PNG-маску.");
  return { path: filePath, name: path.basename(filePath) };
});

function externalEditRoot() {
  return path.join(app.getPath("temp"), "Chuba Sprite Lab", "external-edits");
}

function assertExternalEditPath(filePath) {
  const root = path.resolve(externalEditRoot());
  const resolved = path.resolve(String(filePath || ""));
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("Недопустимый путь рабочей копии.");
  return resolved;
}

ipcMain.handle("frame-edit:prepare", async (_event, request = {}) => {
  // A saved .cslab project keeps its edited frames next to the project file,
  // so an existing revision is not necessarily inside our temporary edit root.
  // It is read-only input here; the editable copy is still created in the
  // controlled temporary directory below.
  const existingPath = request.existingPath ? path.resolve(String(request.existingPath)) : null;
  if (existingPath && (!fsSync.existsSync(existingPath) || !supportedImageExtensions.has(path.extname(existingPath).toLowerCase()))) {
    throw new Error("Сохранённая версия кадра больше недоступна.");
  }
  const sourcePath = existingPath && fsSync.existsSync(existingPath)
    ? existingPath
    : path.resolve(String(request.sourcePath || ""));
  if (!fsSync.existsSync(sourcePath)) throw new Error("Исходный кадр больше недоступен.");
  const sessionDir = path.join(externalEditRoot(), crypto.randomUUID());
  await fs.mkdir(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, `frame-${String(Number(request.frameIndex || 0) + 1).padStart(4, "0")}.png`);
  await sharp(sourcePath).ensureAlpha().png().toFile(filePath);
  const stats = await fs.stat(filePath);
  return { path: filePath, url: pathToFileURL(filePath).href, modifiedAt: stats.mtimeMs };
});

ipcMain.handle("frame-edit:open", async (_event, request = {}) => {
  const filePath = assertExternalEditPath(request.path);
  if (!fsSync.existsSync(filePath)) throw new Error("Рабочая копия кадра не найдена.");
  if (request.mode === "open-with") {
    const child = spawn("rundll32.exe", ["shell32.dll,OpenAs_RunDLL", filePath], { detached: true, windowsHide: true, stdio: "ignore" });
    child.unref();
    return { opened: true };
  }
  const error = await shell.openPath(filePath);
  if (error) throw new Error(error);
  return { opened: true };
});

const onlineFrameEditors = {
  photopea: "https://www.photopea.com/",
  canva: "https://www.canva.com/photo-editor/",
  figma: "https://www.figma.com/design/",
  pixlr: "https://pixlr.com/e/",
  "pixlr-x": "https://pixlr.com/express/",
};

ipcMain.handle("frame-edit:online", async (_event, request = {}) => {
  const filePath = assertExternalEditPath(request.path);
  const editorUrl = onlineFrameEditors[request.editor];
  if (!editorUrl) throw new Error("Неизвестный онлайн-редактор.");
  clipboard.writeText(filePath);
  await shell.openExternal(editorUrl);
  return { opened: true, copiedPath: filePath };
});

ipcMain.handle("frame-edit:replace", async (_event, request = {}) => {
  const targetPath = assertExternalEditPath(request.path);
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Выберите сохранённый кадр",
    properties: ["openFile"],
    filters: [{ name: "Изображение", extensions: ["png", "webp", "jpg", "jpeg"] }],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const incomingPath = `${targetPath}.incoming.png`;
  await sharp(result.filePaths[0]).ensureAlpha().png().toFile(incomingPath);
  await fs.copyFile(incomingPath, targetPath);
  await fs.unlink(incomingPath).catch(() => {});
  const stats = await fs.stat(targetPath);
  return { path: targetPath, url: `${pathToFileURL(targetPath).href}?v=${Math.round(stats.mtimeMs)}`, modifiedAt: stats.mtimeMs };
});

async function replaceFrameEditFromPath(targetPath, sourcePath) {
  const resolvedTarget = assertExternalEditPath(targetPath);
  const resolvedSource = path.resolve(String(sourcePath || ""));
  if (!fsSync.existsSync(resolvedSource) || !supportedImageExtensions.has(path.extname(resolvedSource).toLowerCase())) throw new Error("Перетащите PNG, WEBP или JPG.");
  const incomingPath = `${resolvedTarget}.incoming.png`;
  await sharp(resolvedSource).ensureAlpha().png().toFile(incomingPath);
  await fs.copyFile(incomingPath, resolvedTarget);
  await fs.unlink(incomingPath).catch(() => {});
  const stats = await fs.stat(resolvedTarget);
  return { path: resolvedTarget, url: `${pathToFileURL(resolvedTarget).href}?v=${Math.round(stats.mtimeMs)}`, modifiedAt: stats.mtimeMs };
}

ipcMain.handle("frame-edit:replace-dropped", async (_event, request = {}) => replaceFrameEditFromPath(request.path, request.incomingPath));

ipcMain.handle("frame-edit:snapshot", async (_event, filePath) => {
  const sourcePath = assertExternalEditPath(filePath);
  const revisionDir = path.join(externalEditRoot(), "revisions");
  await fs.mkdir(revisionDir, { recursive: true });
  const revisionPath = path.join(revisionDir, `${crypto.randomUUID()}.png`);
  await fs.copyFile(sourcePath, revisionPath);
  const stats = await fs.stat(revisionPath);
  return { path: revisionPath, url: pathToFileURL(revisionPath).href, modifiedAt: stats.mtimeMs };
});

ipcMain.handle("frame-edit:stat", async (_event, filePath) => {
  const resolved = assertExternalEditPath(filePath);
  const stats = await fs.stat(resolved);
  return { modifiedAt: stats.mtimeMs, size: stats.size };
});

ipcMain.handle("sprites:build", async (_event, request) => {
  if (activeJob) throw new Error("Обработка уже выполняется.");
  const isBatch = request.source?.kind === "video-batch";
  if (isBatch && request.previewOnly) {
    request = {
      ...request,
      source: { ...request.source, kind: "video", paths: [request.source.paths[0]], title: path.basename(request.source.paths[0]) },
    };
  }
  if (isBatch && !request.previewOnly) {
    activeJob = { controller: new AbortController(), stopAfterCurrent: false };
    try {
      return await processVideoBatch({
        paths: request.source.paths,
        outputDir: request.outputDir,
        options: request.options,
        appRoot,
        signal: activeJob.controller.signal,
        shouldStop: () => Boolean(activeJob?.stopAfterCurrent),
        onProgress: (progress) => mainWindow?.webContents.send("sprites:progress", progress),
      });
    } finally {
      activeJob = null;
    }
  }
  request = await resolveExportConflict(request);
  activeJob = { controller: new AbortController(), stopAfterCurrent: false };
  try {
    const common = {
      appRoot,
      signal: activeJob.controller.signal,
      onProgress: (progress) => mainWindow?.webContents.send("sprites:progress", progress),
    };
    // Every job can see the downloaded models without the window having to pass a path around.
    const withModels = (payload) => ({ ...payload, options: { aiModelDirs: [modelsDirectory()], ...(payload.options || {}) } });
    let result;
    if (Array.isArray(request.animations) && request.animations.length > 1) {
      // Named animations (idle/run/jump) exported into one atlas with tags.
      const animations = [];
      for (const animation of request.animations) {
        const source = animation.active ? request.source : await restoreProjectSource(animation.source);
        animations.push({ name: animation.name, source, options: { ...(request.options || {}), ...(animation.options || {}), aiModelDirs: [modelsDirectory()] } });
      }
      result = await processAnimationSet(withModels({ ...request, ...common, animations }));
    } else {
      result = await processSprites(withModels({ ...request, ...common }));
    }
    const toUrl = (item) => pathToFileURL(item).href;
    return {
      ...result,
      sheetUrl: toUrl(result.sheetPath),
      sheetUrls: (result.sheetPaths || [result.sheetPath]).map(toUrl),
      previewUrl: result.previewPath ? toUrl(result.previewPath) : null,
      frameUrls: (result.imagePaths || result.framePaths).slice(0, 256).map(toUrl),
      depthUrls: (result.depthPaths || []).slice(0, 256).map(toUrl),
      sourceFrameUrls: result.sourceFramePaths.slice(0, 256).map((item) => item ? pathToFileURL(item).href : null),
      allSourceFrameUrls: result.allSourceFramePaths.slice(0, 256).map((item) => pathToFileURL(item).href),
    };
  } finally {
    activeJob = null;
  }
});

ipcMain.handle("source:poster", async (_event, request) => {
  if (!request?.path) throw new Error("Видео для предпросмотра не выбрано.");
  const previewPath = await makeSourcePreview(request.path, "video", appRoot, request.time || 0);
  return { previewPath, previewUrl: pathToFileURL(previewPath).href };
});

ipcMain.handle("sprites:cancel", () => {
  if (!activeJob) return false;
  activeJob.controller.abort();
  return true;
});

ipcMain.handle("sprites:stop-after-current", () => {
  if (!activeJob) return false;
  activeJob.stopAfterCurrent = true;
  return true;
});

ipcMain.handle("preview:frame", async (_event, request) => {
  const result = await processFramePreview({ ...(request || {}), appRoot, options: { aiModelDirs: [modelsDirectory()], ...((request || {}).options || {}) } });
  return {
    ...result,
    beforeUrl: pathToFileURL(result.beforePath).href,
    afterUrl: pathToFileURL(result.afterPath).href,
  };
});

ipcMain.handle("output:reveal", async (_event, outputPath) => {
  if (typeof outputPath === "string" && outputPath) shell.showItemInFolder(outputPath);
});

ipcMain.handle("output:copy-path", (_event, outputPath) => {
  if (typeof outputPath !== "string" || !outputPath) return false;
  clipboard.writeText(outputPath);
  return true;
});

// The assistant's hints are computed in the main process so the rules stay a pure,
// testable module instead of a second copy inside the classic renderer scripts.
ipcMain.handle("copilot:suggest", (_event, snapshot = {}) => planSuggestions(snapshot));
ipcMain.handle("copilot:scenarios", (_event, snapshot = {}) => planTaskScenarios(snapshot));

ipcMain.handle("app:info", () => ({
  version: app.getVersion(),
  author: "Hanuman Media Company — Demidenko Dmitriy",
  repositoryUrl,
  portable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE),
}));

ipcMain.handle("app:open-repository", async () => {
  await shell.openExternal(repositoryUrl);
  return true;
});

ipcMain.handle("app:check-updates", async () => {
  try {
    mainWindow?.webContents.send("app:update-progress", { value: 0, message: "Проверяю GitHub Releases…" });
    const release = await fetchLatestRelease();
    const latestVersion = String(release.tag_name || "").replace(/^v/i, "");
    const currentVersion = app.getVersion();
    if (!latestVersion) throw new Error("В последнем релизе GitHub не указана версия.");
    if (compareVersions(latestVersion, currentVersion) <= 0) {
      return { status: "current", currentVersion, latestVersion };
    }

    const executableAsset = release.assets?.find((asset) => asset.name === updateAssetName);
    const checksumAsset = release.assets?.find((asset) => asset.name === `${updateAssetName}.sha256`);
    if (!executableAsset || !checksumAsset) throw new Error("В релизе отсутствует portable EXE или его SHA-256.");
    return { status: "available", currentVersion, latestVersion, portable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE) };
  } catch (error) {
    return { status: "error", message: error.message || "Не удалось проверить обновления." };
  }
});

ipcMain.handle("app:install-update", async () => {
  try {
    const release = await fetchLatestRelease();
    const latestVersion = String(release.tag_name || "").replace(/^v/i, "");
    const currentVersion = app.getVersion();
    if (!latestVersion) throw new Error("В последнем релизе GitHub не указана версия.");
    if (compareVersions(latestVersion, currentVersion) <= 0) return { status: "current", currentVersion, latestVersion };
    const executableAsset = release.assets?.find((asset) => asset.name === updateAssetName);
    const checksumAsset = release.assets?.find((asset) => asset.name === `${updateAssetName}.sha256`);
    if (!executableAsset || !checksumAsset) throw new Error("В релизе отсутствует portable EXE или его SHA-256.");
    if (!process.env.PORTABLE_EXECUTABLE_FILE) {
      await shell.openExternal(release.html_url || repositoryUrl);
      return { status: "manual", latestVersion };
    }
    const updateRoot = await fs.mkdtemp(path.join(app.getPath("temp"), "chuba-sprite-download-"));
    const downloadedFile = path.join(updateRoot, updateAssetName);
    const checksumText = await fetchText(checksumAsset.browser_download_url);
    const expectedHash = parseSha256(checksumText);
    const actualHash = await downloadUpdate(executableAsset.browser_download_url, downloadedFile);
    if (actualHash.toLowerCase() !== expectedHash) {
      await fs.rm(downloadedFile, { force: true });
      throw new Error("Контрольная сумма обновления не совпала. Установка отменена.");
    }
    mainWindow?.webContents.send("app:update-progress", { value: 1, message: "Проверено · устанавливаю обновление…" });
    await installPortableUpdate(downloadedFile);
    return { status: "installing", latestVersion };
  } catch (error) {
    return { status: "error", message: error.message || "Не удалось установить обновление." };
  }
});

ipcMain.on("window:minimize", () => mainWindow?.minimize());
ipcMain.on("window:maximize", () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on("window:close", () => mainWindow?.close());

// A portable Electron build runs in the GUI subsystem, so its console output is not visible from
// a terminal. The self-test therefore also writes a machine-readable report that CI and a person
// checking a clean machine can read.
function selfTestReportPath() {
  return path.resolve(argumentValue("--self-test-report") || path.join(process.cwd(), "chuba-self-test.json"));
}

function writeSelfTestReport(report) {
  try {
    fsSync.writeFileSync(selfTestReportPath(), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  } catch {
    // A diagnostic that cannot be written must not change the exit code.
  }
}

async function runSelfTest() {
  const report = { ok: false, startedAt: new Date().toISOString(), appRoot, checks: [] };
  try {
    const probe = await sharp({
      create: { width: 2, height: 2, channels: 4, background: { r: 255, g: 118, b: 23, alpha: 1 } },
    }).png().toBuffer();
    const metadata = await sharp(probe).metadata();
    if (metadata.width !== 2 || metadata.height !== 2) throw new Error("Sharp returned invalid test image metadata.");
    report.checks.push({ name: "sharp", ok: true });

    const ffmpegPath = await resolveBinary("ffmpeg", appRoot);
    await fs.access(ffmpegPath);
    report.checks.push({ name: "ffmpeg", ok: true, path: ffmpegPath });

    const modelPath = await resolveAIModel(appRoot, { extraDirs: [modelsDirectory()] });
    await fs.access(modelPath);
    report.checks.push({ name: "model", ok: true, path: modelPath });

    const probeDir = await fs.mkdtemp(path.join(app.getPath("temp"), "chuba-ai-check-"));
    try {
      const input = path.join(probeDir, "probe.png");
      await fs.writeFile(input, probe);
      const segmented = await segmentSubject(input, { appRoot, modelDirs: [modelsDirectory()] });
      if (segmented.info.width !== 2 || segmented.data.length !== 16) throw new Error("ИИ-модель вернула неверный кадр.");
      report.provider = segmented.provider || "cpu";
      report.model = segmented.model;
      report.modelInput = segmented.inputSize;
      report.checks.push({ name: "inference", ok: true, provider: report.provider, model: report.model, inputSize: report.modelInput });
      console.log(`ИИ-модель: ${report.model || "u2netp"}, вход ${report.modelInput || "—"}, ускоритель ${report.provider}`);
    } finally {
      await fs.rm(probeDir, { recursive: true, force: true });
    }
    report.ok = true;
    report.finishedAt = new Date().toISOString();
    writeSelfTestReport(report);
    app.exit(0);
  } catch (error) {
    report.error = error?.message || String(error);
    report.finishedAt = new Date().toISOString();
    writeSelfTestReport(report);
    console.error(error);
    app.exit(1);
  }
}

const hasInstanceLock = selfTestMode || Boolean(startupProbePath) || Boolean(screenshotPath) || app.requestSingleInstanceLock();

if (!hasInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(async () => {
    await pruneStaleTempWorkspaces().catch(() => {});
    return selfTestMode ? runSelfTest() : createWindow();
  }).catch((error) => {
    reportStartupFailure("app-ready", error);
    app.exit(1);
  });
  app.on("window-all-closed", () => app.quit());
}
