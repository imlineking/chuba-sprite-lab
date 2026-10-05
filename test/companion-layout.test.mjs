import assert from "node:assert/strict";
import { test } from "node:test";
import { clampPet, bubbleBounds, moveCompanionPair, greeting } from "../src/companion-layout.mjs";

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

test("dragging a companion group preserves the offset and stops both surfaces at the edge", () => {
  const area = { x: 0, y: 0, width: 1280, height: 720 };
  const pet = { x: 600, y: 300, width: 112, height: 128 }, bubble = { x: 232, y: 200, width: 360, height: 228 };
  const moved = moveCompanionPair(pet, bubble, { x: 50, y: 70 }, [area]);
  assert.deepEqual(moved.pet, { ...pet, x: 650, y: 370 });
  assert.deepEqual(moved.bubble, { ...bubble, x: 282, y: 270 });
  for (const delta of [{ x: -2000, y: -2000 }, { x: 2000, y: 2000 }]) {
    const pair = moveCompanionPair(pet, bubble, delta, [area]);
    for (const bounds of [pair.pet, pair.bubble]) {
      assert.ok(bounds.x >= 0 && bounds.y >= 0);
      assert.ok(bounds.x + bounds.width <= area.width && bounds.y + bounds.height <= area.height);
    }
    assert.equal(pair.bubble.x - pair.pet.x, -368);
    assert.equal(pair.bubble.y - pair.pet.y, -100);
  }
});

test("companion group moves onto a negative-coordinate monitor without detaching", () => {
  const areas = [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: -1280, y: -200, width: 1280, height: 984 }];
  const pet = { x: 600, y: 300, width: 112, height: 128 }, bubble = { x: 232, y: 200, width: 360, height: 228 };
  const pair = moveCompanionPair(pet, bubble, { x: -1400, y: -250 }, areas);
  assert.equal(pair.pet.x, -800); assert.equal(pair.pet.y, 50);
  assert.equal(pair.bubble.x, -1168); assert.equal(pair.bubble.y, -50);
});

test("a hidden bubble does not prevent parking the pet at the screen edge", () => {
  const area = { x: 0, y: 0, width: 1280, height: 720 };
  const pet = { x: 600, y: 300, width: 112, height: 128 }, bubble = { x: 232, y: 200, width: 360, height: 228 };
  const pair = moveCompanionPair(pet, bubble, { x: -1000, y: -1000 }, [area], false);
  assert.equal(pair.pet.x, 0); assert.equal(pair.pet.y, 0);
  assert.ok(pair.bubble.x >= 0 && pair.bubble.y >= 0);
});
