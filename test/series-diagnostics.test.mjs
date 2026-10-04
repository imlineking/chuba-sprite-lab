import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { reviewSeries } from '../src/series-review.mjs';
async function png(left,width=24,halo=false){return sharp(Buffer.from(`<svg width="128" height="128"><rect x="${left}" y="24" width="${width}" height="80" fill="#206830"${halo?' stroke="white" stroke-width="2"':''}/></svg>`)).png().toBuffer();}
test('animation diagnostics report repeated endpoint, sliding support and mask flicker without editing',async()=>{
  const a=await png(10),b=await png(80),buffers=[a,b,a],frames=buffers.map((buffer,sourceIndex)=>({buffer,sourceIndex}));const report=await reviewSeries(frames);
  for(const code of['series-repeated-end','series-foot-slide','series-mask-flicker'])assert.ok(report.issues.some(i=>i.code===code),code);
  assert.equal(report.diagnosticOnly,true);for(let i=0;i<3;i++)assert.deepEqual(frames[i].buffer,buffers[i]);
});
test('light fringe is a warning, while a clean green object and held frame remain unchanged',async()=>{
  const clean=await png(40),halo=await png(40,24,true),a=await reviewSeries([{buffer:halo,sourceIndex:0}]);assert.ok(a.issues.some(i=>i.code==='series-edge-fringe'));
  assert.equal((await reviewSeries([clean,clean,clean].map((buffer,sourceIndex)=>({buffer,sourceIndex})))).issues.length,0);
});
