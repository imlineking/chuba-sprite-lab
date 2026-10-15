import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tools } from "../src/capabilities.mjs";
import { conveyorToolRoute, companionActionAllowed } from "../src/conveyor-tools.mjs";
import { planConveyorGuide } from "../src/copilot-conveyor.mjs";
import { capabilitiesFor } from "../src/capabilities.mjs";
import { validateCriticConfig } from "../src/critic/critic.mjs";
import path from "node:path";

test("every advertised manual tool has a route to real studio controls", async () => {
  const html = await fs.readFile(new URL("../src/index.html", import.meta.url), "utf8");
  for (const [id, tool] of Object.entries(tools)) {
    if (tool.group === "main") continue;
    const route = conveyorToolRoute(id);
    assert.ok(route, id);
    if (route.focus) assert.ok(html.includes(`id="${route.focus}"`), `${id}: target exists`);
    if (typeof route.details === "string") assert.ok(html.includes(`id="${route.details}"`), `${id}: panel exists`);
    assert.equal(Boolean(route.original), ["split-frames", "trim-time", "slice-sheet", "import-atlas", "import-aseprite"].includes(id), `${id}: correct source`);
  }
});

test("cancel remains available while other copilot commands are blocked", () => {
  assert.equal(companionActionAllowed(true, "cancel"), true);
  assert.equal(companionActionAllowed(true, "queue-cancel:42"), true);
  for (const id of ["run", "tool:pixel-editor", "pick-file", null]) assert.equal(companionActionAllowed(true, id), false);
  assert.equal(companionActionAllowed(false, "tool:pixel-editor"), true);
});

test("copilot presents at most three choices and keeps the rest discoverable", () => {
  for (const type of ["image", "video", "sprite-sheet", "frames-folder"]) {
    const guide = planConveyorGuide({ intent: "animation", capabilities: capabilitiesFor(type), preset: { label: "Phaser" } });
    assert.ok(guide.chips.length <= 3);
    assert.equal(guide.chips[0].id, "run");
    const ids = [...guide.chips, ...guide.moreChips].map((chip) => chip.id);
    assert.equal(new Set(ids).size, ids.length);
  }
  const failed = planConveyorGuide({ capabilities: capabilitiesFor("video"), result: { ok: false, failedStage: "export", error: "нет места" } });
  assert.ok(failed.chips.some((chip) => chip.id === "tool:export-engines"));
  assert.ok(![...failed.chips, ...failed.moreChips].some((chip) => /split-frames|remove-background/.test(chip.id)));
});

test("review accepts the conveyor timeline and rejects metadata paths escaping output", () => {
  const config = { input: [path.resolve("fixture/frames")], output: path.resolve("fixture/atlas"), frameMetadata: { "0000": { name: "walk_0", durationMs: 80 } }, animationMetadata: { walk: { from: 0, to: 0 } }, animationLoop: 3 };
  assert.equal(validateCriticConfig(config).frameMetadata["0000"].durationMs, 80);
  assert.throws(() => validateCriticConfig({ ...config, frameMetadata: { "0000": { name: "../escape" } } }), /папку результата/);
  assert.throws(() => validateCriticConfig({ ...config, animationLoop: -1 }), /animationLoop/);
});
