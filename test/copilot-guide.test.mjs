import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { planConveyorGuide, planStudioGuide, autoFixFor, applyFixToPreset, studioType, dedupeChips } from "../src/copilot-conveyor.mjs";
import { capabilitiesFor, hasTool } from "../src/capabilities.mjs";

const preset = { id: "phaser", label: "Phaser", atlas: { formats: ["phaser-hash"], padding: 2, extrude: 1, maxSize: 2048 }, review: true };
const presets = [preset, { id: "godot", label: "Godot", atlas: { formats: ["godot-spriteframes"] } }, { id: "quick", label: "Быстрый", atlas: {} }];
const toolIds = (g) => g.chips.filter((c) => c.id.startsWith("tool:")).map((c) => c.id.slice(5));

test("empty conveyor: copilot explains and offers file, folder, quick and queue", () => {
  const g = planConveyorGuide({ mode: "conveyor" });
  assert.match(g.say, /Перетащите/);
  assert.deepEqual(g.chips.map((c) => c.id), ["pick-file", "pick-folder", "view:quick"]);
  assert.deepEqual(g.moreChips.map((c) => c.id), ["view:queue"]);
});

test("conveyor only offers tools valid for the detected type", () => {
  for (const type of ["image", "video", "sprite-sheet", "aseprite", "frames-folder"]) {
    const g = planConveyorGuide({ mode: "conveyor", intent: "animation", capabilities: capabilitiesFor(type), detection: { paths: ["x"], warnings: [] }, preset, presets });
    for (const id of toolIds(g)) assert.ok(hasTool(type, id), `${type} -> ${id}`);
    assert.equal(g.chips[0].id, "run");
  }
  const png = planConveyorGuide({ mode: "conveyor", capabilities: capabilitiesFor("image"), detection: { paths: ["a.png"] }, preset, presets });
  assert.ok(!toolIds(png).includes("split-frames"));
  assert.ok(!png.chips.some((c) => c.id === "enqueue"));
  assert.match(png.honest, /Атлас/);
  assert.ok(png.chips.some((c) => c.id === "preset:godot"));
  assert.ok(!png.chips.some((c) => c.id === "preset:quick"));
});

test("unsupported type: honest message, no tools", () => {
  const g = planConveyorGuide({ mode: "conveyor", capabilities: capabilitiesFor("pdf"), detection: { paths: ["a.pdf"] } });
  assert.match(g.honest, /PDF/);
  assert.equal(toolIds(g).length, 0);
});

test("after a run: verdict, clickable fixes for safe remarks, honest hand-work for the rest", () => {
  const result = { ok: true, outputDir: "/out", review: { verdict: "needs_fix", verdictLabel: "Нужны правки", score: 70, issues: [
    { code: "padding_small", reason: "Нет экструзии", fix: { padding: 2, extrude: 1 } },
    { code: "pivot_jitter", reason: "Опора прыгает.", fix: { pivot: { x: 0.5, y: 1 }, anchor: "feet" } },
  ] } };
  const g = planConveyorGuide({ mode: "conveyor", capabilities: capabilitiesFor("video"), detection: { paths: ["v.mp4"] }, preset, presets, result });
  assert.match(g.say, /Нужны правки, 70\/100/);
  assert.ok(g.chips.some((c) => c.id === "fix:0" && /отступ 2px/.test(c.detail)));
  assert.ok(g.chips.some((c) => c.id === "tool:align-frames" && /вручную/.test(c.title)));
  assert.match(g.honest, /руками/);
  assert.ok([...g.chips, ...g.moreChips].some((c) => c.id === "review"));
});

test("failed run says where it stopped and offers manual tools", () => {
  const g = planConveyorGuide({ mode: "conveyor", capabilities: capabilitiesFor("sprite-sheet"), detection: { paths: ["s.png"] }, preset, result: { ok: false, error: "сетка", failedStage: "cut" } });
  assert.match(g.say, /остановился/); assert.ok(g.honest);
  for (const id of toolIds(g)) assert.ok(hasTool("sprite-sheet", id));
});

test("quick and queue modes", () => {
  assert.ok(planConveyorGuide({ mode: "quick" }).chips.some((c) => c.id === "quick-pick"));
  assert.ok(planConveyorGuide({ mode: "quick", quick: { error: "x" } }).honest);
  const q = planConveyorGuide({ mode: "queue", queue: { paused: true, items: [{ status: "failed" }, { status: "pending" }] }, watch: { dir: "/w" } });
  assert.ok(q.chips.some((c) => c.id === "queue-resume")); assert.ok(q.chips.some((c) => c.id === "watch-stop")); assert.ok(q.honest);
  assert.deepEqual(planConveyorGuide({ busy: true }).chips.map((c) => c.id), ["cancel"]);
});

test("critic fixes only touch padding / extrude / page size / background", () => {
  assert.equal(autoFixFor({ slice: { mode: "auto" } }), null);
  assert.deepEqual(autoFixFor({ padding: 99, extrude: -3 }), { padding: 16, extrude: 0 });
  const p = applyFixToPreset(preset, { maxSize: 4096, background: { mode: "auto" } });
  assert.equal(p.atlas.maxSize, 4096); assert.equal(p.background, "auto"); assert.equal(preset.atlas.maxSize, 2048);
});

