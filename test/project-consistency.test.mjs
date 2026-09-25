import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

// Static checks across the shipped files. They are the same kind of guard as the element-id test:
// cheap, and they catch the drift that no unit test can see — a version bumped in one file only, an
// interface that calls a bridge method which was renamed, or a bridge method nobody calls any more.

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");

const rendererFiles = ["i18n.js", "renderer.js", "studio.js", "sheet-editor.js", "frame-consistency.js", "copilot.js", "sprite-editor.js", "auto-pilot.js", "task-mode.js"];
const rendererSource = rendererFiles.map((file) => read(path.join("src", file))).join("\n");
const preloadSource = read("src/preload.cjs");
const htmlSource = read("src/index.html");

test("the version is the same in the package, the report and the window", () => {
  const packageVersion = JSON.parse(read("package.json")).version;
  const processorVersion = /const APP_VERSION = "([^"]+)"/.exec(read("src/processor.mjs"));
  assert.ok(processorVersion, "APP_VERSION не найден в processor.mjs");
  assert.equal(processorVersion[1], packageVersion, "версия в отчёте отличается от версии пакета");
  // The placeholders in the markup are replaced at start-up, but a stale number there would show for a
  // moment and would mislead anyone reading the file.
  const placeholders = [...htmlSource.matchAll(/>(\d+\.\d+\.\d+)</g)].map((match) => match[1]);
  assert.ok(placeholders.length >= 2, "ожидались номер в заголовке и в карточке «О программе»");
  for (const placeholder of placeholders) assert.equal(placeholder, packageVersion, `устаревший номер в разметке: ${placeholder}`);
});

test("every bridge method the window calls exists in the preload", () => {
  const declared = new Set([...preloadSource.matchAll(/^\s{2}([A-Za-z_$][\w$]*):/gm)].map((match) => match[1]));
  assert.ok(declared.size > 20, `в preload найдено только ${declared.size} методов`);
  const used = new Set([...rendererSource.matchAll(/window\.spriteLab\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]));
  const missing = [...used].filter((name) => !declared.has(name));
  assert.deepEqual(missing, [], "интерфейс вызывает методы, которых нет в мосте");
});

test("every bridge method is used somewhere, so no dead surface is left behind", () => {
  const declared = [...preloadSource.matchAll(/^\s{2}([A-Za-z_$][\w$]*):/gm)].map((match) => match[1]);
  // Some methods are reached by name through a variable — the source pickers all go through
  // chooseSource("chooseSheet") — so a quoted name counts as used as well.
  const used = new Set([
    ...[...rendererSource.matchAll(/window\.spriteLab\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]),
    ...[...rendererSource.matchAll(/["'`]([A-Za-z_$][\w$]*)["'`]/g)].map((match) => match[1]),
  ]);
  const unused = declared.filter((name) => !used.has(name));
  assert.deepEqual(unused, [], "в мосте есть методы, которые никто не вызывает");
});

test("an IPC channel registered in the main process is reachable from the preload", () => {
  const mainSource = read("src/main.mjs");
  const channels = new Set([...mainSource.matchAll(/ipcMain\.handle\("([^"]+)"/g)].map((match) => match[1]));
  const invoked = new Set([...preloadSource.matchAll(/ipcRenderer\.invoke\("([^"]+)"/g)].map((match) => match[1]));
  const orphaned = [...channels].filter((channel) => !invoked.has(channel));
  assert.deepEqual(orphaned, [], "канал зарегистрирован, но вызвать его из окна нечем");
  const unknown = [...invoked].filter((channel) => !channels.has(channel));
  assert.deepEqual(unknown, [], "мост вызывает канал, которого нет в главном процессе");
});

test("the shipped stylesheets are all linked and all linked files exist", () => {
  const linked = [...htmlSource.matchAll(/<link rel="stylesheet" href="\.\/([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(linked.sort(), ["copilot.css", "editor.css", "styles.css", "theme.css"]);
  const scripts = [...htmlSource.matchAll(/<script src="\.\/([^"]+)"/g)].map((match) => match[1]);
  for (const file of [...linked, ...scripts]) assert.ok(read(path.join("src", file)).length > 0, `${file} не читается`);
  // Theme applies before first paint. The remaining scripts share renderer globals.
  assert.equal(scripts[0], "theme.js");
  assert.equal(scripts[1], "i18n.js");
  assert.equal(scripts[2], "renderer.js");
});
