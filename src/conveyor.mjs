// "Конвейер": one-click pipeline (нарезка -> очистка фона -> упаковка -> проверка -> экспорт),
// saved presets, a persistent batch queue and a watch folder. The engine is dependency-injected
// so tests run it without Electron, FFmpeg or models; main.mjs wires the real stages.
import fs from "node:fs/promises";
import path from "node:path";
import { capabilitiesFor } from "./capabilities.mjs";

export const builtinPresets = Object.freeze([
  { id: "phaser", label: "Phaser", builtin: true, background: "auto", ai: false, edgeCleanup: true, pixelArt: false, atlas: { formats: ["phaser-hash", "texturepacker-hash"], padding: 2, extrude: 1, maxSize: 2048, powerOfTwo: true }, review: true, useModel: true },
  { id: "godot", label: "Godot", builtin: true, background: "auto", ai: false, edgeCleanup: true, pixelArt: false, atlas: { formats: ["godot-spriteframes", "godot-atlastexture"], padding: 2, extrude: 1, maxSize: 2048, powerOfTwo: false }, review: true, useModel: true },
  { id: "unity", label: "Unity", builtin: true, background: "auto", ai: false, edgeCleanup: true, pixelArt: false, atlas: { formats: ["unity-meta", "unity-json"], padding: 2, extrude: 1, maxSize: 2048, powerOfTwo: true }, review: true, useModel: true },
  { id: "pixel-art", label: "Пиксель-арт", builtin: true, background: "auto", ai: false, edgeCleanup: false, pixelArt: true, atlas: { formats: ["texturepacker-hash", "phaser-hash"], padding: 1, extrude: 0, maxSize: 2048, powerOfTwo: true }, review: true, useModel: false },
  { id: "quick", label: "Быстрый", builtin: true, background: "auto", ai: false, edgeCleanup: true, pixelArt: false, atlas: { formats: ["texturepacker-hash"], padding: 2, extrude: 0, maxSize: 4096, powerOfTwo: false }, review: false, useModel: false },
]);

const presetKeys = new Set(["id", "label", "background", "ai", "edgeCleanup", "pixelArt", "atlas", "review", "useModel"]);
export function validatePreset(preset) {
  if (!preset || typeof preset !== "object" || Array.isArray(preset)) throw new Error("Пресет должен быть объектом.");
  const unknown = Object.keys(preset).filter((k) => !presetKeys.has(k) && k !== "builtin");
  if (unknown.length) throw new Error(`Недопустимые поля пресета: ${unknown.join(", ")}`);
  if (typeof preset.id !== "string" || !/^[\w-]{1,48}$/.test(preset.id)) throw new Error("id пресета: латиница, цифры, _ и -.");
  if (typeof preset.label !== "string" || !preset.label.trim() || preset.label.length > 64) throw new Error("Укажите название пресета.");
  if (!["auto", "none", "ai"].includes(preset.background ?? "auto")) throw new Error("background: auto, none или ai.");
  const atlas = { ...builtinPresets[0].atlas, ...(preset.atlas || {}) };
  if (!Array.isArray(atlas.formats) || !atlas.formats.length) throw new Error("Выберите хотя бы один формат экспорта.");
  for (const k of ["padding", "extrude", "maxSize"]) if (!Number.isFinite(atlas[k]) || atlas[k] < 0 || atlas[k] > 16384) throw new Error(`${k}: недопустимое значение.`);
  return { id: preset.id, label: preset.label.trim(), background: preset.background ?? "auto", ai: Boolean(preset.ai), edgeCleanup: preset.edgeCleanup !== false, pixelArt: Boolean(preset.pixelArt), atlas, review: preset.review !== false, useModel: preset.useModel !== false };
}

