import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DesktopCompanion } from '../src/desktop-companion.mjs';

function surface(bounds) {
  return { bounds: { ...bounds }, webContents: { send() {} }, visible: true, top: true, raises: 0,
    getBounds() { return { ...this.bounds }; }, isDestroyed() { return false; }, isVisible() { return this.visible; },
    setPosition(x, y) { this.bounds.x = x; this.bounds.y = y; }, setBounds(value) { this.bounds = { ...value }; },
    isAlwaysOnTop() { return this.top; }, setAlwaysOnTop(value, level) { this.top = value; this.level = level; this.raises++; } };
}

test('pet and chat initiate the same group drag; only its owner can move or finish it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chuba-companion-drag-'));
  try {
    let action;
    const companion = new DesktopCompanion({ app: { getPath: () => root }, ipcMain: { handle: (name, callback) => { action = callback; } }, screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1280, height: 720 } }] } });
    companion.pet = surface({ x: 600, y: 300, width: 112, height: 128 });
    companion.bubble = surface({ x: 232, y: 200, width: 360, height: 228 });
    for (const owner of [companion.pet, companion.bubble]) {
      const other = owner === companion.pet ? companion.bubble : companion.pet;
      const beforePet = companion.pet.getBounds(), beforeBubble = companion.bubble.getBounds();
      await action({ sender: owner.webContents }, { action: 'drag-start', x: 100, y: 100 });
      await action({ sender: other.webContents }, { action: 'drag-move', x: 150, y: 150 });
      await action({ sender: other.webContents }, { action: 'drag-end' });
      assert.deepEqual(companion.pet.getBounds(), beforePet); assert.ok(companion.drag);
      await action({ sender: owner.webContents }, { action: 'drag-move', x: 150, y: 130 });
      assert.deepEqual(companion.pet.getBounds(), { ...beforePet, x: beforePet.x + 50, y: beforePet.y + 30 });
      assert.deepEqual(companion.bubble.getBounds(), { ...beforeBubble, x: beforeBubble.x + 50, y: beforeBubble.y + 30 });
      await action({ sender: owner.webContents }, { action: 'drag-end' });
      assert.equal(companion.drag, null);
    }
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'desktop-companion.json'), 'utf8')), { x: 700, y: 360 });
    await assert.rejects(action({ sender: {} }, { action: 'drag-start', x: 0, y: 0 }), /Недопустимый/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('showing an already topmost helper does not keep reordering desktop windows', () => {
  const companion = new DesktopCompanion({ app: { getPath: () => '.' }, ipcMain: { handle() {} } });
  companion.pet = surface({}); companion.bubble = surface({});
  for (let i = 0; i < 5; i++) companion.raise();
  assert.equal(companion.pet.raises, 0); assert.equal(companion.bubble.raises, 0);
  companion.bubble.top = false; companion.raise();
  assert.equal(companion.bubble.raises, 1); assert.equal(companion.bubble.level, 'floating');
});

test('DIP cursor wins over changing DOM coordinates and repeated messages do not accumulate drift', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chuba-native-cursor-'));
  try {
    let action, cursor = { x: 100, y: 100 };
    const companion = new DesktopCompanion({ app: { getPath: () => root }, ipcMain: { handle: (_, callback) => { action = callback; } }, screen: { getCursorScreenPoint: () => cursor, getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1280, height: 720 } }] } });
    companion.pet = surface({ x: 600, y: 300, width: 112, height: 128 });
    companion.bubble = surface({ x: 232, y: 200, width: 360, height: 228 });
    const event = { sender: companion.pet.webContents };
    await action(event, { action: 'drag-start', x: -9999, y: 9999 });
    await action(event, { action: 'drag-move', x: 8000, y: -8000 });
    assert.equal(companion.pet.getBounds().x, 600);
    cursor = { x: 150, y: 130 };
    for (let i = 0; i < 100; i++) await action(event, { action: 'drag-move', x: i * -100, y: i * 100 });
    assert.deepEqual(companion.pet.getBounds(), { x: 650, y: 330, width: 112, height: 128 });
    assert.deepEqual(companion.bubble.getBounds(), { x: 282, y: 230, width: 360, height: 228 });
    await action(event, { action: 'drag-end' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
