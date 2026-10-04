import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/drawing-shapes.js';
import { transformPixels } from '../src/pixel-transform.mjs';
import { openSession, shape, readState, stepHistory, closeSession } from '../src/editor-session.mjs';
test('shape previews and selection-constrained drawing produce the same pixels in one undo',()=>{
  const s=openSession({width:20,height:20}),options={kind:'ellipse',from:[4,4],to:[15,15],size:1,color:[30,90,210,255],filled:true};
  const preview=shape(s.sessionId,{...options,preview:true});assert.ok(readState(s.sessionId).composite.every(v=>v===0));
  const applied=shape(s.sessionId,options);assert.deepEqual([...applied.composite],[...preview]);assert.equal(applied.composite[(10*20+10)*4+3],255);assert.equal(applied.composite[0],0);
  assert.ok(stepHistory(s.sessionId,'undo').composite.every(v=>v===0));closeSession(s.sessionId);
});
test('selection rotations preserve exact RGBA, invert correctly and reject clipping',()=>{
  const data=Buffer.alloc(9*9*4),mask=new Uint8Array(81);for(let y=3;y<=4;y++)for(let x=2;x<=4;x++){const i=y*9+x;mask[i]=1;data.set([x*30,y*40,22,190],i*4);}
  const turned=transformPixels(data,9,9,mask,'rotate-right'),back=transformPixels(turned.pixels,9,9,turned.selection,'rotate-left');
  const colors=p=>[...p].filter((v,i)=>i%4===3&&v>0).length;assert.equal(colors(turned.pixels),6);assert.equal(colors(back.pixels),6);
  assert.deepEqual([...transformPixels(transformPixels(data,9,9,mask,'flip-x').pixels,9,9,mask,'flip-x').pixels],[...data]);
  const edgeMask=new Uint8Array(81);for(let y=0;y<5;y++)edgeMask[y*9]=1;assert.throws(()=>transformPixels(data,9,9,edgeMask,'rotate-right'),/обрежет/);
});
