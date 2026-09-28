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
    "4 ряда ↑": "4 rows ↑",
    "Развернуть ↓": "Expand ↓",
    "Нажмите цвет: заменить во всём кадре, удалить или взять для кисти.": "Click a colour to replace it throughout the frame, erase it, or use it for the brush.",
    "Замена цвета кадра": "Frame colour replacement",
    "Палитра sRGB текущего кадра": "Current frame sRGB palette",
    "Насыщенность и яркость цвета": "Colour saturation and brightness",
    "HEX нового цвета": "New colour HEX",
    "Оттенок": "Hue",
    "Допуск": "Colour match tolerance",
    "Заменить цвет": "Replace colour",
    "Удалить цвет": "Erase colour",
    "Отмена просмотра": "Cancel preview",
    "Для кисти": "Use for brush",
    "Свет и цвет": "Light and colour",
    "Предпросмотр всего кадра · прозрачность сохраняется.": "Full frame preview · transparency is preserved.",
    "Яркость": "Brightness",
    "Насыщенность": "Saturation",
    "Контраст": "Contrast",
    "Тени": "Shadows",
    "Светлые участки": "Highlights",
    "Сила фильтра": "Filter strength",
    "Цвет фильтра": "Filter colour",
    "HEX цветового фильтра": "Filter colour HEX",
    "Насыщенность и яркость фильтра": "Filter saturation and brightness",
    "Оттенок фильтра": "Filter hue",
    "Свет и цвет · предпросмотр, ещё не применено": "Light and colour · preview, not applied yet",
    "Примените или отмените предпросмотр перед рисованием.": "Apply or cancel the preview before drawing.",
    "Введите HEX: #RRGGBB": "Enter HEX: #RRGGBB",
    "Цвет {color} · весь кадр": "Colour {color} · whole frame",
    "{count} пикселей · предпросмотр, ещё не применено": "{count} pixels · preview, not applied yet",
    "0 · точно": "0 · exact",
    "{color} · заменить, удалить или взять для кисти": "{color} · replace, erase or use for brush",
    "Место для вашей работы": "A place for your work",
    "Добавьте изображения или видео,": "Add images or a video,",
    "выберите задачу и проверьте результат.": "choose a task and check the result.",
    "Оформление": "Appearance",
    "Выберите оформление и имя для приветствия. Пустое поле вернёт имя учётной записи.": "Choose the appearance and greeting name. An empty name uses your account name.",
    "Тема оформления": "Appearance theme",
    "Тёмная · Призма": "Dark \u00b7 Prism",
    "Светлая · Фарфор": "Light \u00b7 Porcelain",
    "Анимация меню": "Menu animation",
    "Переходы разделов и раскрытие меню": "Section transitions and menu reveals",
    "Выбор оформления сохраняется сразу.": "Appearance changes are saved immediately.",
    "Движение отключено в настройках доступности системы": "Motion is disabled by system accessibility settings",
    "Включить тёмную тему Призма": "Switch to the dark Prism theme",
    "Включить светлую тему Фарфор": "Switch to the light Porcelain theme",
    "Тёмная тема · Призма": "Dark theme \u00b7 Prism",
    "Светлая тема · Фарфор": "Light theme \u00b7 Porcelain",
    "ЗНАКОМСТВО": "WELCOME",
    "НАСТРОЙКИ": "SETTINGS",
    "Настройки": "Settings",
    "Привет, давай знакомиться!": "Hello, let's get acquainted!",
    "Как к вам обращаться?": "What should I call you?",
    "Копилот запомнит имя и будет использовать его в приветствии.": "The copilot will remember your name and use it in greetings.",
    "Ваше имя": "Your name",
    "Введите имя": "Enter your name",
    "Пропустить": "Skip",
    "Начать работу": "Get started",
    "Стежок — эксперимент": "Stitch — experimental",
    "Экспериментальный режим: без дизеринга результат пока совпадает с чистой пикселизацией": "Experimental mode: without dithering the result currently matches clean pixelation",
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
    "Добавьте исходники": "Add source files",
    "Изображения, готовый лист или видео. Выберите задачу — копилот предложит следующий шаг.":
      "Images, a ready-made sheet or a video. Choose a task and the copilot will suggest the next step.",
    "Что сделать с изображениями?": "What would you like to do with these images?",
    "Восстановите повреждённый объект или выберите отдельные файлы, общий атлас либо анимацию.": "Restore a damaged object, or choose separate files, a shared atlas or an animation.",
    "Восстановить повреждённый объект · Подорожник": "Restore a damaged object · Healing Tool",
    "Восстановить повреждённый объект": "Restore a damaged object",
    "Подорожник: восстановить детали → удалить псевдопрозрачность → передать в очистку фона и края": "Healing Tool: repair details → remove baked checkerboard → clean background and edges",
    "После Подорожника": "After Healing Tool",
    "Править обрезку и фон · PNG": "Edit cutout and background · PNG",
    "Атлас объектов · PNG + JSON": "Object atlas · PNG + JSON",
    "Сделать анимацию": "Create an animation",
    "Редактировать изображения": "Edit images",
    "Очистка фона и контура · отдельные PNG в исходном размере": "Background and edge cleanup · separate PNGs at their original size",
    "Выделение и фон": "Selection and background",
    "Сохранить PNG": "Save PNG",
    "Сохранить все PNG": "Save all PNGs",
    "Автоочистка · просмотр": "Auto-clean · preview",
    "Автоочистка изображений": "Automatic image cleanup",
    "Пакетная подготовка PNG + JSON": "Batch PNG + JSON preparation",
    "Проверьте очистку каждого исходника. После просмотра сохраняются отдельные PNG + JSON. Исходные файлы остаются на месте.": "Review each cleaned source before saving separate PNG + JSON files. Original files are preserved.",
    "Сохранить выбранные · PNG + JSON": "Save selected · PNG + JSON",
    "Просмотр · затем PNG + JSON": "Preview · then PNG + JSON",
    "Сравните исходник и результат. Применение можно отменить Ctrl+Z; PNG сохраняются отдельной кнопкой.": "Compare the source and result. Ctrl+Z undoes the changes; PNGs are saved separately.",
    "Область действия": "Processing scope",
    "Текущее изображение": "Current image",
    "Выбранные в списке": "Selected in the list",
    "Все изображения": "All images",
    "Выберите файлы и запустите предпросмотр.": "Choose files and prepare a preview.",
    "Исходник": "Source image",
    "После очистки": "After cleanup",
    "Подготовить просмотр": "Prepare preview",
    "Повторить ошибки": "Retry failed files",
    "Продолжить оставшиеся": "Continue pending files",
    "Остановить": "Stop processing",
    "Применить выбранные": "Apply selected results",
    "Автоочистка · сравнить и применить": "Auto-clean · compare and apply",
    "Прямоугольник": "Rectangle",
    "Лассо": "Lasso",
    "удалить цвет только в области": "remove colour only within a region",
    "обвести сложную область": "outline a complex region",
    "Удаляемый цвет": "Colour to remove",
    "Пипетка с изображения": "Pick colour from image",
    "Допуск цвета": "Colour tolerance",
    "Удалить цвет в выделении": "Remove colour within selection",
    "Снять выделение": "Deselect",
    "Убрать шахматы · псевдопрозрачность": "Remove baked checkerboard",
    "Повторить": "Redo",
    "Правка фона и выделения": "Background and selection editing",
    "ФАЙЛЫ": "FILES",
    "РАЗМЕР": "SIZE",
    "ПОЛОЖЕНИЕ": "POSITION",
    "ФАЙЛ": "FILE",
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
    "Внешний редактор": "External editor",
    "Пиксельный редактор": "Pixel editor",
    "Неприменённые правки": "Unapplied edits",
    "Применить правки перед закрытием редактора?": "Apply edits before closing the editor?",
    "Продолжить правку": "Keep editing",
    "Отбросить и закрыть": "Discard and close",
    "Применить и закрыть": "Apply and close",
    "Применить правки к проекту; PNG сохраняется в главном окне": "Apply edits to the project; save PNG in the main window",
    "Правки применяются к проекту. PNG сохраняется в главном окне.": "Edits apply to the project. Save PNG in the main window.",
    "Примените правки к проекту, затем пересоберите лист перед экспортом.": "Apply edits to the project, then rebuild the sheet before export.",
    "Применяю правки к проекту…": "Applying edits to the project…",
    "Правки в проекте · сохраните PNG в главном окне": "Edits applied to project · save PNG in the main window",
    "Изображение {number} изменено · сохраните PNG": "Image {number} edited · save PNG",
    "Правки в проекте · пересоберите лист перед экспортом": "Edits applied to project · rebuild sheet before export",
    "{count} отдельных изображений · выберите файл для правки": "{count} separate images · choose a file to edit",
    "Ctrl+Z — отменить, Ctrl+Shift+Z — вернуть, Ctrl+S — применить к проекту, Esc — закрыть.": "Ctrl+Z — undo, Ctrl+Shift+Z — redo, Ctrl+S — apply to project, Esc — close.",
    "КАДР {number}": "FRAME {number}",
    "Цвет и пиксели": "Colour and pixels",
    "Открыть во внешнем редакторе и вернуть результат в проект": "Open in an external editor and return the result to the project",
    "Изменить цвета, свет и пиксели в программе": "Edit colours, lighting and pixels in the app",
    "Анализировать исходники": "Analyse sources",
    "Выберите задачу через помощника или проанализируйте исходники здесь. План покажет подходящие инструменты и причину выбора.": "Choose a task with the assistant or analyse sources here. The plan explains which tools suit the task and why.",
    "Предпросмотр отменён · применённые изменения остаются": "Preview cancelled · applied edits kept",
    "Замена цвета · предпросмотр, ещё не применено": "Colour replacement · preview, not applied yet",
    "Доработайте один кадр": "Touch up a single frame",
    "Применить к проекту": "Apply to project",
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

    /* feedback draft */
    "Ошибка или предложение": "Bug or suggestion",
    "Сообщить об ошибке": "Report a bug",
    "ОБРАТНАЯ СВЯЗЬ": "FEEDBACK",
    "Расскажите нам": "Tell us about it",
    "Опишите ошибку или идею. Черновик хранится только на этом компьютере.":
      "Describe a bug or an idea. The draft stays on this computer.",
    "Тип сообщения": "Feedback type",
    "Ошибка": "Bug",
    "Предложение": "Suggestion",
    "Короткая тема": "Short subject",
    "Описание": "Description",
    "Например: обрезается край кадра": "For example: a frame edge gets clipped",
    "Что произошло? Что ожидали увидеть? Или как можно улучшить программу?":
      "What happened? What did you expect? Or how could we improve the app?",
    "Отправка пока не подключена. Никакие файлы, журналы или адреса автоматически не прикладываются. Перед копированием проверьте текст на личные данные.":
      "Sending is not available yet. No files, logs, or addresses are attached automatically. Check the text for personal information before copying.",
    "Заполните форму — черновик сохранится автоматически.": "Fill in the form — your draft is saved automatically.",
    "Черновик сохранён на этом компьютере.": "Draft saved on this computer.",
    "Не удалось сохранить черновик. Скопируйте текст перед закрытием.":
      "Could not save the draft. Copy the text before closing.",
    "Есть сохранённый черновик. Очистите его, чтобы начать сообщение об ошибке.":
      "A draft is already saved. Clear it to start a bug report.",
    "Черновик очищен.": "Draft cleared.",
    "Текст скопирован. Отправка из программы пока не подключена.":
      "Text copied. Sending from the app is not available yet.",
    "Не удалось скопировать текст.": "Could not copy the text.",
    "Заполните форму обратной связи.": "Fill in the feedback form.",
    "Выберите тип сообщения.": "Choose a feedback type.",
    "Тема должна содержать от 4 до 120 символов.": "The subject must be 4 to 120 characters long.",
    "Описание должно содержать от 20 до 4000 символов.": "The description must be 20 to 4000 characters long.",
    "Очистить": "Clear",
    "Скопировать текст": "Copy text",
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
