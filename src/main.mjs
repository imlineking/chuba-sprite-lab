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
import { inspectSource, makeSourcePreview, processFramePreview, processSprites, processVideoBatch, supportedImageExtensions } from "./processor.mjs";
import { assertGitHubDownloadUrl, compareVersions, parseSha256 } from "./update-utils.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
let mainWindow = null;
let activeJob = null;
const selfTestMode = process.argv.includes("--self-test") || process.env.CHUBA_SPRITE_SELF_TEST === "1";
const startupProbePath = process.env.CHUBA_SPRITE_STARTUP_PROBE || "";
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
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    reportStartupFailure("renderer-gone", new Error(`Процесс интерфейса завершился: ${details.reason}.`));
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
}

async function describePaths(kind, paths) {
  if (!paths?.length) return null;
  const source = await inspectSource({ kind, paths, appRoot });
  return {
    ...source,
    previewUrl: source.previewPath ? pathToFileURL(source.previewPath).href : null,
    sampleUrls: (source.samplePaths || []).map((item) => pathToFileURL(item).href),
  };
}

async function describeVideoBatch(paths) {
  const first = await describePaths("video", [paths[0]]);
  return {
    ...first,
    kind: "video-batch",
    paths,
    batchCount: paths.length,
    title: `${paths.length} видео`,
    detail: `${paths.length} роликов · настройки по ${path.basename(paths[0])}`,
  };
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

ipcMain.handle("source:video", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Выберите видео с анимацией",
    properties: ["openFile"],
    filters: [
      { name: "Видео", extensions: ["mp4", "webm", "mov", "mkv", "avi", "gif"] },
      { name: "Все файлы", extensions: ["*"] },
    ],
  });
  if (result.canceled) return null;
  return describePaths("video", result.filePaths);
});

ipcMain.handle("source:frames", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Выберите отдельные кадры",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Изображения", extensions: [...supportedImageExtensions].map((ext) => ext.slice(1)) },
    ],
  });
  if (result.canceled) return null;
  return describePaths("frames", result.filePaths);
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

ipcMain.handle("output:folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Куда сохранить готовый спрайт-лист",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
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
    activeJob = new AbortController();
    try {
      return await processVideoBatch({
        paths: request.source.paths,
        outputDir: request.outputDir,
        options: request.options,
        appRoot,
        signal: activeJob.signal,
        onProgress: (progress) => mainWindow?.webContents.send("sprites:progress", progress),
      });
    } finally {
      activeJob = null;
    }
  }
  request = await resolveExportConflict(request);
  activeJob = new AbortController();
  try {
    const result = await processSprites({
      ...request,
      appRoot,
      signal: activeJob.signal,
      onProgress: (progress) => mainWindow?.webContents.send("sprites:progress", progress),
    });
    return {
      ...result,
      sheetUrl: pathToFileURL(result.sheetPath).href,
      previewUrl: result.previewPath ? pathToFileURL(result.previewPath).href : null,
      frameUrls: result.framePaths.slice(0, 256).map((item) => pathToFileURL(item).href),
      sourceFrameUrls: result.sourceFramePaths.slice(0, 256).map((item) => pathToFileURL(item).href),
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
  activeJob.abort();
  return true;
});

ipcMain.handle("preview:frame", async (_event, request) => {
  const result = await processFramePreview({ ...(request || {}), appRoot });
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

async function runSelfTest() {
  try {
    const probe = await sharp({
      create: { width: 2, height: 2, channels: 4, background: { r: 255, g: 118, b: 23, alpha: 1 } },
    }).png().toBuffer();
    const metadata = await sharp(probe).metadata();
    if (metadata.width !== 2 || metadata.height !== 2) throw new Error("Sharp returned invalid test image metadata.");
    const ffmpegPath = path.join(process.resourcesPath, "vendor", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    await fs.access(ffmpegPath);
    await fs.access(path.join(process.resourcesPath, "models", "u2netp.onnx"));
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
}

const hasInstanceLock = selfTestMode || Boolean(startupProbePath) || app.requestSingleInstanceLock();

if (!hasInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(selfTestMode ? runSelfTest : createWindow).catch((error) => {
    reportStartupFailure("app-ready", error);
    app.exit(1);
  });
  app.on("window-all-closed", () => app.quit());
}