// Presets live in one JSON file; built-ins are always present and cannot be overwritten.
export class PresetStore {
  constructor(file) { this.file = file; }
  async list() {
    const saved = await readJson(this.file, []);
    const custom = (Array.isArray(saved) ? saved : []).flatMap((p) => { try { const v = validatePreset(p); return builtinPresets.some((b) => b.id === v.id) ? [] : [v]; } catch { return []; } });
    return [...builtinPresets, ...custom];
  }
  async get(id) { return (await this.list()).find((p) => p.id === id) || builtinPresets[0]; }
  async save(preset) {
    const value = validatePreset(preset);
    if (builtinPresets.some((b) => b.id === value.id)) throw new Error("Встроенный пресет нельзя перезаписать; сохраните под другим именем.");
    const custom = (await this.list()).filter((p) => !p.builtin && p.id !== value.id);
    await writeJsonAtomic(this.file, [...custom, value]);
    return value;
  }
  async remove(id) {
    if (builtinPresets.some((b) => b.id === id)) throw new Error("Встроенный пресет нельзя удалить.");
    await writeJsonAtomic(this.file, (await this.list()).filter((p) => !p.builtin && p.id !== id));
  }
}

// Processor options derived from a preset (only keys the processor already understands).
export function processorOptions(preset, recommendations = {}) {
  return {
    ...recommendations,
    keyMode: preset.background === "none" ? "none" : preset.background === "ai" || preset.ai ? "ai" : (recommendations.keyMode || "auto"),
    fringeCleanup: preset.edgeCleanup, edgeDecontaminate: preset.edgeCleanup,
    // Packing settings go to the atlas stage (pipeline/build); the processor keeps its own sheet defaults.
    pixelate: preset.pixelArt ? { gridMode: "adaptive", size: 4, colors: 32, palette: "auto", mode: "clean", dither: "none", shadingSteps: 0, detail: 50, softAlpha: false, paletteScope: "series" } : null,
  };
}

export function quickOutputDir(filePath) {
  const parsed = path.parse(path.resolve(filePath));
  return path.join(parsed.dir, `${parsed.name}-spritelab`);
}

export function safeAtlasName(value) { return String(value || "atlas").replace(/[^\w.-]+/g, "_").replace(/^[_.]+|[_.]+$/g, "").slice(0, 64) || "atlas"; }

// Plan which stages run for a detected type and preset.
export function planStages(type, preset) {
  const caps = capabilitiesFor(type);
  return caps.stages.map((s) => {
    if (!caps.supported) return { ...s, run: false, reason: caps.message };
    if (!s.applies) return { ...s, run: false, reason: "не нужен для этого типа" };
    if (s.id === "pack" && preset.pack === false) return { ...s, run: false, reason: "выключено" };
    if (s.id === "check" && (!preset.review || preset.pack === false)) return { ...s, run: false, reason: "выключено в пресете" };
    return { ...s, run: true };
  });
}

/**
 * Run the whole conveyor for one input.
 * deps: { detect(paths), describe(detection), clean({source, outputDir, name, options}), pack(config), check(built, preset), exportResult({...}) }
 * Returns { ok, type, stages:[{id,status,detail}], outputDir, review?, error? }.
 */
