import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/font-match.js';
test('font shape score ignores colour and translation but rejects different geometry', () => {
  const make = (dx, color, length) => { const rgba = new Uint8ClampedArray(60*30*4);for(let y=5;y<20;y++)for(let x=dx;x<dx+length;x++)rgba.set([...color,255],(y*60+x)*4);return globalThis.SpriteLabFontMatch.signature(rgba,60,30); };
  const a=make(4,[255,255,255],30),b=make(15,[1,60,30],30),c=make(4,[255,255,255],5);
  assert.equal(globalThis.SpriteLabFontMatch.score(a,b),0);assert.ok(globalThis.SpriteLabFontMatch.score(a,c)>.2);
});
