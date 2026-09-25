// Interface language.
//
// Russian is the source language: the text in the markup and in the scripts *is* the key. The
// dictionary therefore maps a finished Russian string to its translation, and anything missing stays
// Russian instead of showing a raw key. Adding a language means adding one object here or one line to
// an existing one — no markup changes, and nothing can be half-translated by accident.
//
// Switching works in both directions by swapping matched strings: to Russian through the reverse of
// the dictionary, then to the target. The dictionary must therefore stay unambiguous (no two keys
// with the same translation), which the tests check.
//
// This file is a classic script and runs before renderer.js, so it cannot use the helpers defined
// there.

const i18nSources = {
  en: {
    /* window and workflow */
    "Новый": "New",
    "Открыть проект": "Open project",
    "Сохранить": "Save",
    "Отменить действие": "Undo the action",
    "Повторить действие": "Redo the action",
    "Открыть список команд": "Open the command list",
    "Команды": "Commands",
    "О программе": "About",
    "Свернуть": "Minimize",
    "Развернуть": "Maximize",
    "Закрыть": "Close",
    "Этапы работы": "Workflow steps",
    "Источник": "Source",
    "Обработка": "Processing",
    "Экспорт": "Export",
    "Новый проект: добавьте видео, кадры или откройте файл .cslab": "New project: add a video or frames, or open a .cslab file",
    "Удалите фон, выровняйте и проверьте кадры": "Remove the background, align the frames and check them",
    "Сохраните спрайт-лист, кадры и данные для игры": "Save the sprite sheet, the frames and the game data",

    /* import */
    "ИМПОРТ": "IMPORT",
    "Добавьте движение": "Add motion",
    "Видео или последовательность кадров. Всё обрабатывается только на этом компьютере.":
      "A video or a frame sequence. Everything is processed on this computer only.",
    "Незавершённая сессия найдена": "Unfinished session found",
    "Можно продолжить с теми же исходниками и настройками.": "You can continue with the same sources and settings.",
    "Продолжить": "Continue",
    "Не сейчас": "Not now",
    "Выбрать видео, изображения или папку с кадрами": "Choose a video, images or a folder of frames",
    "Перетащите файл или папку": "Drop a file or a folder",
    "Добавить файлы": "Add files",
    "Папка с кадрами": "Folder of frames",
    "Разобрать спрайт-лист": "Split a sprite sheet",
    "умно найдёт объекты сложной формы": "finds irregular objects on its own",

    /* frames and editors */
    "Длительность": "Duration",
    "Дублировать": "Duplicate",
    "Исключить кадр": "Exclude frame",
    "Редактировать кадр": "Edit frame",
    "Пиксельный редактор": "Pixel editor",
    "Доработайте один кадр": "Touch up a single frame",
    "Сохранить кадр": "Save frame",
    "Открыть": "Open",
    "Открыть с помощью…": "Open with…",
    "Карандаш": "Pencil",
    "Ластик": "Eraser",
    "Заливка": "Fill",
    "Пипетка": "Eyedropper",
    "Кисть": "Brush",
    "Цвет": "Colour",
    "Разброс": "Tolerance",
    "Стереть кайму": "Erase fringe",
    "Вписать": "Fit",
    "Отменить": "Undo",
    "Вернуть": "Redo",
    "Сетка": "Grid",
    "Цвета кадра": "Frame colours",
    "Слои": "Layers",
    "Подсказка": "Tip",
    "Кадр": "Frame",
    "Кадр {number} изменён в пиксельном редакторе": "Frame {number} edited in the pixel editor",
    "Кадр {number} изменён в пиксельном редакторе · пересоберите анимацию":
      "Frame {number} edited in the pixel editor · rebuild the animation",
    "Откройте кадр из полосы кадров.": "Open a frame from the filmstrip.",

    /* about */
    "Язык интерфейса": "Interface language",
    "О ПРОГРАММЕ": "ABOUT",
    "Версия": "Version",
    "Автор и правообладатель": "Author and rights holder",
    "Год": "Year",
    "Технологии": "Built with",
    "Горячие клавиши": "Keyboard shortcuts",
    "Проверить обновления": "Check for updates",
    "Обновления устанавливаются из официальных GitHub Releases с проверкой SHA-256.":
      "Updates are installed from the official GitHub Releases with SHA-256 verification.",
  },
};

const i18nAttributes = ["title", "placeholder", "aria-label", "data-help", "alt"];
const i18nSkipTags = new Set(["SCRIPT", "STYLE", "KBD", "CODE", "TEXTAREA"]);
const i18nState = { locale: "ru", observer: null };
const i18nReverseCache = new Map();

