import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readFileSync } from "node:fs";
import { collectRendererDeclarations, collectRendererGlobals, findDuplicateDeclarations, rendererFiles } from "../scripts/renderer-globals.mjs";

test("collects top-level declarations and reports collisions between scripts", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-renderer-globals-"));
  const first = path.join(temp, "first.js");
  const second = path.join(temp, "second.js");
  await fs.writeFile(first, "function shared() {}\nconst onlyFirst = 1;\n", "utf8");
  await fs.writeFile(second, "const shared = 2;\nfunction onlySecond() {}\n", "utf8");

  assert.deepEqual([...collectRendererDeclarations([first, second]).keys()].sort(), ["onlyFirst", "onlySecond", "shared"]);
  assert.deepEqual(findDuplicateDeclarations([first, second]), [`shared (${first}, ${second})`]);
  assert.throws(() => collectRendererGlobals([first, second]), /same global more than once/);
});

test("the shipped renderer scripts have no duplicate globals", () => {
  assert.deepEqual(findDuplicateDeclarations(), []);
});

test("the real renderer scripts expose their cross-file names as globals", () => {
  const appGlobals = collectRendererGlobals();
  for (const name of ["state", "runBuild", "setSource", "resetFrameConsistency", "renderSheetCellList", "drawPlayer"]) {
    assert.equal(appGlobals[name], "writable", `${name} must be known to ESLint as a renderer global`);
  }
});

test("every element id the renderer scripts look up exists in the markup", () => {
  // A missing id does not fail lint or the syntax check: $("#typo") returns null and the
  // addEventListener call throws while the script loads, which silently disables every
  // binding after it. This check is the only automated guard against that.
  const markup = readFileSync("src/index.html", "utf8");
  const present = new Set([...markup.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
  const missing = new Map();
  for (const file of rendererFiles) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\$\$?\(\s*"#([A-Za-z][\w-]*)"/g)) {
      const id = match[1];
      if (present.has(id)) continue;
      if (!missing.has(id)) missing.set(id, []);
      if (!missing.get(id).includes(file)) missing.get(id).push(file);
    }
  }
  assert.deepEqual([...missing.entries()].map(([id, files]) => `${id} (${files.join(", ")})`), []);
});
