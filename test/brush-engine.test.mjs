import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/brush-engine.js';
import { openSession, paint, finishStroke, stepHistory, closeSession } from '../src/editor-session.mjs';
test('soft brush coverage is monotone, hard brush retains native square/round footprints', () => {
  const b=globalThis.SpriteLabBrush;
  assert.equal(b.footprint(10,10,4,'square',100).length,16);assert.equal(b.footprint(10,10,4,'round',100).length,4);
  const soft=b.footprint(10,10,9,'round',0);assert.ok(soft.some(p=>p[2]>0&&p[2]<1));assert.equal(soft.find(p=>p[0]===10&&p[1]===10)[2],1);
});
test('one translucent stroke does not accumulate opacity at overlapping stamps and undoes in one step', () => {
  const s=openSession({width:24,height:16}),id=s.sessionId;
  const settings={color:[80,150,35,255],size:4,opacity:50,continueStroke:true};
  paint(id,{...settings,from:[5,5],to:[10,5],beginStroke:true});paint(id,{...settings,from:[10,5],to:[6,5]});
  const final=finishStroke(id);assert.equal(final.composite[(5*24+8)*4+3],128);assert.equal(final.canUndo,true);
  const undone=stepHistory(id,'undo');assert.equal(undone.canUndo,false);assert.ok(undone.composite.every(v=>v===0));assert.deepEqual([...stepHistory(id,'redo').composite],[...final.composite]);closeSession(id);
});
test('symmetry, soft eraser and Pixel Perfect share the same pixel engine', () => {
  const b=globalThis.SpriteLabBrush,base=new Uint8ClampedArray(10*10*4);
  const sym=b.stroke(base,10,10,{points:[[2,3]],symmetry:'both',color:[4,90,2,255]});for(const [x,y]of[[2,3],[7,3],[2,6],[7,6]])assert.equal(sym[(y*10+x)*4+3],255);
  const erased=b.stroke(sym,10,10,{points:[[2,3]],erase:true,opacity:50});assert.equal(erased[(3*10+2)*4+3],128);assert.equal(erased[(3*10+2)*4],4);
  const pp=b.stroke(base,10,10,{points:[[2,2],[3,2],[3,3]],pixelPerfect:true,color:[255,0,0,255]});assert.equal(pp[(2*10+3)*4+3],0);assert.equal(pp[(3*10+3)*4+3],255);
});