function i18nLocales() {
  return ["ru", ...Object.keys(i18nSources)];
}

function i18nDictionary(locale) {
  return i18nSources[locale] || null;
}

// A translation must map back to exactly one source string, otherwise switching back would be a
// guess. The map is the dictionary read the other way round.
function i18nReverseDictionary(locale) {
  if (!i18nReverseCache.has(locale)) {
    const reversed = Object.create(null);
    for (const [source, translated] of Object.entries(i18nDictionary(locale) || {})) {
      if (!(translated in reversed)) reversed[translated] = source;
    }
    i18nReverseCache.set(locale, reversed);
  }
  return i18nReverseCache.get(locale);
}

// Turns one visible string from `from` into `to`. Surrounding whitespace is kept, because inline
// markup leaves meaningful spaces around a label.
function i18nSwap(text, map) {
  if (!map || typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const replacement = map[trimmed];
  if (typeof replacement !== "string") return null;
  if (replacement === trimmed) return null;
  return text.replace(trimmed, replacement);
}

function i18nMapFor(from, to) {
  if (from === to) return null;
  if (to === "ru") return i18nReverseDictionary(from);
  return i18nDictionary(to);
}

// Translates an arbitrary string at the call site. The Russian text stays in the code as the key, so
// a missing translation is simply the source text.
function t(source, replacements = null) {
  if (typeof source !== "string") return source;
  const map = i18nMapFor("ru", i18nState.locale);
  let result = (map && map[source]) || source;
  if (replacements) {
    for (const [name, value] of Object.entries(replacements)) result = result.split(`{${name}}`).join(String(value));
  }
  return result;
}

function i18nTextNodes(root) {
  const nodes = [];
  const visit = (node) => {
    if (!node) return;
    if (node.nodeType === 3) { nodes.push(node); return; }
    if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
    if (node.tagName && (i18nSkipTags.has(node.tagName) || node.hasAttribute?.("data-i18n-skip"))) return;
    for (const child of node.childNodes || []) visit(child);
  };
  visit(root);
  return nodes;
}

function i18nSwapTree(root, map) {
  if (!map || !root) return 0;
  let changed = 0;
  for (const node of i18nTextNodes(root)) {
    const next = i18nSwap(node.textContent, map);
    if (next == null) continue;
    node.textContent = next;
    changed += 1;
  }
  for (const element of root.querySelectorAll?.("*") || []) {
    for (const attribute of i18nAttributes) {
      const value = element.getAttribute(attribute);
      const next = i18nSwap(value, map);
      if (next == null) continue;
      element.setAttribute(attribute, next);
      changed += 1;
    }
  }
  return changed;
}

// The interface rebuilds most of its markup while working, so translated windows keep translating
// whatever appears next. Nothing is observed in Russian: there is nothing to do.
function i18nObserve() {
  const wanted = i18nState.locale !== "ru";
  if (wanted && !i18nState.observer && typeof MutationObserver === "function") {
    i18nState.observer = new MutationObserver((records) => {
      const map = i18nMapFor("ru", i18nState.locale);
      for (const record of records) for (const node of record.addedNodes) i18nSwapTree(node, map);
    });
    i18nState.observer.observe(document.body, { childList: true, subtree: true });
  } else if (!wanted && i18nState.observer) {
    i18nState.observer.disconnect();
    i18nState.observer = null;
  }
}

function setLocale(locale, { persist = true } = {}) {
  const target = i18nLocales().includes(locale) ? locale : "ru";
  if (target !== i18nState.locale) {
    i18nSwapTree(document.body, i18nMapFor(i18nState.locale, target));
    i18nState.locale = target;
  }
  document.documentElement.lang = target;
  const select = document.getElementById("locale");
  if (select && select.value !== target) select.value = target;
  i18nObserve();
  if (persist) {
    // savePreferences() belongs to renderer.js and writes the select value with the rest.
    if (typeof savePreferences === "function") savePreferences();
  }
}

function i18nSavedLocale() {
  try {
    const saved = JSON.parse(localStorage.getItem("spriteLab.preferences") || "null");
    const locale = saved?.values?.locale;
    return i18nLocales().includes(locale) ? locale : "ru";
  } catch {
    return "ru";
  }
}

const i18nLocaleSelect = document.getElementById("locale");
if (i18nLocaleSelect) {
  i18nLocaleSelect.addEventListener("change", (event) => setLocale(event.target.value));
  const savedLocale = i18nSavedLocale();
  i18nLocaleSelect.value = savedLocale;
  if (savedLocale !== "ru") setLocale(savedLocale, { persist: false });
  else i18nObserve();
}
