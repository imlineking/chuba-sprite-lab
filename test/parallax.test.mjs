import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import sharp from 'sharp';
import { normalizeParallaxScene, parallaxPose, drawParallaxScene, assertParallaxPixelBudget } from '../src/parallax-core.mjs';
import { inspectParallaxImages, exportParallaxScene, openParallaxScene } from '../src/parallax-main.mjs';

const scene = () => normalizeParallaxScene({ kind: 'sprite-lab-parallax', version: 1, width: 960, height: 540, layers: [
  { id: 'sky', name: '</script><script>alert(1)</script>', asset: 'assets/sky.png', width: 64, height: 32, parallaxX: .2 },
  { id: 'tree', asset: 'assets/tree.png', width: 64, height: 32, parallaxX: 1, parallaxY: .5 },
] });
test('parallax uses one deterministic camera formula with anchor, offset and float', () => {
  const value = scene(), far = parallaxPose(value, value.layers[0], { x: 100, y: 40 }), near = parallaxPose(value, value.layers[1], { x: 100, y: 40 });
  assert.equal(far.x, 460); assert.equal(near.x, 380); assert.equal(near.y, 520);
  assert.equal(parallaxPose(value, { ...value.layers[0], float: 12 }, { x: 0, y: 0 }, 1).y, 552);
  assert.equal(parallaxPose(value, { ...value.layers[0], parallaxX: 0 }, { x: 900 }).x, 480);
});
test('parallax rejects duplicate ids, network URLs and traversal, bounds numeric values', () => {
  assert.equal(assertParallaxPixelBudget([{ width: 8000, height: 8000 }], [{ width: 8000, height: 8000 }]), 128000000);
  assert.throws(() => assertParallaxPixelBudget([{ width: 8000, height: 8000 }], [{ width: 8000, height: 8001 }]), /128/);
  const value = scene();
  for (const asset of ['https://x/a.png', '../outside.png', 'assets/../x.png', 'file:///a.png', 'assets/x.svg']) assert.throws(() => normalizeParallaxScene({ ...value, layers: [{ ...value.layers[0], asset }] }));
  assert.throws(() => normalizeParallaxScene({ ...value, version: 2 }));
  assert.throws(() => normalizeParallaxScene({ ...value, layers: [value.layers[0], value.layers[0]] }));
  assert.throws(() => normalizeParallaxScene({ ...value, layers: Array(33).fill(value.layers[0]) }));
  assert.equal(normalizeParallaxScene({ ...value, width: 90000 }).width, 4096);
});
test('parallax renderer respects order, visibility and caps horizontal repeats', () => {
  const value = scene(), draws = [];
  const ctx = { clearRect() {}, fillRect() {}, save() {}, restore() {}, translate() {}, rotate() {}, drawImage(image) { draws.push(image); } };
  const images = new Map([['assets/sky.png', 'far'], ['assets/tree.png', 'near']]);
  assert.equal(drawParallaxScene(ctx, value, images, { x: 0, y: 0 }), 2); assert.deepEqual(draws, ['far', 'near']);
  value.layers[0].visible = false; draws.length = 0; drawParallaxScene(ctx, value, images, {}); assert.deepEqual(draws, ['near']);
  value.layers[1].repeatX = true; value.layers[1].scale = .01;
  assert.ok(drawParallaxScene(ctx, value, images, {}) <= 513);
});
test('parallax portable export round-trip preserves assets, escapes HTML and never overwrites', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cslab-parallax-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'sprite.png');
  await sharp({ create: { width: 64, height: 32, channels: 4, background: { r: 30, g: 80, b: 25, alpha: .8 } } }).png().toFile(source);
  const bytes = await fs.readFile(source), value = scene();
  const inspected = (await inspectParallaxImages([source]))[0], assets = { 'assets/sky.png': inspected, 'assets/tree.png': inspected };
  const first = await exportParallaxScene({ scene: value, assets, outputDir: root }), second = await exportParallaxScene({ scene: value, assets, outputDir: root });
  assert.notEqual(first.directory, second.directory);
  const loaded = await openParallaxScene(first.scenePath); assert.deepEqual(loaded.scene, value);
  assert.deepEqual(await fs.readFile(loaded.assets['assets/sky.png'].path), bytes); assert.deepEqual(await fs.readFile(source), bytes);
  const html = await fs.readFile(first.previewPath, 'utf8'); assert.ok(!html.includes('</script><script>alert'));
  assert.ok(!html.includes(root)); new vm.Script(await fs.readFile(path.join(first.directory, 'runtime.js'), 'utf8'));
  const broken = { ...value, layers: [{ ...value.layers[0], width: 45 }] }; await assert.rejects(exportParallaxScene({ scene: broken, assets, outputDir: root }), /изменился/);
});
