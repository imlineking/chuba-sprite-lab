#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildAtlas, defaults, listImages, resolveConfig } from "../src/pipeline/build.mjs";
import { formats } from "../src/pipeline/exporters.mjs";
import { fingerprint } from "../src/watch.mjs";
import { reviewAtlas, verdictLabel } from "../src/critic/critic.mjs";
import { EmbeddedRuntime, defaultLockFile, readLock, pidAlive, stopLockedServer } from "../src/critic/llm-runtime.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Simple atlas builder: a folder of PNG/JPEG/BMP/GIF/WebP in, a packed atlas plus
// engine files out. Works with no preset at all (sensible defaults), with one preset,
// or with many presets in one command (batch). Exit codes: 0 ok, 1 usage, 2 build failure.

const usage = `Chuba Sprite Lab — атлас из папки картинок

  node scripts/atlas.mjs build [пресет.json ...] [опции]
  node scripts/atlas.mjs review [пресет.json ...] [опции]  приёмка: review.json рядом с экспортом
  node scripts/atlas.mjs init [пресет.json]       создать пресет с настройками по умолчанию
  node scripts/atlas.mjs formats                   список форматов экспорта
  node scripts/atlas.mjs model status|stop         общий сервер модели (GUI и CLI)

Опции build (переопределяют пресет):
  --input <папка|файл>   источник (можно несколько раз)
  --output <папка>       куда писать атлас
  --name <имя>           имя атласа
  --format <a,b,...>     форматы: ${formats.join(", ")}
  --max-size <px>        максимальный размер страницы (по умолчанию ${defaults.maxSize})
  --padding <px> --extrude <px>
  --rotate / --no-rotate, --pot / --no-pot, --no-trim, --no-dedupe
  --background <auto|#rrggbb>   фон в прозрачность (автоопределение или цветовой ключ)
  --tolerance <0-255>
  --grid <колонки>x<строки>     нарезать листы сеткой;  --auto-slice  нарезать по островам
  --pivot <x,y>          опора 0..1 (по умолчанию 0.5,0.5)
  --fps <n>
  --watch                пересобирать при изменениях (Ctrl+C — выход)
  --json                 машиночитаемый итог
  --review               после сборки — приёмка (алгоритмы + встроенная Qwen), review.json
  --no-model             приёмка только алгоритмами (лёгкий режим)
  --keep-model           не выгружать модель после выхода (сервер общий с GUI,
                         сам выгружает веса после 10 минут простоя; model stop — остановить)
  --quiet                только итоговые строки (без списка замечаний)
`;

function parseArgs(argv) {
  const args = { command: argv[0] ?? "help", presets: [], overrides: {}, watch: false, json: false, review: argv[0] === "review", useModel: true, keepModel: false, quiet: false };
  const value = (i) => { const next = argv[i + 1]; if (next === undefined || next.startsWith("--")) throw Object.assign(new Error(`Опция ${argv[i]} требует значение`), { usage: true }); return next; };
  const int = (i) => { const n = Number(value(i)); if (!Number.isInteger(n) || n < 0) throw Object.assign(new Error(`${argv[i]}: нужно целое число`), { usage: true }); return n; };
  const o = args.overrides;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--input": (o.input ||= []).push(value(i)); i += 1; break;
      case "--output": o.output = value(i); i += 1; break;
      case "--name": o.name = value(i); i += 1; break;
      case "--format": o.formats = value(i).split(",").map((s) => s.trim()).filter(Boolean); i += 1; break;
      case "--max-size": o.maxSize = int(i); i += 1; break;
      case "--padding": o.padding = int(i); i += 1; break;
      case "--extrude": o.extrude = int(i); i += 1; break;
      case "--fps": o.fps = int(i); i += 1; break;
      case "--tolerance": o.tolerance = int(i); i += 1; break;
      case "--rotate": o.rotate = true; break;
      case "--no-rotate": o.rotate = false; break;
      case "--pot": o.powerOfTwo = true; break;
      case "--no-pot": o.powerOfTwo = false; break;
      case "--no-trim": o.trim = false; break;
      case "--no-dedupe": o.deduplicate = false; break;
      case "--auto-slice": o.slice = { mode: "auto" }; break;
      case "--grid": { const m = /^(\d+)x(\d+)$/.exec(value(i)); if (!m) throw Object.assign(new Error("--grid ожидает вид 4x2"), { usage: true }); o.slice = { mode: "grid", cols: +m[1], rows: +m[2] }; i += 1; break; }
      case "--background": { const v = value(i); o.background = v === "auto" ? { mode: "auto" } : v === "none" ? "none" : { mode: "key", color: v }; i += 1; break; }
      case "--pivot": { const [x, y] = value(i).split(",").map(Number); if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) throw Object.assign(new Error("--pivot ожидает x,y в диапазоне 0..1"), { usage: true }); o.pivot = { x, y }; i += 1; break; }
      case "--watch": args.watch = true; break;
      case "--json": args.json = true; break;
      case "--review": args.review = true; break;
      case "--no-model": args.useModel = false; break;
      case "--keep-model": args.keepModel = true; break;
      case "--quiet": args.quiet = true; break;
      case "--help": case "-h": args.command = "help"; break;
      default:
        if (arg.startsWith("--")) throw Object.assign(new Error(`Неизвестная опция ${arg}`), { usage: true });
        args.presets.push(arg);
    }
  }
  if (o.tolerance !== undefined && typeof o.background === "object") { o.background.tolerance = o.tolerance; }
  delete o.tolerance;
  return args;
}

