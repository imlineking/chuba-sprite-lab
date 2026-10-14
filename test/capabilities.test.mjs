import test from "node:test";
import assert from "node:assert/strict";
import { capabilityMap, capabilitiesFor, hasTool, tools, conveyorStages } from "../src/capabilities.mjs";

test("every tool in the map is declared and every type has a label", () => {
  for (const [type, entry] of Object.entries(capabilityMap)) {
    assert.ok(entry.label, type);
    for (const id of entry.tools) assert.ok(tools[id], `${type}: unknown tool ${id}`);
    for (const stage of entry.conveyor) assert.ok(conveyorStages.some((s) => s.id === stage), `${type}: unknown stage ${stage}`);
    assert.equal(new Set(entry.tools).size, entry.tools.length, `${type}: duplicate tools`);
  }
});

test("'Разложить на кадры' only appears for moving inputs", () => {
  assert.equal(tools["split-frames"].label, "Разложить на кадры");
  for (const type of ["video", "video-batch", "animated-image"]) assert.ok(hasTool(type, "split-frames"), type);
  for (const type of ["image", "pdf", "svg", "psd", "sprite-sheet", "image-set", "frames-folder", "atlas-json", "project", "unknown"]) assert.ok(!hasTool(type, "split-frames"), type);
});

test("single images get no packing, slicing or interpolation; sheets get slicing", () => {
  for (const id of ["pack-atlas", "slice-sheet", "interpolate", "review", "trim-time"]) assert.ok(!hasTool("image", id), id);
  assert.ok(hasTool("image", "remove-background")); assert.ok(hasTool("image", "ocr"));
  assert.ok(hasTool("sprite-sheet", "slice-sheet")); assert.ok(!hasTool("video", "slice-sheet"));
  assert.deepEqual(capabilitiesFor("image").stages.filter((s) => s.applies).map((s) => s.id), ["clean", "export"]);
  assert.deepEqual(capabilitiesFor("video").stages.filter((s) => s.applies).map((s) => s.id), ["cut", "clean", "pack", "check", "export"]);
});

test("unsupported types carry a clear Russian message and no tools", () => {
  for (const type of ["pdf", "svg", "psd", "bmp", "heic", "mixed", "empty-folder", "unknown"]) {
    const caps = capabilitiesFor(type);
    assert.equal(caps.supported, false, type); assert.equal(caps.tools.length, 0, type);
    assert.match(caps.message, /[а-я]/i, type);
  }
  assert.equal(capabilitiesFor("no-such-type").type, "unknown");
});

test("groups preserve tool order and drop empty groups", () => {
  const caps = capabilitiesFor("video");
  assert.equal(caps.groups[0].id, "main");
  assert.ok(caps.groups.every((g) => g.tools.length > 0));
  assert.equal(caps.groups.flatMap((g) => g.tools).length, caps.tools.length);
});
