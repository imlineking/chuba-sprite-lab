import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import vm from "node:vm";
import { companionActionAllowed } from "../src/conveyor-tools.mjs";

test("desktop bubble immediately says Loading and animates 1,2,3,2,1 dots until ready", async () => {
  let tick, onState;
  const nodes = new Map();
  const node = () => ({ textContent: "", dataset: {}, children: [], classList: { add() {}, remove() {} },
    replaceChildren() { this.children = []; }, addEventListener() {}, setAttribute() {}, append(...items) { this.children.push(...items); }, offsetHeight: 110 });
  const get = name => { if (!nodes.has(name)) nodes.set(name, node()); return nodes.get(name); };
  const document = { body: get("body"), documentElement: get("html"), querySelector: get,
    createElement: tag => ({ ...node(), tagName: tag.toUpperCase() }), addEventListener() {} };
  // Link the same module dependency into this lightweight DOM harness.
  const source = (await fs.readFile(new URL("../src/companion.js", import.meta.url), "utf8")).replace(/^import \{ companionActionAllowed \} from .*;\r?\n/, "");
  vm.runInNewContext(source, {
    companionActionAllowed,
    // Translation itself is covered by i18n.test and the actual two-window UI check.
    setLocale() {}, t: text => text,
    document, location: { search: "?surface=bubble" }, URLSearchParams,
    window: { desktopCompanion: { onState: callback => { onState = callback; }, action: async () => true } },
    ResizeObserver: class { observe() {} }, setInterval: callback => { tick = callback; },
  });
  const values = [get("#message").textContent];
  for (let i = 0; i < 4; i++) { tick(); values.push(get("#message").textContent); }
  assert.deepEqual(values, ["Загрузка.", "Загрузка..", "Загрузка...", "Загрузка..", "Загрузка."]);
  onState({ loading: false, greeting: "Привет, Дмитрий! Давай начнём работу." });
  tick(); assert.equal(get("#message").textContent, "Привет, Дмитрий! Давай начнём работу.");
  onState({ loading: false, busy: true, guide: { say: "Работаю", chips: [{ id: "cancel", title: "Остановить" }, { id: "run", title: "Запустить" }] } });
  assert.equal(get("#choices").children[0].disabled, false, "real rendered cancel stays enabled");
  assert.equal(get("#choices").children[1].disabled, true, "another run stays blocked");
  onState({ loading: false, panelOpen: true });
  const settings = get("#choices").children.find(child => child.tagName === "DETAILS");
  assert.ok(settings, "advanced settings remain discoverable");
  assert.equal(settings.open, false, "large tool menu is collapsed by default");
});