/** A preset file holds one build object, or { builds: [ ... ] } for batch builds. */
export async function loadPresets(files) {
  if (!files.length) return [{ raw: {}, baseDir: process.cwd(), source: "(по умолчанию)" }];
  const result = [];
  for (const file of files) {
    const full = path.resolve(file);
    let data;
    try { data = JSON.parse(await fs.readFile(full, "utf8")); } catch (error) { throw Object.assign(new Error(`Пресет ${file}: ${error.message}`), { usage: true }); }
    const builds = Array.isArray(data.builds) ? data.builds.map((build) => ({ ...data, ...build, builds: undefined })) : [data];
    for (const raw of builds) { delete raw.builds; delete raw.$schema; result.push({ raw, baseDir: path.dirname(full), source: file }); }
  }
  return result;
}

// One shared llama-server per machine (lock file): attach to the GUI's or a kept server,
// otherwise start one. A server this process did not start is never stopped here.
let runtime = null;
let runtimeOptions = { keepAlive: false };
async function review(preset, overrides, built, buildError, useModel) {
  if (useModel && !runtime) runtime = new EmbeddedRuntime({ appRoot, shared: true, keepAlive: runtimeOptions.keepAlive });
  const usable = useModel && runtime.status().available;
  const report = await reviewAtlas(built || { atlas: null, pages: [] }, { runtime: usable ? runtime : null, skillsDir: runtime?.paths.skills, buildError, useModel: usable });
  if (useModel && !usable) report.fallbackReason = `Встроенная модель недоступна (${runtime.status().missing.join(", ")}), только алгоритмы`;
  const config = built?.config || resolveConfig({ ...preset.raw, ...overrides }, preset.baseDir);
  await fs.mkdir(config.output, { recursive: true });
  const file = path.join(config.output, "review.json");
  await fs.writeFile(file, `${JSON.stringify({ generatedAt: new Date().toISOString(), atlas: config.name, ...report }, null, 2)}\n`);
  return { report, file };
}