export async function runConveyor({ paths, preset, outputDir = null, quick = false, deps, onStage = () => {}, signal = null }) {
  const detection = await deps.detect(paths);
  const caps = capabilitiesFor(detection.type);
  const plan = planStages(detection.type, preset);
  const stages = plan.map((s) => ({ id: s.id, label: s.label, status: s.run ? "pending" : "skipped", detail: s.run ? "" : s.reason }));
  const report = (id, status, detail = "") => { const s = stages.find((x) => x.id === id); if (s) { s.status = status; s.detail = detail; } onStage({ id, status, detail, stages: stages.map((x) => ({ ...x })) }); };
  if (!caps.supported) return { ok: false, type: detection.type, label: caps.label, stages, error: caps.message, detection };
  if (detection.type === "project") return { ok: false, type: detection.type, label: caps.label, stages, error: "Проект открывается кнопкой «Открыть проект».", detection };
  const target = outputDir || (quick ? quickOutputDir(detection.paths[0]) : null);
  if (!target) throw new Error("Выберите папку для результата.");
  const name = safeAtlasName(path.parse(detection.paths[0]).name);
  let current = null, source = null, cleaned = null, built = null, review = null;
  const abortCheck = () => { if (signal?.aborted) throw new Error("Конвейер отменён."); };
  try {
    current = "cut"; abortCheck();
    if (stages.find((s) => s.id === "cut").status === "pending") report("cut", "running");
    source = await deps.describe(detection);
    if (stages.find((s) => s.id === "cut").status === "running") report("cut", "done", `${source.frameCount ?? source.paths?.length ?? 0} кадров`);
    current = "clean"; abortCheck();
    const cleanRuns = stages.find((s) => s.id === "clean").status === "pending";
    if (cleanRuns) report("clean", "running");
    const options = processorOptions(cleanRuns ? preset : { ...preset, background: "none", edgeCleanup: false }, source.recommendations);
    cleaned = await deps.clean({ source, outputDir: target, name, options, signal });
    if (cleanRuns) report("clean", "done", `${cleaned.frameCount ?? 0} кадров`);
    const framesDir = cleaned.framesDir;
    if (stages.find((s) => s.id === "pack").status === "pending") {
      current = "pack"; abortCheck(); report("pack", "running");
      built = await deps.pack({ name, input: [framesDir], output: path.join(cleaned.outputDir, "atlas"), formats: preset.atlas.formats, padding: preset.atlas.padding, extrude: preset.atlas.extrude, maxSize: preset.atlas.maxSize, powerOfTwo: preset.atlas.powerOfTwo, fps: source.recommendations?.fps || 12 });
      report("pack", "done", `${built.pages?.length ?? 1} стр.`);
    }
    if (built && stages.find((s) => s.id === "check").status === "pending") {
      current = "check"; abortCheck(); report("check", "running");
      review = await deps.check(built, preset);
      report("check", "done", review?.verdictLabel || review?.verdict || "");
    }
    current = "export"; abortCheck(); report("export", "running");
    const exported = await deps.exportResult({ detection, source, cleaned, built, review, preset, quick, outputDir: cleaned.outputDir });
    report("export", "done", exported?.summary || "");
    return { ok: true, type: detection.type, label: caps.label, stages, outputDir: cleaned.outputDir, review, exported, detection };
  } catch (error) {
    report(current, "failed", error.message);
    return { ok: false, type: detection.type, label: caps.label, stages, error: error.message, failedStage: current, detection };
  }
}

