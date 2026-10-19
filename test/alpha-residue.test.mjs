import assert from 'node:assert/strict';
import test from 'node:test';
import { analyseAlphaResidue, applyResidueMask } from '../src/alpha-residue.mjs';
import { knownGridRegions, segmentationPlan } from '../src/ai-segmentation.mjs';
import { analyseFrame, planAutoPilot } from '../src/auto-pilot.mjs';
import { refineEdgeRgba } from '../src/edge-refine.mjs';

function fixture() {
  const info={width:64,height:64,channels:4},data=Buffer.alloc(64*64*4);
  for(let y=10;y<54;y++)for(let x=10;x<54;x++)data.set([25,95,38,255],(y*64+x)*4);
  for(let y=10;y<16;y++)for(let x=10;x<54;x++)data.set([215,215,215,255],(y*64+x)*4);
  // Authored white feature, with material surrounding it.
  for(let y=30;y<38;y++)for(let x=30;x<38;x++)data.set([245,245,245,255],(y*64+x)*4);
  return {data,info};
}

test('opaque neutral rim is measured separately from soft-alpha fringe',()=>{
  const {data,info}=fixture(),evidence=analyseAlphaResidue(data,info),base=analyseFrame(data,info);
  assert.equal(base.fringeScore,0);assert.ok(evidence.neutralEdgePixels>=32);assert.ok(evidence.paperPixels>=48);
  const plan=planAutoPilot({measurements:{...base,edgeMeasurement:'native',paperSuspectPixels:evidence.paperPixels,
    neutralEdgePixels:evidence.neutralEdgePixels,neutralEdgeShare:evidence.neutralEdgeShare},source:{kind:'images'},installed:['toonout']});
  assert.equal(plan.steps[0].stage,'matting');assert.equal(plan.settings.residueOnly,true);
});

test('suspicion never deletes pixels; a semantic proposal cannot grow alpha or alter coloured twigs/RGB',()=>{
  const {data,info}=fixture(),copy=Buffer.from(data),proposed=Buffer.alloc(data.length);
  analyseAlphaResidue(data,info);assert.deepEqual(data,copy);
  const {data:out,report}=applyResidueMask(data,proposed,info);
  assert.ok(report.alphaChanged>0);assert.ok(report.candidatePixels>=report.alphaChanged);
  for(let p=0;p<data.length;p+=4){assert.deepEqual(out.subarray(p,p+3),data.subarray(p,p+3));assert.ok(out[p+3]<=data[p+3]);}
  assert.equal(out[(25*64+25)*4+3],255,'coloured material is outside a pale-only model proposal');
});

test('protected RGB cleanup preserves coherent petals and exact alpha',()=>{
  const {data,info}=fixture(),out=refineEdgeRgba(data,info,{mode:'recolor',width:1,depth:3,whiteOnly:true,whiteThreshold:120,neutralTolerance:55,preserveLightArtwork:true});
  for(let p=3;p<data.length;p+=4)assert.equal(out[p],data[p]);
  for(let y=30;y<38;y++)for(let x=30;x<38;x++){
    const p=(y*64+x)*4;assert.deepEqual(out.subarray(p,p+4),data.subarray(p,p+4));
  }
});

test('known grid covers every original pixel exactly once, including non-divisible dimensions',()=>{
  const rects=knownGridRegions(1672,941,{columns:3,rows:1});
  assert.deepEqual(rects.map(r=>r.width),[557,557,558]);
  assert.deepEqual(rects.map(r=>r.left),[0,557,1114]);
  assert.equal(rects.reduce((sum,r)=>sum+r.width*r.height,0),1672*941);
  assert.equal(knownGridRegions(10,10,null),null,'unknown grid must not be guessed');
  assert.throws(()=>knownGridRegions(10,10,{columns:0,rows:2}),/Сетка/);
  assert.throws(()=>knownGridRegions(10,10,{columns:16,rows:16}),/Сетка/);
});

test('quality plan reports whole-object compatibility and real mirrored maximum mode',()=>{
  const fast=segmentationPlan(1600,1200,'fast',true,null),balanced=segmentationPlan(1600,1200,'balanced',true,null),max=segmentationPlan(1600,1200,'max',true,{columns:2,rows:2});
  assert.equal(fast.quality,'fast');assert.equal(fast.useTiles,false);
  assert.equal(balanced.quality,'fast');assert.equal(balanced.requestedQuality,'balanced');assert.ok(balanced.qualityNote);
  assert.equal(max.quality,'max');assert.equal(max.strategy,'known-grid');assert.equal(max.regions.length,4);
});
