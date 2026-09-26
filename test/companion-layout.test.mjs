import assert from "node:assert/strict";
import { test } from "node:test";
import { clampPet, bubbleBounds, greeting } from "../src/companion-layout.mjs";

test("desktop pet remains on the selected monitor, including negative coordinates", () => {
  const areas = [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: -1280, y: 0, width: 1280, height: 984 }];
  assert.deepEqual(clampPet({ x: -900, y: 260 }, areas), { x: -900, y: 260 });
  assert.deepEqual(clampPet({ x: 1910, y: 1030 }, areas), { x: 1808, y: 912 });
  assert.deepEqual(clampPet({ x: 4000, y: 3000 }, areas), { x: 1808, y: 912 });
});
test("speech flips at monitor edges and stays inside the work area", () => {
  const area = { x: 0, y: 0, width: 1280, height: 720 };
  for (const point of [{ x: 0, y: 0 }, { x: 1168, y: 592 }]) {
    const bounds = bubbleBounds({ ...point, width: 112, height: 128 }, { width: 360, height: 580 }, area);
    assert.ok(bounds.x >= 0 && bounds.y >= 0);
    assert.ok(bounds.x + bounds.width <= 1280 && bounds.y + bounds.height <= 720);
  }
});
test("greeting uses a supplied account name and has a neutral fallback", () => {
  assert.equal(greeting("Дмитрий"), "Привет, Дмитрий! Давай начнём работу.");
  assert.equal(greeting(""), "Привет! Давай начнём работу.");
  assert.ok(!greeting("\u0000<Юлия>").includes("<"));
});
