import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";

// i18n.js is a classic renderer script: it cannot be imported, so it is evaluated here in a sandbox
// with a small stand-in DOM. That keeps the test on the shipped file instead of a copy of it.

const root = path.resolve(import.meta.dirname, "..");
const i18nSource = readFileSync(path.join(root, "src", "i18n.js"), "utf8");
const markupSource = readFileSync(path.join(root, "src", "index.html"), "utf8");
const rendererSource = ["renderer.js", "studio.js", "sheet-editor.js", "frame-consistency.js", "copilot.js", "sprite-editor.js"]
  .map((file) => readFileSync(path.join(root, "src", file), "utf8"))
  .join("\n");

function createElement(tagName, attributes = {}, children = []) {
  const element = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    attributes: { ...attributes },
    childNodes: [],
    style: {},
    get textContent() {
      return this.childNodes.map((child) => (child.nodeType === 3 ? child.data : child.textContent)).join("");
    },
    set textContent(value) {
      this.childNodes = [createText(String(value))];
    },
    hasAttribute(name) { return name in this.attributes; },
    getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    listeners: {},
    addEventListener(type, handler) {
      (this.listeners[type] ||= []).push(handler);
    },
    dispatch(type) {
      for (const handler of this.listeners[type] || []) handler({ target: this });
    },
    querySelectorAll(selector) {
      assert.equal(selector, "*");
      const found = [];
      const visit = (node) => {
        for (const child of node.childNodes) {
          if (child.nodeType !== 1) continue;
          found.push(child);
          visit(child);
        }
      };
      visit(this);
      return found;
    },
  };
  for (const child of children) {
    element.childNodes.push(child);
    child.parentNode = element;
  }
  return element;
}

function createText(data) {
  return {
    nodeType: 3,
    data,
    get textContent() { return this.data; },
    set textContent(value) { this.data = String(value); },
  };
}

function createSandbox({ savedLocale = "ru" } = {}) {
  const localeSelect = createElement("select", { id: "locale" });
  localeSelect.value = "ru";
  const body = createElement("body", {}, [
    createElement("button", {}, [createText(" Источник ")]),
    createElement("button", { title: "Открыть проект", "aria-label": "Закрыть" }, []),
    createElement("span", {}, [createElement("kbd", {}, [createText("Ctrl K")])]),
    createElement("script", {}, [createText("const t = 1;")]),
    createElement("p", { "data-i18n-skip": "" }, [createText("Новый")]),
  ]);
  const document = {
    body,
    documentElement: { lang: "ru" },
    getElementById: (id) => (id === "locale" ? localeSelect : null),
  };
  const storage = new Map();
  if (savedLocale !== "ru") storage.set("spriteLab.preferences", JSON.stringify({ values: { locale: savedLocale } }));
  const context = {
    document,
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
    },
    MutationObserver: undefined,
    console,
  };
  vm.createContext(context);
  new vm.Script(i18nSource, { filename: "src/i18n.js" }).runInContext(context);
  return { context, body, localeSelect };
}

function textOf(node) {
  return node.textContent;
}

// Top-level `const` in a classic script lives in the global lexical scope, not on the context
// object, so reading it means evaluating an expression in the same context.
function globalOf(context, expression) {
  return vm.runInContext(expression, context);
}

test("Russian is the source language and stays untouched", () => {
  const { context, body } = createSandbox();
  assert.equal(globalOf(context, "i18nState.locale"), "ru");
  assert.equal(context.t("Источник"), "Источник");
  assert.equal(textOf(body.childNodes[0]), " Источник ");
});

test("a known string is translated and an unknown one is left alone", () => {
  const { context } = createSandbox();
  context.setLocale("en", { persist: false });
  assert.equal(context.t("Источник"), "Source");
  assert.equal(context.t("Неизвестная строка"), "Неизвестная строка");
});

test("switching language rewrites the markup and survives a trip back", () => {
  const { context, body, localeSelect } = createSandbox();
  context.setLocale("en", { persist: false });
  assert.equal(globalOf(context, "i18nState.locale"), "en");
  assert.equal(context.document.documentElement.lang, "en");
  assert.equal(localeSelect.value, "en");
  assert.equal(textOf(body.childNodes[0]), " Source ");
  assert.equal(body.childNodes[1].getAttribute("title"), "Open project");
  assert.equal(body.childNodes[1].getAttribute("aria-label"), "Close");

  context.setLocale("ru", { persist: false });
  assert.equal(textOf(body.childNodes[0]), " Источник ");
  assert.equal(body.childNodes[1].getAttribute("title"), "Открыть проект");
  assert.equal(body.childNodes[1].getAttribute("aria-label"), "Закрыть");
});

test("keyboard keys and explicitly skipped markup are never translated", () => {
  const { context, body } = createSandbox();
  context.setLocale("en", { persist: false });
  assert.equal(body.childNodes[2].childNodes[0].textContent, "Ctrl K");
  assert.equal(body.childNodes[3].textContent, "const t = 1;");
  assert.equal(body.childNodes[4].textContent, "Новый");
});

test("the saved language is applied when the window opens", () => {
  const { context, body, localeSelect } = createSandbox({ savedLocale: "en" });
  assert.equal(globalOf(context, "i18nState.locale"), "en");
  assert.equal(localeSelect.value, "en");
  assert.equal(textOf(body.childNodes[0]), " Source ");
  assert.equal(body.childNodes[1].getAttribute("aria-label"), "Close");
});

test("placeholders are filled with the requested values", () => {
  const { context } = createSandbox();
  assert.equal(context.t("Кадр {number} изменён в пиксельном редакторе", { number: 4 }), "Кадр 4 изменён в пиксельном редакторе");
  context.setLocale("en", { persist: false });
  assert.equal(context.t("Кадр {number} изменён в пиксельном редакторе", { number: 4 }), "Frame 4 edited in the pixel editor");
});

test("an unknown language falls back to Russian instead of showing keys", () => {
  const { context, body } = createSandbox();
  context.setLocale("klingon", { persist: false });
  assert.equal(globalOf(context, "i18nState.locale"), "ru");
  assert.equal(textOf(body.childNodes[0]), " Источник ");
});

test("every translation is non-empty, unambiguous and still present in the interface", () => {
  const { context } = createSandbox();
  const dictionary = globalOf(context, "i18nSources.en");
  const reversed = globalOf(context, 'i18nReverseDictionary("en")');
  const haystack = `${markupSource}\n${rendererSource}`;
  const missing = [];
  for (const [source, translated] of Object.entries(dictionary)) {
    if (!translated.trim()) missing.push(`пустой перевод: ${source}`);
    else if (reversed[translated] !== source) missing.push(`неоднозначный перевод: ${source}`);
    else if (!haystack.includes(source)) missing.push(`строки больше нет в интерфейсе: ${source}`);
  }
  assert.deepEqual(missing, []);
});
