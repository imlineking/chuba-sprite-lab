import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { openSession, setTextLayer, previewTextLayer, rasterizeTextLayer, stepHistory, readState, exportFrame, exportEditableDocument, resetSessionsForTests, paint, deleteLayer, updateLayer, adjustFrame } from '../src/editor-session.mjs';
import { savePortableProject, loadPortableProject, missingProjectFiles } from '../src/project-storage.mjs';
afterEach(resetSessionsForTests);
const pixels = (...colors) => Uint8ClampedArray.from(colors.flat());
const settings = { text: 'Жук\nЁлка', font: 'Arial', x: 1, y: 2, stroke: 1, spacing: 2, lineGap: 3 };

test('text creation, movement and deletion preserve pixels and metadata through undo/redo', () => {
  const original = pixels([1, 2, 3, 255], [0, 0, 0, 0]);
  const session = openSession({ width: 2, height: 1, pixels: original });
  const raster = pixels([0, 0, 0, 0], [255, 255, 255, 180]);
  const added = setTextLayer(session.sessionId, { text: settings, pixels: raster });
  const id = added.activeLayerId;
  assert.equal(added.layers[1].kind, 'text'); assert.equal(added.layers[1].text.text, settings.text);
  assert.deepEqual([...stepHistory(session.sessionId).composite], [...original]);
  assert.equal(readState(session.sessionId).layers.length, 1);
  assert.equal(stepHistory(session.sessionId, 'redo').layers[1].text.font, 'Arial');
  const moved = setTextLayer(session.sessionId, { layerId: id, text: { ...settings, x: 5 }, pixels: raster });
  assert.equal(moved.layers[1].text.x, 5);
  assert.equal(stepHistory(session.sessionId).layers[1].text.x, 1);
  stepHistory(session.sessionId, 'redo');
  deleteLayer(session.sessionId, { layerId: id });
  assert.equal(readState(session.sessionId).layers.length, 1);
  assert.deepEqual([...stepHistory(session.sessionId).composite], [...added.composite]);
  assert.equal(readState(session.sessionId).layers[1].text.x, 5);
});

test('text previews respect the stack, hidden layers and opacity without altering history', () => {
  const session = openSession({ width: 1, height: 1, pixels: pixels([10, 20, 30, 255]) });
  const overlay = pixels([200, 100, 0, 255]);
  const before = readState(session.sessionId);
  assert.equal(previewTextLayer(session.sessionId, { pixels: overlay })[0], 200);
  assert.deepEqual(readState(session.sessionId), before);
  const added = setTextLayer(session.sessionId, { text: settings, pixels: overlay });
  updateLayer(session.sessionId, { opacity: 128 });
  const preview = previewTextLayer(session.sessionId, { layerId: added.activeLayerId, pixels: pixels([255, 0, 0, 255]) });
  assert.equal(preview[0], 133); assert.equal(readState(session.sessionId).composite[0], 105);
  updateLayer(session.sessionId, { visible: false });
  assert.equal(previewTextLayer(session.sessionId, { layerId: added.activeLayerId, pixels: overlay })[0], 10);
});

test('text resists accidental painting until converted; conversion and lock are reversible', () => {
  const session = openSession({ width: 1, height: 1 });
  setTextLayer(session.sessionId, { text: settings, pixels: pixels([200, 100, 0, 255]) });
  assert.match(paint(session.sessionId, { from: [0, 0] }).blocked, /текстовый/);
  updateLayer(session.sessionId, { locked: true });
  assert.match(rasterizeTextLayer(session.sessionId).blocked, /заблокирован/);
  stepHistory(session.sessionId);
  assert.equal(rasterizeTextLayer(session.sessionId).layers[1].kind, 'normal');
  assert.equal(stepHistory(session.sessionId).layers[1].kind, 'text');
});

test('editable documents roundtrip the original raster without depending on installed fonts', () => {
  const session = openSession({ width: 2, height: 1, frameIndex: 3 });
  setTextLayer(session.sessionId, { text: { ...settings, font: 'Missing installed font' }, pixels: pixels([7, 88, 199, 100], [255, 255, 255, 255]) });
  const frame = exportFrame(session.sessionId), saved = exportEditableDocument(session.sessionId);
  const restored = openSession({ width: 2, height: 1, frameIndex: 8, pixels: frame.composite, editableDocument: saved });
  assert.equal(restored.frameIndex, 8); assert.deepEqual([...restored.composite], [...frame.composite]);
  assert.equal(restored.layers[1].text.font, 'Missing installed font');
  assert.throws(() => openSession({ width: 3, height: 1, editableDocument: saved }), /размеру/);
  assert.throws(() => openSession({ width: 2, height: 1, editableDocument: saved, pixels: pixels([0, 0, 0, 0], [0, 0, 0, 0]) }), /изменились/);
  assert.throws(() => openSession({ width: 2, height: 1, editableDocument: { ...saved, layers: [{ pixels: 'broken' }] } }));
});

test('whole-frame grading cannot silently invalidate editable text settings', () => {
  const session = openSession({ width: 1, height: 1 });
  setTextLayer(session.sessionId, { text: settings, pixels: pixels([200, 100, 0, 255]) });
  const before = exportFrame(session.sessionId);
  assert.throws(() => adjustFrame(session.sessionId, { adjustments: { brightness: 20 } }), /текст/);
  assert.deepEqual(exportFrame(session.sessionId), before);
  rasterizeTextLayer(session.sessionId);
  adjustFrame(session.sessionId, { adjustments: { brightness: 20 } });
  assert.notEqual(exportFrame(session.sessionId).composite[0], before.composite[0]);
});

test('portable projects carry editable layers for all animations when relocated', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cslab-text-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'image.png'), doc = path.join(root, 'frame.csframe');
  await fs.writeFile(source, 'image'); await fs.writeFile(doc, 'layers');
  const document = { format: 'chuba-sprite-lab-project', source: { kind: 'frames', paths: [source] }, frameOverrides: { 0: source }, frameDocuments: { 0: { path: doc, imagePath: source } } };
  await savePortableProject(path.join(root, 'old', 'example.cslab'), { ...document, animations: [{ id: 'b', document }] });
  await fs.rename(path.join(root, 'old'), path.join(root, 'moved')); await fs.unlink(doc); await fs.unlink(source);
  const loaded = await loadPortableProject(path.join(root, 'moved', 'example.cslab'));
  assert.deepEqual(await missingProjectFiles(loaded.project), []);
  assert.equal(await fs.readFile(loaded.project.animations[0].document.frameDocuments[0].path, 'utf8'), 'layers');
  assert.equal(loaded.project.frameDocuments[0].imagePath, loaded.project.frameOverrides[0]);
});
