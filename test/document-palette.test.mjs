import test from 'node:test';
import assert from 'node:assert/strict';
import { makePalette,quantize,expandIndices } from '../src/document-palette.mjs';
import { openSession,openSeries,paletteDocument,paint,stepHistory,exportFrame,exportEditableDocument,exportSeries,closeSession } from '../src/editor-session.mjs';
import { decodeEditorDocument } from '../src/editor-document.mjs';
import { compositeFrame } from '../src/sprite-document.mjs';
import '../src/brush-engine.js';
test('palette indices preserve true transparency and partial alpha and reject outside indices',()=>{
  const input=Uint8Array.from([250,30,50,255,80,160,50,128,0,0,0,0]);const palette=makePalette([input],4),result=quantize(input,palette);assert.deepEqual([...expandIndices(result.indices,palette)],[...input]);assert.throws(()=>expandIndices([255],palette));
});
test('indexed document preview does not mutate, conversion and entry replacement undo, sidecar preserves indices',()=>{
  const pixels=Uint8Array.from([255,0,0,255,0,255,0,255,0,0,0,0,255,0,0,255]),session=openSession({width:2,height:2,pixels}),id=session.sessionId;
  try{const preview=paletteDocument(id,{limit:3,preview:true});assert.deepEqual([...preview.composite],[...pixels]);assert.equal(exportEditableDocument(id).colorMode,'rgba');const converted=paletteDocument(id,{palette:[[0,0,0,0],[255,0,0,255],[0,255,0,255]]});assert.equal(converted.colorMode,'indexed');paint(id,{from:[0,0],to:[0,0],color:[230,20,20,255]});const encoded=exportEditableDocument(id);assert.ok(encoded.layers[0].indices);assert.equal(encoded.layers[0].pixels,undefined);const doc=decodeEditorDocument(encoded,{width:2,height:2});assert.deepEqual([...compositeFrame(doc,0)],[...pixels]);paletteDocument(id,{replaceIndex:1,color:[0,0,255,255]});assert.deepEqual([...exportFrame(id).composite.subarray(0,4)],[0,0,255,255]);stepHistory(id);assert.deepEqual([...exportFrame(id).composite.subarray(0,4)],[255,0,0,255]);paletteDocument(id,{mode:'rgba'});assert.equal(exportEditableDocument(id).colorMode,'rgba');stepHistory(id);assert.equal(exportEditableDocument(id).colorMode,'indexed');}finally{closeSession(id);}
});
test('shared indexed series survives reopening with exact indices and durations',()=>{
  const pixels=Buffer.alloc(4*4*4,255),opened=openSeries({frames:[{index:0,width:4,height:4,pixels,durationMs:80},{index:1,width:4,height:4,pixels,durationMs:230}]});let reopened;
  try{paletteDocument(opened.sessionId,{limit:4});const frames=exportSeries(opened.sessionId);reopened=openSeries({frames:frames.map(f=>({index:f.frameIndex,width:4,height:4,pixels:f.composite,durationMs:f.durationMs,editableDocument:f.editableDocument}))});assert.equal(reopened.colorMode,'indexed');assert.deepEqual(exportSeries(reopened.sessionId).map(f=>f.durationMs),[80,230]);}finally{closeSession(opened.sessionId);if(reopened)closeSession(reopened.sessionId);}
});
test('seamless square brush wraps coverage once around both canvas edges; erase mirrors it',()=>{
  const brush=globalThis.SpriteLabBrush,empty=new Uint8ClampedArray(8*8*4),painted=brush.stroke(empty,8,8,{points:[[0,0]],size:3,color:[50,120,80,255],wrap:true});for(const[x,y]of[[0,0],[7,7],[1,7],[7,1]])assert.deepEqual([...painted.subarray((y*8+x)*4,(y*8+x+1)*4)],[50,120,80,255]);const erased=brush.stroke(painted,8,8,{points:[[0,0]],size:3,erase:true,wrap:true});assert.deepEqual(erased,empty);
});
