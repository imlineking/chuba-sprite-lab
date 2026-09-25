#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { processAnimationSet, processSprites, processVideoBatch, safeName } from "../src/processor.mjs";
import { collectAtlasErrors } from "../src/atlas-inspector.mjs";
import { loadProfileFile } from "../src/build-profile.mjs";
import { describePaths, describeSpriteSheet, describeVideoBatch } from "../src/source-describe.mjs";
import { watchSources } from "../src/watch.mjs";

// Command line entry point. It reuses the same processor and the same source
// description as the desktop window, so a profile built here and a profile built in
// the window produce the same atlas.
//
// Exit codes: 0 success, 1 usage, profile or naming problem, 2 build failure,
// 3 the finished atlas failed the strict check.

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");

const usage = `Chuba Sprite Lab — сборка без интерфейса

  node scripts/cli.mjs --profile <профиль.json> [опции]

Опции:
  --profile <файл>   профиль сборки (обязательно)
  --output <папка>   переопределить папку назначения
  --name <имя>       переопределить имя набора
  --models <папка>   папка установленных ONNX-моделей для ИИ-этапов
  --clean            заменить файлы уже существующего набора
  --version          сохранить как новую версию (имя-2, имя-3, …)
  --strict           вернуть код 3, если инспектор нашёл ошибки атласа
  --watch            пересобирать набор при изменении исходников (Ctrl+C — выход)
  --dry-run          только проверить профиль и описать источник
  --json             машиночитаемый результат в stdout (при --watch — по одной записи на сборку)
  --help             эта справка

Коды выхода: 0 успех, 1 ошибка профиля или использования, 2 сбой сборки,
3 набор собран, но не прошёл проверку --strict.

Если папка набора уже существует, укажите --clean или --version: молчаливая
перезапись оставила бы файлы предыдущего, более крупного набора.
`;

class UsageError extends Error {}

function parseArgs(argv) {
  const args = { profile: null, output: null, name: null, models: null, clean: false, version: false, strict: false, watch: false, dryRun: false, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") args.help = true;
    else if (value === "--clean") args.clean = true;
    else if (value === "--version") args.version = true;
    else if (value === "--strict") args.strict = true;
    else if (value === "--watch") args.watch = true;
    else if (value === "--dry-run") args.dryRun = true;
    else if (value === "--json") args.json = true;
    else if (value === "--profile" || value === "--output" || value === "--name" || value === "--models") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new UsageError(`Опция ${value} требует значение.`);
      if (value === "--profile") args.profile = next;
      if (value === "--output") args.output = next;
      if (value === "--name") args.name = next;
      if (value === "--models") args.models = next;
      index += 1;
    } else throw new UsageError(`Неизвестная опция: ${value}`);
  }
  if (args.clean && args.version) throw new UsageError("Опции --clean и --version несовместимы.");
  return args;
}

async function pathExists(candidate) {
  try { await fs.access(candidate); return true; } catch { return false; }
}

// The desktop window asks the user what to do about an existing set. The command line
// cannot ask, so it refuses to guess.
async function resolveTargetName(outputRoot, requestedName, { clean, version }) {
  const base = safeName(requestedName);
  const target = path.join(outputRoot, base);
  const occupied = await pathExists(target) && (await fs.readdir(target)).length > 0;
  if (!occupied) return { name: base, cleanOutput: Boolean(clean) };
  if (clean) return { name: base, cleanOutput: true };
  if (version) {
    let index = 2;
    while (await pathExists(path.join(outputRoot, `${base}-${index}`))) index += 1;
    return { name: `${base}-${index}`, cleanOutput: false };
  }
  throw new UsageError(`Папка ${target} уже существует. Используйте --clean (заменить файлы набора) или --version (сохранить как новую версию).`);
}

async function describeSource(source) {
  if (source.kind === "sheet") return describeSpriteSheet(appRoot, source.sheetPath, source.sheetOptions || { mode: "objects" });
  if (source.kind === "video") return source.paths.length > 1 ? describeVideoBatch(appRoot, source.paths) : describePaths(appRoot, "video", source.paths);
  return describePaths(appRoot, "frames", source.paths);
}

