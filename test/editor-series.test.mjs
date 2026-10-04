import test from 'node:test';
import assert from 'node:assert/strict';
import { openSeries, paint, switchFrame, stepHistory, exportSeries, setTextLayer, textAcrossFrames, markSessionSaved, closeSession, deleteLayer } from '../src/editor-session.mjs';
test('series editor shares undo history, frame timing, onion and saves every frame', () => {
  const frames=[0,2,3].map(index=>({index,width:8,height:8,pixels:Buffer.alloc(256),durationMs:80+index*10}));
  const state=openSeries({frames,frameIndex:0}),id=state.sessionId;
  assert.deepEqual(state.frameIndices,[0,2,3]);assert.equal(state.dirty,false);
  paint(id,{from:[2,2],color:[120,30,20,255]});switchFrame(id,{frameIndex:2});paint(id,{from:[3,3],color:[30,120,20,255]});
  const undone=stepHistory(id,'undo');assert.equal(undone.frameIndex,2);assert.ok(undone.composite.every(v=>v===0));
  const undoneFirst=stepHistory(id,'undo');assert.equal(undoneFirst.frameIndex,0);assert.equal(undoneFirst.dirty,false);
  stepHistory(id,'redo');stepHistory(id,'redo');const onion=switchFrame(id,{frameIndex:2,onion:true});assert.equal(onion.onion.length,2);
  switchFrame(id,{durationMs:240});assert.equal(stepHistory(id,'undo').durationMs,100);assert.equal(stepHistory(id,'redo').durationMs,240);
  const exported=exportSeries(id);assert.equal(exported.length,3);assert.equal(exported[1].durationMs,240);assert.equal(exported[0].composite[(2*8+2)*4],120);
  assert.equal(markSessionSaved(id).dirty,false);assert.match(deleteLayer(id).blocked,/последний слой/);closeSession(id);
});
test('common lettering keeps placement and editability across a series and portable frame documents', () => {
  const frames=[0,1].map(index=>({index,width:6,height:6,pixels:Buffer.alloc(144)})),state=openSeries({frames}),id=state.sessionId;
  const pixels=Buffer.alloc(144);pixels.set([250,90,20,255],(2*6+2)*4);
  setTextLayer(id,{pixels,text:{text:'A',x:2,y:2}});textAcrossFrames(id);
  const other=switchFrame(id,{frameIndex:1});assert.equal(other.layers.filter(l=>l.kind==='text').length,1);assert.equal(other.composite[(2*6+2)*4],250);
  const changed=Buffer.from(pixels);changed.set([10,40,250,255],(2*6+2)*4);setTextLayer(id,{layerId:other.activeLayerId,pixels:changed,text:{text:'B',x:2,y:2}});
  const all=exportSeries(id);assert.ok(all.every(f=>f.composite[(2*6+2)*4]===10));
  const reopened=openSeries({frames:all.map(f=>({index:f.frameIndex,width:f.width,height:f.height,pixels:f.composite,editableDocument:f.editableDocument}))});
  const rOther=switchFrame(reopened.sessionId,{frameIndex:1});assert.equal(rOther.layers.find(l=>l.kind==='text').text.text,'B');
  setTextLayer(reopened.sessionId,{layerId:rOther.activeLayerId,pixels,text:{text:'C'}});assert.ok(exportSeries(reopened.sessionId).every(f=>f.composite[(2*6+2)*4]===250));closeSession(id);closeSession(reopened.sessionId);
});