async function runOnce(presets, overrides, json, options = {}) {
  let failed = 0;
  for (const preset of presets) {
    const started = Date.now();
    let built = null, buildError = null;
    try {
      built = await buildAtlas({ ...preset.raw, ...overrides }, { baseDir: preset.baseDir, write: options.write !== false });
      const { config, stats } = built;
      const summary = { ok: true, preset: preset.source, name: config.name, output: config.output, ...stats, ms: Date.now() - started };
      if (options.write !== false) console.log(json ? JSON.stringify(summary) : `OK ${config.name}: ${stats.frames} кадров (${stats.duplicates} дублей), страниц ${stats.pages}, заполнение ${stats.fill}% -> ${config.output}`);
    } catch (error) {
      failed += 1; buildError = error.message;
      console.error(json ? JSON.stringify({ ok: false, preset: preset.source, error: error.message }) : `ОШИБКА ${preset.source}: ${error.message}`);
    }
    if (options.review) {
      const { report, file } = await review(preset, overrides, built, buildError, options.useModel);
      if (report.verdict !== "accepted") failed += buildError ? 0 : 1;
      console.log(json ? JSON.stringify({ review: file, verdict: report.verdict, score: report.score, mode: report.mode, issues: report.issues.length, ms: report.elapsedMs })
        : `ПРИЁМКА ${verdictLabel(report.verdict)} · ${report.score}/100 · ${report.mode === "qwen" ? "алгоритмы + Qwen" : "только алгоритмы"} · проблем ${report.issues.length} -> ${file}${report.fallbackReason ? ` (${report.fallbackReason})` : ""}`);
      for (const item of report.issues) if (!json && !options.quiet) console.log(`  [${item.severity}] ${item.reason}${item.fix ? ` → ${JSON.stringify(item.fix)}` : ""}`);
    }
  }
  return failed;
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try { args = parseArgs(argv); } catch (error) { console.error(error.message); console.error(usage); return 1; }
  if (args.command === "help") { console.log(usage); return 0; }
  if (args.command === "formats") { console.log(formats.join("\n")); return 0; }
  if (args.command === "init") {
    const target = path.resolve(args.presets[0] ?? "atlas.preset.json");
    try { await fs.access(target); console.error(`Файл уже существует: ${target}`); return 1; } catch { /* free */ }
    await fs.writeFile(target, `${JSON.stringify({ ...defaults, tags: { "*": [] } }, null, 2)}\n`, { flag: "wx" });
    console.log(`Создан пресет ${target}`);
    return 0;
  }
  if (args.command === "model") {
    const action = args.presets[0] ?? "status";
    const file = defaultLockFile();
    if (action === "stop") { const pid = await stopLockedServer(file); console.log(pid ? `Сервер модели остановлен (pid ${pid})` : "Сервер модели не запущен"); return 0; }
    if (action !== "status") { console.error(`Неизвестное действие model ${action}`); return 1; }
    const lock = readLock(file);
    const live = lock && pidAlive(lock.pid);
    console.log(args.json ? JSON.stringify({ running: Boolean(live), ...(lock || {}), lockFile: file }) : live ? `Сервер модели: ${lock.model}, pid ${lock.pid}, порт ${lock.port}, ${lock.backend}` : "Сервер модели не запущен");
    return 0;
  }
  if (args.command !== "build" && args.command !== "review") { console.error(`Неизвестная команда ${args.command}`); console.error(usage); return 1; }
  let presets;
  try { presets = await loadPresets(args.presets); } catch (error) { console.error(error.message); return 1; }
  runtimeOptions = { keepAlive: args.keepModel };
  const options = { review: args.review, useModel: args.useModel, write: args.command === "build", quiet: args.quiet };
  const failed = await runOnce(presets, args.overrides, args.json, options);
  if (!args.watch) { runtime?.stop(); return failed ? 2 : 0; }
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  const sources = [], outputs = [];
  for (const preset of presets) {
    const config = resolveConfig({ ...preset.raw, ...args.overrides }, preset.baseDir);
    sources.push(...config.input); outputs.push(config.output);
  }
  // Polling (not fs.watch) for the same reason as src/watch.mjs: network and removable
  // drives. The folders are part of the fingerprint, so added/removed files count too.
  const snapshot = async () => fingerprint([...sources, ...(await listImages(sources, { output: outputs }).catch(() => [])).map((entry) => entry.file)]);
  console.log("Слежение за изменениями, Ctrl+C — выход");
  let previous = await snapshot();
  while (!controller.signal.aborted) {
    await new Promise((resolve) => { const timer = setTimeout(resolve, 1000); controller.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); });
    if (controller.signal.aborted) break;
    const current = await snapshot();
    if (current === previous) continue;
    previous = current;
    await runOnce(presets, args.overrides, args.json, options);
  }
  runtime?.stop();
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await main();