// Persistent batch queue: items survive restarts; pause / resume / cancel; summary JSON.
export class ConveyorQueue {
  constructor({ file, run, onChange = () => {} }) { this.file = file; this.run = run; this.onChange = onChange; this.items = []; this.paused = false; this.running = null; this.controller = null; }
  async load() {
    const saved = await readJson(this.file, { items: [], paused: false });
    this.items = (saved.items || []).map((i) => (i.status === "running" ? { ...i, status: "pending", detail: "Прервано, будет повторено" } : i));
    this.paused = Boolean(saved.paused);
    return this.snapshot();
  }
  snapshot() { return { paused: this.paused, running: this.running, items: this.items.map((i) => ({ ...i })) }; }
  async persist() { await writeJsonAtomic(this.file, { paused: this.paused, items: this.items }); this.onChange(this.snapshot()); }
  async add({ paths, presetId, outputDir = null, quick = false, origin = "user" }) {
    if (!Array.isArray(paths) || !paths.length) throw new Error("Нечего добавить в очередь.");
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    this.items.push({ id, paths, presetId, outputDir, quick, origin, status: "pending", detail: "Ожидает", addedAt: new Date().toISOString() });
    await this.persist();
    return id;
  }
  async remove(id) { if (this.running === id) throw new Error("Задание выполняется; сначала отмените его."); this.items = this.items.filter((i) => i.id !== id); await this.persist(); }
  async clearFinished() { this.items = this.items.filter((i) => !["done", "failed", "cancelled"].includes(i.status)); await this.persist(); }
  async pause() { this.paused = true; await this.persist(); }
  async resume() { this.paused = false; await this.persist(); return this.drain(); }
  async cancel(id) {
    const item = this.items.find((i) => i.id === id);
    if (!item) return false;
    if (this.running === id) this.controller?.abort();
    else if (item.status === "pending") { item.status = "cancelled"; item.detail = "Отменено"; await this.persist(); }
    return true;
  }
  async drain() {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      for (;;) {
        if (this.paused) break;
        const item = this.items.find((i) => i.status === "pending");
        if (!item) break;
        this.running = item.id; this.controller = new AbortController();
        item.status = "running"; item.detail = "Выполняется"; await this.persist();
        try {
          const result = await this.run(item, { signal: this.controller.signal, onStage: (s) => { item.detail = `${s.stages.find((x) => x.status === "running")?.label || ""}`.trim() || item.detail; this.onChange(this.snapshot()); } });
          item.status = this.controller.signal.aborted ? "cancelled" : result.ok ? "done" : "failed";
          item.detail = item.status === "done" ? (result.review?.verdictLabel || "Готово") : item.status === "cancelled" ? "Отменено" : result.error;
          item.outputDir = result.outputDir || item.outputDir;
        } catch (error) { item.status = this.controller.signal.aborted ? "cancelled" : "failed"; item.detail = error.message; }
        item.finishedAt = new Date().toISOString();
        this.running = null; this.controller = null; await this.persist();
      }
    })().finally(() => { this.draining = null; });
    return this.draining;
  }
  summary() {
    const count = (s) => this.items.filter((i) => i.status === s).length;
    return { generatedAt: new Date().toISOString(), total: this.items.length, done: count("done"), failed: count("failed"), cancelled: count("cancelled"), pending: count("pending"), items: this.items.map(({ id, paths, status, detail, outputDir }) => ({ id, paths, status, detail, outputDir })) };
  }
}

// Watch folder: polls, waits until a file's size and mtime are stable for `stableChecks`
// polls (so half-written files are never processed), ignores output folders and files
// already handled, then reports new files. Uses polling because fs.watch is unreliable on
// network drives and for some editors' save patterns.
export function createFolderWatcher({ dir, onFiles, intervalMs = 1000, stableChecks = 2, ignore = [], accept = () => true, fsImpl = fs, timers = { setInterval, clearInterval } }) {
  const root = path.resolve(dir);
  const ignored = ignore.map((p) => path.resolve(p));
  const seen = new Map(); const handled = new Set(); let timer = null, busy = false;
  const isIgnored = (file) => ignored.some((p) => file === p || file.startsWith(p + path.sep)) || /-spritelab([\\/]|$)/.test(file);
  async function tick() {
    if (busy) return; busy = true;
    try {
      const names = await fsImpl.readdir(root, { withFileTypes: true });
      const ready = [];
      for (const entry of names) {
        if (!entry.isFile()) continue;
        const file = path.join(root, entry.name);
        if (handled.has(file) || isIgnored(file) || entry.name.startsWith(".") || /\.(tmp|part|crdownload)$/i.test(entry.name) || !accept(file)) continue;
        let stat; try { stat = await fsImpl.stat(file); } catch { continue; }
        const key = `${stat.size}:${stat.mtimeMs}`;
        const prev = seen.get(file);
        if (prev?.key === key) { prev.count += 1; if (prev.count >= stableChecks && stat.size > 0) { handled.add(file); seen.delete(file); ready.push(file); } }
        else seen.set(file, { key, count: 0 });
      }
      if (ready.length) await onFiles(ready);
    } catch { /* folder temporarily unavailable */ } finally { busy = false; }
  }
  return {
    dir: root,
    async primeExisting() { for (const entry of await fsImpl.readdir(root, { withFileTypes: true })) if (entry.isFile()) handled.add(path.join(root, entry.name)); },
    start() { if (!timer) timer = timers.setInterval(tick, intervalMs); return this; },
    stop() { if (timer) timers.clearInterval(timer); timer = null; },
    tick,
    get running() { return Boolean(timer); },
  };
}

async function readJson(file, fallback) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; } }
export async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tmp, file);
}
