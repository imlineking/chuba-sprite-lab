import test from 'node:test';
import assert from 'node:assert/strict';
import { fillLettering, repairMask } from '../src/text-repair.mjs';
import { openSession, selectPixels, exportActivePixels, previewActivePixels, replaceActivePixels, stepHistory, closeSession } from '../src/editor-session.mjs';
test('lettering repair fills the explicit mask and preserves every other RGBA byte', () => {
  const width = 20, height = 12, pixels = Buffer.alloc(width * height * 4), mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) pixels.set([23, 91, 72, 200], i * 4);
  for (const i of [84, 85, 104, 105]) { pixels.set([250, 250, 250, 200], i * 4); mask[i] = 1; }
  pixels.set([0,0,0,0], 0);
  const result = fillLettering(pixels, width, height, mask);
  for (let i = 0; i < mask.length; i++) assert.deepEqual([...result.subarray(i * 4, i * 4 + 4)], mask[i] ? [23,91,72,200] : [...pixels.subarray(i * 4,i * 4+4)]);
  assert.throws(() => repairMask(pixels,new Uint8Array(mask.length).fill(1),width,height), /только старые буквы/);
});
test('lettering preview has no mutation; application is undoable and constrained by selection', () => {
  const original = Buffer.alloc(10*10*4,255), s = openSession({width:10,height:10,pixels:original});
  selectPixels(s.sessionId,{from:[3,3],to:[4,4]});const source=exportActivePixels(s.sessionId), changed=Buffer.from(original);changed.fill(61);
  const preview=previewActivePixels(s.sessionId,{pixels:changed,layerId:source.layerId});assert.equal(preview[0],61);
  assert.deepEqual(exportActivePixels(s.sessionId).pixels,source.pixels);
  const applied=replaceActivePixels(s.sessionId,{pixels:changed,layerId:source.layerId}); assert.equal(applied.composite[0],255); assert.equal(applied.composite[(3*10+3)*4],61);
  assert.deepEqual([...stepHistory(s.sessionId,'undo').composite],[...original]);assert.equal(stepHistory(s.sessionId,'redo').composite[(3*10+3)*4],61);closeSession(s.sessionId);
});
