import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import vm from "node:vm";

test("desktop bubble immediately says Loading and animates 1,2,3,2,1 dots until ready", async () => {
  let tick, onState;
  const nodes = new Map();
  const node = () => ({ textContent: "", dataset: {}, classList: { add() {}, remove() {} },
    replaceChildren() {}, addEventListener() {}, append() {}, offsetHeight: 110 });
  const get = name => { if (!nodes.has(name)) nodes.set(name, node()); return nodes.get(name); };
  const document = { body: get("body"), documentElement: get("html"), querySelector: get,
    createElement: node, addEventListener() {} };
  vm.runInNewContext(await fs.readFile(new URL("../src/companion.js", import.meta.url), "utf8"), {
    document, location: { search: "?surface=bubble" }, URLSearchParams,
    window: { desktopCompanion: { onState: callback => { onState = callback; }, action: async () => true } },
    ResizeObserver: class { observe() {} }, setInterval: callback => { tick = callback; },
  });
  const values = [get("#message").textContent];
  for (let i = 0; i < 4; i++) { tick(); values.push(get("#message").textContent); }
  assert.deepEqual(values, ["Загрузка.", "Загрузка..", "Загрузка...", "Загрузка..", "Загрузка."]);
  onState({ loading: false, greeting: "Привет, Дмитрий! Давай начнём работу." });
  tick(); assert.equal(get("#message").textContent, "Привет, Дмитрий! Давай начнём работу.");
});
