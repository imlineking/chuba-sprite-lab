// Video <-> single frame workflows driven by the copilot:
//  * take one frame out of a video (PNG), optionally with the background removed;
//  * edit it in Sprite Lab or in an external editor of the user's choice and watch for saves;
//  * bake the edited frame back into the video (ffmpeg re-encode, fps and audio kept).
// ffmpeg and the process launcher are injected so tests never start real editors.
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export function run(command, args, { spawnFn = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, { windowsHide: true });
    let stderr = "", stdout = "";
    child.stdout?.on("data", (c) => { stdout += c; }); child.stderr?.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${path.basename(command)}: код ${code}\n${stderr.slice(-800)}`))));
  });
}

// ffmpeg -i banner -> what we need to rebuild the video faithfully.
export function parseStreamInfo(stderr = "") {
  const video = /Stream #\d+:\d+[^:]*: Video: (\w+)[^\n]*?, (\d{2,5})x(\d{2,5})[^\n]*?(?:, ([\d.]+) fps|, ([\d.]+) tbr)/.exec(stderr);
  const audio = /Stream #\d+:\d+[^:]*: Audio: (\w+)/.exec(stderr);
  const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(stderr);
  const pix = /Video: \w+[^,]*, (\w+)[(,]/.exec(stderr);
  return {
    codec: video?.[1] || null, width: Number(video?.[2] || 0), height: Number(video?.[3] || 0),
    fps: Number(video?.[4] || video?.[5] || 0), audio: audio?.[1] || null, pixFmt: pix?.[1] || null,
    duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0,
  };
}

export async function probe(ffmpeg, video, opts) {
  try { await run(ffmpeg, ["-hide_banner", "-i", video], opts); return { codec: null }; }
  catch (error) { return parseStreamInfo(error.message + ""); }
}

export const frameTime = (index, fps) => Math.max(0, (Number(index) || 0) / (Number(fps) || 25));
export const frameIndexAt = (time, fps) => Math.max(0, Math.round((Number(time) || 0) * (Number(fps) || 25)));

export async function extractFrame({ ffmpeg, video, index, fps, outPath }, opts) {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  // Exact frame selection by number (select=eq(n,N)) rather than a seek, so bake-back hits the same frame.
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", video, "-map", "0:v:0", "-vf", `select=eq(n\\,${Math.max(0, Math.round(index))})`, "-fps_mode", "passthrough", "-frames:v", "1", outPath], opts);
  const stat = await fs.stat(outPath).catch(() => null);
  if (!stat?.size) throw new Error(`Кадр ${index + 1} не найден в видео (fps ${fps || "?"}).`);
  return { path: outPath, index, time: frameTime(index, fps) };
}

const encoders = { h264: ["libx264", "-crf", "16", "-preset", "medium"], hevc: ["libx265", "-crf", "18"], vp9: ["libvpx-vp9", "-crf", "24", "-b:v", "0"], vp8: ["libvpx", "-crf", "8", "-b:v", "2M"], prores: ["prores_ks"], mpeg4: ["mpeg4", "-q:v", "2"] };
export function encoderFor(info, outPath) {
  const ext = path.extname(outPath).toLowerCase();
  if (encoders[info.codec]) return { args: encoders[info.codec], sameCodec: true };
  return { args: ext === ".webm" ? encoders.vp9 : encoders.h264, sameCodec: false };
}

export function bakeArgs({ video, framePng, index, info, outPath }) {
  const enc = encoderFor(info, outPath);
  const scale = info.width && info.height ? `scale=${info.width}:${info.height},` : "";
  const filter = `[1:v]${scale}format=rgba[f];[0:v][f]overlay=0:0:enable='eq(n\\,${Math.round(index)})'${info.pixFmt ? `,format=${info.pixFmt}` : ""}[v]`;
  return { enc, args: ["-hide_banner", "-loglevel", "error", "-y", "-i", video, "-i", framePng, "-filter_complex", filter, "-map", "[v]", "-map", "0:a?", "-c:a", "copy", "-c:v", ...enc.args, ...(info.fps ? ["-r", String(info.fps)] : []), outPath] };
}

export async function bakeFrame({ ffmpeg, video, framePng, index, outPath }, opts) {
  const info = await probe(ffmpeg, video, opts);
  const { enc, args } = bakeArgs({ video, framePng, index, info, outPath });
  await run(ffmpeg, args, opts);
  const notes = [];
  if (!enc.sameCodec) notes.push(`Исходный кодек ${info.codec || "неизвестен"} заменён на ${enc.args[0]}.`);
  notes.push("Видео перекодировано: остальные кадры почти не изменились, но это не побитовая копия.");
  return { path: outPath, info, encoder: enc.args[0], notes };
}

export const bakedName = (video) => { const p = path.parse(video); return path.join(p.dir, `${p.name}-edited${p.ext || ".mp4"}`); };

// External editors. "system" uses the file association; others need the editor's exe.
export const externalEditors = Object.freeze({
  system: { label: "Программа по умолчанию" },
  photoshop: { label: "Photoshop", exeHint: "Photoshop.exe" },
  figma: { label: "Figma", exeHint: "Figma.exe", note: "Figma не открывает PNG с диска как документ: перетащите кадр в Figma, затем экспортируйте PNG поверх того же файла." },
  custom: { label: "Другая программа" },
});

export function editorLaunch({ editor = "system", exePath = null, file }) {
  if (!externalEditors[editor]) throw new Error("Неизвестный редактор.");
  if (editor === "system") return { shell: true, file };
  if (!exePath) throw new Error(`Укажите путь к ${externalEditors[editor].exeHint || "программе"}.`);
  return { command: exePath, args: [file], file };
}

export async function openInEditor(request, { openPath, spawnFn = spawn } = {}) {
  const launch = editorLaunch(request);
  if (launch.shell) { const error = await openPath(launch.file); if (error) throw new Error(error); return { opened: true, editor: "system" }; }
  const child = spawnFn(launch.command, launch.args, { detached: true, stdio: "ignore", windowsHide: false });
  child.unref?.();
  return { opened: true, editor: request.editor, note: externalEditors[request.editor].note || null };
}

// Poll mtime/size; calls onSave once per completed write (size stable across two polls).
export function watchSaves(file, onSave, { interval = 800, stat = (f) => fs.stat(f), autoStart = true } = {}) {
  let last = null, pending = null, stopped = false, timer = null;
  const check = async () => {
    const s = await stat(file).catch(() => null);
    if (!s || stopped) return;
    const sig = `${s.mtimeMs}:${s.size}`;
    if (last === null) last = sig;
    else if (sig !== last) { if (pending === sig) { last = sig; pending = null; await onSave({ path: file, modifiedAt: s.mtimeMs }); } else pending = sig; }
  };
  const loop = async () => { await check(); if (!stopped) timer = setTimeout(loop, interval); };
  if (autoStart) timer = setTimeout(loop, 0);
  return { stop() { stopped = true; clearTimeout(timer); }, tick: check };
}

// Single frame with the character only: extract, key out the background, crop, save PNG.
export async function saveCutout({ ffmpeg, video, index, fps, folder, name, keyFrame, tmpDir, raw = false }, opts) {
  const rawPath = path.join(tmpDir, `frame-${index}.png`);
  await extractFrame({ ffmpeg, video, index, fps, outPath: rawPath }, opts);
  const keyed = raw ? { buffer: await fs.readFile(rawPath), bounds: { width: 2, height: 2 } } : await keyFrame(rawPath);
  await fs.mkdir(folder, { recursive: true });
  const out = path.join(folder, `${name || path.parse(video).name}-${raw ? "frame" : "sprite"}-${String(index + 1).padStart(4, "0")}.png`);
  await fs.writeFile(out, keyed.buffer);
  const empty = !keyed.bounds || keyed.bounds.width < 2 || keyed.bounds.height < 2;
  return { path: out, bounds: keyed.bounds || null, empty };
}