function progressToStderr(progress) {
  if (!progress?.message) return;
  const percent = Number.isFinite(Number(progress.value)) ? `${Math.round(Number(progress.value) * 100)}% ` : "";
  process.stderr.write(`${percent}${progress.message}\n`);
}

function isVideoBatch(animations) {
  return animations.length === 1 && animations[0].source.kind === "video" && animations[0].source.paths.length > 1;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage}`);
    return 1;
  }
  if (args.help) {
    process.stdout.write(usage);
    return 0;
  }
  if (!args.profile) {
    process.stderr.write(`Укажите --profile <файл>.\n\n${usage}`);
    return 1;
  }

  let loaded;
  try {
    loaded = await loadProfileFile(args.profile);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  const { profile } = loaded;
  const requestedOutput = args.output ? path.resolve(args.output) : profile.outputDir || null;
  const name = args.name || profile.name;
  const modelDirs = args.models ? [path.resolve(args.models)] : [];
  const emit = (payload) => process.stdout.write(args.json ? `${JSON.stringify(payload, null, 2)}\n` : "");

  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once("SIGINT", onInterrupt);

  // Once a watch run has picked its folder, later rebuilds replace that set in place
  // instead of asking for a new name on every change.
  let settledTarget = null;

  const buildBatch = async () => {
    const batch = profile.animations[0];
    if (!requestedOutput) throw new UsageError("Для пакета видео укажите outputDir в профиле или --output.");
    if (args.dryRun) {
      const summary = {
        ok: true, dryRun: true, profile: loaded.path, name, outputDir: requestedOutput, batch: true,
        sources: [{ name: batch.name, kind: "video-batch", files: batch.source.paths.length, title: `${batch.source.paths.length} видео`, detail: `${batch.source.paths.length} роликов` }],
      };
      if (args.json) emit(summary);
      else process.stdout.write(`Профиль корректен.\nПакет видео: ${batch.source.paths.length} ролик(ов) → ${requestedOutput}\n`);
      return 0;
    }
    const result = await processVideoBatch({
      paths: batch.source.paths, outputDir: requestedOutput, options: { ...batch.options, aiModelDirs: modelDirs },
      appRoot, onProgress: args.json ? undefined : progressToStderr, signal: controller.signal,
    });
    const summary = {
      ok: true, profile: loaded.path, batch: true, name, outputDir: result.outputDir,
      total: result.total, completed: result.completed, failed: result.failed, stopped: result.stopped,
      failures: result.failures, sets: result.results.map((item) => ({ name: item.name, outputDir: item.outputDir, manifest: item.manifestPath, warnings: item.warnings })),
    };
    if (args.strict) {
      const blocking = [];
      for (const set of result.results) {
        const report = await fs.readFile(set.reportPath, "utf8").then(JSON.parse).catch(() => null);
        for (const issue of collectAtlasErrors(report)) blocking.push({ ...issue, set: set.name });
      }
      if (blocking.length) {
        summary.ok = false;
        summary.atlasErrors = blocking;
        if (args.json) emit(summary);
        else process.stdout.write(`Пакет собран, но проверка не пройдена:\n${blocking.map((issue) => `· ${issue.set}: ${issue.message}`).join("\n")}\n`);
        return 3;
      }
    }
    if (args.json) emit(summary);
    else process.stdout.write(`Готово: ${result.completed}/${result.total} видео\n  папка: ${result.outputDir}\n${result.failed ? `  ошибок: ${result.failed}\n` : ""}`);
    return 0;
  };

  const buildSingle = async () => {
    const animations = [];
    for (const animation of profile.animations) {
      const source = await describeSource(animation.source);
      if (!source) throw new UsageError(`Источник анимации «${animation.name}» пуст.`);
      animations.push({ name: animation.name, source, options: animation.options });
    }

    if (args.dryRun) {
      const summary = {
        ok: true, dryRun: true, profile: loaded.path, name, outputDir: requestedOutput,
        sources: animations.map((animation) => ({
          name: animation.name, kind: animation.source.kind,
          frames: animation.source.estimatedFrames || animation.source.paths.length,
          title: animation.source.title, detail: animation.source.detail,
        })),
      };
      if (args.json) emit(summary);
      else process.stdout.write(`Профиль корректен.\nНабор «${name}», анимаций: ${animations.length}\n${summary.sources.map((item) => `· ${item.name}: ${item.kind}, ${item.frames} кадр(ов) — ${item.detail}`).join("\n")}\n`);
      return 0;
    }

    const outputRoot = requestedOutput || path.dirname(animations[0].source.paths[0]);
    const target = settledTarget || await resolveTargetName(outputRoot, name, args);
    const withClean = (options) => ({ ...options, aiModelDirs: modelDirs, cleanOutput: target.cleanOutput });

    const request = { outputDir: outputRoot, name: target.name, appRoot, options: withClean(profile.options), onProgress: args.json ? undefined : progressToStderr, signal: controller.signal };
    const result = animations.length > 1
      ? await processAnimationSet({ ...request, animations: animations.map((animation) => ({ ...animation, options: withClean(animation.options) })) })
      : await processSprites({ ...request, source: animations[0].source, options: withClean(animations[0].options) });
    settledTarget = { name: result.name, cleanOutput: true };

    const summary = {
      ok: true, profile: loaded.path, name: result.name, outputDir: result.outputDir,
      sheets: result.sheetPaths || [],
      manifest: result.manifestPath, report: result.reportPath,
      frames: result.framePaths || [], preview: result.previewPath,
      engineFiles: result.engineFiles || [],
      frameCount: result.frameCount, atlas: result.atlas,
      warnings: result.warnings || [],
    };

    if (args.strict) {
      const report = await fs.readFile(result.reportPath, "utf8").then(JSON.parse).catch(() => null);
      const blocking = collectAtlasErrors(report);
      if (blocking.length) {
        summary.ok = false;
        summary.atlasErrors = blocking;
        if (args.json) emit(summary);
        else process.stdout.write(`Набор собран, но проверка не пройдена:\n${blocking.map((issue) => `· ${issue.message}`).join("\n")}\n`);
        return 3;
      }
    }

    if (args.json) emit(summary);
    else process.stdout.write(`Готово: ${result.name}\n  кадров: ${result.frameCount}\n  лист: ${(result.sheetPaths || []).join(", ") || "—"}\n  манифест: ${result.manifestPath || "—"}\n  папка: ${result.outputDir}\n${(result.warnings || []).length ? `  предупреждений: ${result.warnings.length}\n` : ""}`);
    return 0;
  };

  try {
    // A batch of videos is handled before any source descriptor is built, because it
    // produces one set per file rather than one animation.
    if (isVideoBatch(profile.animations)) return await buildBatch();

    const code = await buildSingle();
    if (!args.watch || args.dryRun || code !== 0) return code;

    const sources = [...new Set(profile.animations.flatMap((animation) => animation.source.paths))];
    process.stderr.write(`Наблюдение за ${sources.length} файл(ами). Ctrl+C — выход.\n`);
    await watchSources(sources, {
      signal: controller.signal,
      onChange: async () => {
        process.stderr.write("Источник изменился — собираю заново…\n");
        try {
          await buildSingle();
        } catch (error) {
          process.stderr.write(`Ошибка пересборки: ${error?.message || error}\n`);
        }
      },
    });
    return 0;
  } catch (error) {
    const message = error?.message || String(error);
    if (error instanceof UsageError) {
      process.stderr.write(args.json ? `${JSON.stringify({ ok: false, profile: loaded.path, error: message }, null, 2)}\n` : `${message}\n`);
      return 1;
    }
    if (args.json) process.stdout.write(`${JSON.stringify({ ok: false, profile: loaded.path, error: message }, null, 2)}\n`);
    else process.stderr.write(`Ошибка сборки: ${message}\n`);
    return 2;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
}

process.exitCode = await main();
