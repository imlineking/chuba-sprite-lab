import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAPNG,decodeAPNG,encodeGIF,decodeGIF,pngChunks } from '../src/animated-images.mjs';
test('APNG roundtrips exact RGBA including partial alpha, durations, repeat and duplicate frames',async()=>{
  const first=Buffer.alloc(12*9*4),second=Buffer.alloc(first.length);first.set([40,200,50,128],(3*12+2)*4);second.set([220,10,30,255],(4*12+7)*4);
  const frames=[{pixels:first,durationMs:83},{pixels:second,durationMs:240},{pixels:second,durationMs:115}];const encoded=encodeAPNG(frames,12,9,{loop:2}),decoded=await decodeAPNG(encoded);
  assert.equal(decoded.loop,2);assert.deepEqual(decoded.frames.map(f=>f.durationMs),[83,240,115]);for(let i=0;i<3;i++)assert.deepEqual(decoded.frames[i].pixels,frames[i].pixels);
  const damaged=Buffer.from(encoded);damaged[90]^=1;assert.throws(()=>pngChunks(damaged),/сумма/);
});
test('GIF roundtrips transparent/opaque pixel art and all frame timings',async()=>{
  const first=Buffer.alloc(12*9*4),second=Buffer.alloc(first.length);first.set([0,255,0,255],(3*12+2)*4);second.set([255,0,0,255],(4*12+7)*4);
  const encoded=await encodeGIF([{pixels:first,durationMs:80},{pixels:second,durationMs:230},{pixels:second,durationMs:110}],12,9,{loop:1}),decoded=await decodeGIF(encoded);
  assert.equal(decoded.frames.length,3);assert.equal(decoded.loop,1);assert.deepEqual(decoded.frames.map(f=>f.durationMs),[80,230,110]);assert.deepEqual(decoded.frames[0].pixels,first);assert.deepEqual(decoded.frames[1].pixels,second);
});