test("studio video: «Вижу видео … Что сделать?» with the required options", () => {
  assert.equal(studioType({ kind: "video" }), "video");
  assert.equal(planStudioGuide({ source: { kind: "frames", paths: ["a.png"] } }), null);
  const g = planStudioGuide({ source: { kind: "video", paths: ["/m/movie.mp4"] }, name: "movie.mp4" });
  assert.equal(g.say, "Вижу видео (movie.mp4). Что сделать?");
  const titles = g.chips.map((c) => c.title);
  for (const t of ["Раскадровка", "Убрать фоны", "Вынуть конкретный кадр", "Редактировать кадр", "Сохранить весь файл как есть", "Экспортировать 1 кадр", "Кадр с персонажем без фона", "Спрайт-лист целиком"]) assert.ok(titles.includes(t), t);
  for (const c of g.chips) assert.ok(hasTool("video", c.tool), c.tool);
});

test("studio video: picked frame shows ONE editor chip; change link only once a program is remembered", () => {
  const first = planStudioGuide({ source: { kind: "video" }, frame: { index: 41 } });
  assert.match(first.say, /Кадр 42/);
  const editorChips = first.chips.filter((c) => c.tool === "pixel-editor");
  assert.equal(editorChips.length, 1); assert.equal(editorChips[0].id, "vf:open-editor"); assert.equal(editorChips[0].title, "Открыть в редакторе");
  assert.match(editorChips[0].detail, /Спрошу/); assert.equal(editorChips[0].secondary, undefined);
  assert.ok(!first.chips.some((c) => /Photoshop|Figma|по умолчанию|Sprite Lab|edit-external|edit-internal/.test(c.title + c.id)));
  assert.equal(first.honest, null);
  for (const id of ["vf:bake", "vf:cutout", "vf:export-frame", "vf:pick"]) assert.ok(first.chips.some((c) => c.id === id), id);
  const ps = planStudioGuide({ source: { kind: "video" }, frame: { index: 1 }, editor: { id: "photoshop", label: "Photoshop" } });
  const chip = ps.chips.find((c) => c.id === "vf:open-editor");
  assert.match(chip.detail, /Photoshop/); assert.deepEqual(chip.secondary, { id: "vf:change-editor", title: "сменить редактор" });
  assert.equal(ps.honest, null, "Figma note only for Figma");
  const figma = planStudioGuide({ source: { kind: "video" }, frame: { index: 1 }, editor: { id: "figma", label: "Figma" } });
  assert.match(figma.honest, /Figma/);
  const saved = planStudioGuide({ source: { kind: "video" }, frame: { index: 3, savedAt: 1, editor: "figma", editorLabel: "Figma" }, editor: { id: "figma", label: "Figma" } });
  assert.match(saved.say, /сохранение кадра 4 из Figma/);
  const baked = planStudioGuide({ source: { kind: "video" }, last: { kind: "baked", index: 3, path: "/m/movie-edited.mp4", notes: ["Видео перекодировано."] } });
  assert.match(baked.say, /вшит/); assert.match(baked.honest, /перекодировано/);
  assert.match(planStudioGuide({ source: { kind: "video" }, last: { kind: "cutout", index: 0, path: "/p/a.png", empty: true } }).honest, /вручную/);
  assert.match(planStudioGuide({ source: { kind: "video" }, last: { error: "нет ffmpeg" } }).honest, /вручную/);
});

test("chips that mean the same thing collapse into one", () => {
  assert.deepEqual(dedupeChips([{ id: "a" }, { id: "b" }, { id: "a" }]).map((c) => c.id), ["a", "b"]);
  const result = { ok: true, outputDir: "/o", review: { verdict: "needs_fix", issues: [
    { reason: "Опора прыгает (бег).", fix: { pivot: { x: 0.5, y: 1 } } }, { reason: "Опора прыгает (прыжок).", fix: { anchor: "feet" } } ] } };
  const g = planConveyorGuide({ mode: "conveyor", capabilities: capabilitiesFor("video"), detection: { paths: ["v.mp4"] }, preset, presets, result });
  assert.equal(g.chips.filter((c) => c.id === "tool:align-frames").length, 1);
  for (const guide of [g, planStudioGuide({ source: { kind: "video" } }), planStudioGuide({ source: { kind: "video" }, frame: { index: 0 } })]) {
    const ids = guide.chips.map((c) => c.id); assert.equal(new Set(ids).size, ids.length);
  }
});

test("the companion hides panel extras that duplicate a guide chip and renders the secondary link small", async () => {
  const companion = await fs.readFile(new URL("../src/companion.js", import.meta.url), "utf8");
  assert.match(companion, /guideIds\.has\('view:quick'\)/); assert.match(companion, /choice-link/);
});

test("the companion cloud accepts conveyor/video chips and the review command", async () => {
  const text = await fs.readFile(new URL("../src/desktop-companion.mjs", import.meta.url), "utf8");
  assert.match(text, /"review", "conveyor"\]/);
  const companion = await fs.readFile(new URL("../src/companion.js", import.meta.url), "utf8");
  assert.match(companion, /command\('conveyor', chip\.id\)/);
});
