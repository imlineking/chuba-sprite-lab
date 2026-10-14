// IPC for the copilot's video <-> frame workflows (see video-frames.mjs).
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import * as vf from "./video-frames.mjs";

export function registerVideoFrameIpc({ ipcMain, dialog, shell, appRoot, userData, workRoot, resolveBinary, keyFrame, isMain, send, spawnFn }) {
  const prefsPath = () => path.join(userData(), "external-editors.json");
  const watchers = new Map();
  const readPrefs = async () => { try { return JSON.parse(await fs.readFile(prefsPath(), "utf8")); } catch { return { editor: "system", paths: {} }; } };
  const guard = (event) => { if (!isMain(event)) throw new Error("Недопустимый отправитель."); };
  const ffmpeg = () => resolveBinary("ffmpeg", appRoot);
  const asVideo = async (p) => { const v = path.resolve(String(p || "")); await fs.access(v); return v; };
  const inWork = (p) => { const r = path.resolve(String(p || "")); if (!r.startsWith(path.resolve(workRoot()) + path.sep)) throw new Error("Недопустимый путь кадра."); return r; };

  ipcMain.handle("video-frame:info", async (event, { video } = {}) => { guard(event); return vf.probe(await ffmpeg(), await asVideo(video)); });
  ipcMain.handle("video-frame:extract", async (event, { video, index = 0, fps } = {}) => {
    guard(event);
    const dir = path.join(workRoot(), crypto.randomUUID());
    const out = path.join(dir, `${path.parse(String(video)).name}-frame-${String(Number(index) + 1).padStart(4, "0")}.png`);
    const frame = await vf.extractFrame({ ffmpeg: await ffmpeg(), video: await asVideo(video), index: Number(index) || 0, fps, outPath: out });
    const stat = await fs.stat(out);
    return { ...frame, url: pathToFileURL(out).href, modifiedAt: stat.mtimeMs };
  });
  ipcMain.handle("video-frame:editors", async (event) => { guard(event); const prefs = await readPrefs(); return { editors: Object.entries(vf.externalEditors).map(([id, e]) => ({ id, ...e, configured: id === "system" || Boolean(prefs.paths?.[id]) })), current: prefs.editor || "system" }; });
  ipcMain.handle("video-frame:choose-editor", async (event, { editor } = {}) => {
    guard(event);
    if (!vf.externalEditors[editor]) throw new Error("Неизвестный редактор.");
    const prefs = await readPrefs(); prefs.paths ||= {};
    if (editor !== "system") {
      const pick = await dialog.showOpenDialog({ title: `Где находится ${vf.externalEditors[editor].exeHint || "программа"}?`, properties: ["openFile"], filters: [{ name: "Программа", extensions: ["exe", "app", "*"] }] });
      if (pick.canceled || !pick.filePaths[0]) return null;
      prefs.paths[editor] = pick.filePaths[0];
    }
    prefs.editor = editor;
    await fs.mkdir(path.dirname(prefsPath()), { recursive: true }); await fs.writeFile(prefsPath(), JSON.stringify(prefs), "utf8");
    return { editor, exePath: prefs.paths[editor] || null };
  });
  // Opening an external editor is always the user's explicit click on a copilot chip.
  ipcMain.handle("video-frame:open-external", async (event, { path: file, editor } = {}) => {
    guard(event);
    const prefs = await readPrefs(); const chosen = editor || prefs.editor || "system";
    const target = inWork(file);
    const result = await vf.openInEditor({ editor: chosen, exePath: prefs.paths?.[chosen], file: target }, { openPath: (f) => shell.openPath(f), spawnFn });
    watchers.get(target)?.stop();
    watchers.set(target, vf.watchSaves(target, (saved) => send("video-frame:saved", { ...saved, url: `${pathToFileURL(target).href}?v=${Math.round(saved.modifiedAt)}` })));
    return result;
  });
  ipcMain.handle("video-frame:unwatch", (event, { path: file } = {}) => { guard(event); const key = path.resolve(String(file || "")); watchers.get(key)?.stop(); watchers.delete(key); return true; });
  ipcMain.handle("video-frame:bake", async (event, { video, framePng, index = 0, outPath = null, ask = true } = {}) => {
    guard(event);
    const source = await asVideo(video);
    let target = outPath || vf.bakedName(source);
    if (ask && !outPath) { const pick = await dialog.showSaveDialog({ title: "Сохранить видео с исправленным кадром", defaultPath: target }); if (pick.canceled || !pick.filePath) return null; target = pick.filePath; }
    if (path.resolve(target) === source) throw new Error("Сохраните под другим именем: исходное видео не перезаписывается.");
    return vf.bakeFrame({ ffmpeg: await ffmpeg(), video: source, framePng: path.resolve(String(framePng)), index: Number(index) || 0, outPath: target });
  });
  ipcMain.handle("video-frame:save-cutout", async (event, { video, index = 0, fps, folder = null, raw = false } = {}) => {
    guard(event);
    let dir = folder;
    if (!dir) { const pick = await dialog.showOpenDialog({ title: "Папка проекта для PNG", properties: ["openDirectory", "createDirectory"] }); if (pick.canceled || !pick.filePaths[0]) return null; dir = pick.filePaths[0]; }
    const tmpDir = path.join(workRoot(), crypto.randomUUID()); await fs.mkdir(tmpDir, { recursive: true });
    return vf.saveCutout({ ffmpeg: await ffmpeg(), video: await asVideo(video), index: Number(index) || 0, fps, folder: dir, raw: Boolean(raw), keyFrame: (p) => keyFrame(p, "auto", 32, 3, 0, { fringeCleanup: true, fringeStrength: 1 }), tmpDir });
  });
  return { watchers };
}
