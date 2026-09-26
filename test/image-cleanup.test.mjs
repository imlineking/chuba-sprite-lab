import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { applyMaskEdits } from "../src/mask-edits.mjs";
import { checkerMask, removeChecker } from "../src/region-color.mjs";
import { processImageBatch, previewWithModelFallback } from "../src/image-batch.mjs";
import { planAutoPilot } from "../src/auto-pilot.mjs";
import { planSuggestions, planTaskScenarios } from "../src/copilot-rules.mjs";

test("selected colour removal preserves other colours, outside white and other files; keep can restore it", () => {
  const info = { width: 10, height: 10, channels: 4 };
  const original = Buffer.alloc(400, 255); original.set([0, 180, 30, 255], (2 * 10 + 2) * 4);
  const edits = [{ type: "region-color", color: [255,255,255], tolerance: 0, selection: { left: 0, right: .5, top: 0, bottom: .5 }, frameIndex: 2 }];
  const data = Buffer.from(original); applyMaskEdits(data, original, info, edits, 2);
  assert.equal(data[(1 * 10 + 1) * 4 + 3], 0);
  assert.equal(data[(2 * 10 + 2) * 4 + 3], 255);
  assert.equal(data[(8 * 10 + 8) * 4 + 3], 255);
  const other = Buffer.from(original); applyMaskEdits(other, original, info, edits, 0); assert.deepEqual(other, original);
  applyMaskEdits(data, original, info, [{ mode: "keep", x: 1/9, y: 1/9, radius: .1, frameIndex: 2 }], 2);
  assert.equal(data[(1 * 10 + 1) * 4 + 3], 255);
});

test("lasso removal obeys the polygon rather than its bounding rectangle", () => {
  const info = { width: 10, height: 10, channels: 4 }, original = Buffer.alloc(400, 255), data = Buffer.from(original);
  applyMaskEdits(data, original, info, [{ type: "region-color", frameIndex: 0, color: [255,255,255], tolerance: 0, selection: { points: [{x:0,y:0},{x:1,y:0},{x:0,y:1}] } }], 0);
  assert.equal(data[(1 * 10 + 1) * 4 + 3], 0);
  assert.equal(data[(8 * 10 + 8) * 4 + 3], 255);
});

test("checker removal needs a repeated 2D pattern and respects selection; an isolated white flower survives", () => {
  const info = { width: 80, height: 64, channels: 4 }, original = Buffer.alloc(80*64*4);
  for (let y=0;y<64;y++) for(let x=0;x<64;x++) { const gray=((x>>3)+(y>>3))%2 ? 210 : 255; original.set([gray,gray,gray,255],(y*80+x)*4); }
  original.set([255,255,255,255], (30*80+75)*4);
  const data=Buffer.from(original);
  const result=checkerMask(data,info); assert.ok(result.count>3500); assert.ok(result.sizes.includes(8));
  applyMaskEdits(data,original,info,[{type:"checker",frameIndex:0,selection:{left:0,right:.4,top:0,bottom:1}}]);
  assert.equal(data[(20*80+10)*4+3],0); assert.equal(data[(20*80+50)*4+3],255); assert.equal(data[(30*80+75)*4+3],255);
  assert.equal(checkerMask(Buffer.alloc(80*64*4,255),info).count,0);
});

test("checker cleanup follows broken boundary tiles and narrow gray strips but preserves isolated white artwork", () => {
  const info = { width: 120, height: 80, channels: 4 }, original = Buffer.alloc(120*80*4);
  for(let y=8;y<56;y++) for(let x=8;x<56;x++) {
    const value=(Math.floor(x/8)+Math.floor(y/8))%2 ? 210 : 255;
    original.set([value,value,value,255],(y*120+x)*4);
  }
  // A narrow remnant has no full tile or diagonal partner of its own.
  for(let x=56;x<100;x++)original.set([210,210,210,255],(31*120+x)*4);
  for(let y=62;y<74;y++) for(let x=85;x<97;x++)original.set([255,255,255,255],(y*120+x)*4);
  original.set([180,210,165,255],(31*120+100)*4);
  const data=Buffer.from(original);applyMaskEdits(data,original,info,[{type:"checker",frameIndex:0}]);
  assert.equal(data[(31*120+99)*4+3],0);
  assert.equal(data[(66*120+90)*4+3],255);
  assert.equal(data[(31*120+100)*4+3],255);
});

test("checker cleanup handles soft alpha and unmixes a pale rim without altering a compact white detail", () => {
  const info={width:120,height:80,channels:4}, original=Buffer.alloc(120*80*4);
  for(let y=8;y<56;y++) for(let x=8;x<56;x++) {
    const value=(Math.floor(x/8)+Math.floor(y/8))%2?210:255;
    original.set([value,value,value,255],(y*120+x)*4);
  }
  original.set([210,210,210,160],(25*120+56)*4);
  original.set([199,229,199,200],(31*120+56)*4);
  original.set([30,150,30,255],(31*120+57)*4);
  for(let y=60;y<72;y++)for(let x=62;x<74;x++)original.set([255,255,255,255],(y*120+x)*4);
  const data=Buffer.from(original),result=removeChecker(data,original,info);
  assert.equal(data[(25*120+56)*4+3],0);
  assert.ok(result.fringeCount>0);
  assert.deepEqual([...data.subarray((31*120+56)*4,(31*120+56)*4+3)],[30,150,30]);
  assert.ok(data[(31*120+56)*4+3]>=45&&data[(31*120+56)*4+3]<=55);
  assert.equal(data[(66*120+66)*4+3],255);
  applyMaskEdits(data,original,info,[{mode:"keep",frameIndex:0,x:56/119,y:31/79,radius:.03}]);
  assert.deepEqual([...data.subarray((31*120+56)*4,(31*120+56)*4+4)],[199,229,199,200]);
});

test("standalone PNG export preserves canvas, names, source and frame-specific masks, without atlas JSON", async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"chuba-single-images-"));
  try {
    const source=path.join(root,"flower.png"), out=path.join(root,"out");
    await sharp({create:{width:211,height:137,channels:4,background:"#ffffff"}}).png().toFile(source);
    const before=await fs.readFile(source);
    const options={keyMode:"alpha",previewFrameIndex:0,aiEdits:[{type:"region-color",frameIndex:5,color:[255,255,255],tolerance:0,selection:{left:0,right:.2,top:0,bottom:.2}}]};
    const result=await processImageBatch({paths:[source],sourceIndexes:[5],outputDir:out,options,outputKind:"images"});
    assert.equal(result.completed,1);assert.equal(result.results[0].manifestPath,undefined);
    const raw=await sharp(result.results[0].imagePath).raw().toBuffer({resolveWithObject:true});
    assert.equal(raw.info.width,211);assert.equal(raw.info.height,137);assert.equal(raw.data[3],0);assert.equal(raw.data[(100*211+100)*4+3],255);
    assert.deepEqual(await fs.readFile(source),before);
    const again=await processImageBatch({paths:[source],outputDir:out,options:{keyMode:"alpha"},outputKind:"images"});
    assert.equal(path.basename(again.results[0].imagePath),"flower-2.png");
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test("image intent offers three paths and never inherits animation warnings or unrequested AI resize", () => {
  const scenarios=planTaskScenarios({source:{kind:"frames",frameCount:50,mixedSizes:true}});
  assert.deepEqual(scenarios.slice(0,3).map(item=>item.task),["edit","combine","animation"]);
  assert.deepEqual(planSuggestions({source:{kind:"frames"},ui:{intent:"images"},built:{warnings:["скачок силуэта"]}}),[]);
  const plan=planAutoPilot({measurements:{width:96,height:96,transparentShare:.7,borderOpaqueRatio:0,checkerPixels:300},target:{intent:"images",cellWidth:2048,cleanupRequested:true},source:{kind:"images",frameCount:50},installed:["u2netp"]});
  assert.ok(plan.steps.some(step=>step.stage==="checker"));
  assert.equal(plan.steps.some(step=>["upscale","interpolate","atlas"].includes(step.stage)),false);
});

test("orchestrator recovers a GPU memory failure on CPU and records its decision; unrelated errors are not hidden", async () => {
  const calls=[];
  const preview=async request => { calls.push(request.options); if(request.options.aiProvider !== "cpu") throw new Error("Dml 8007000E out of memory"); return {afterPath:"clean.png"}; };
  const result=await previewWithModelFallback({inputPath:"source.png",options:{keyMode:"ai",aiProvider:"auto",aiModel:"birefnet-tiny",aiQuality:"max"},automatic:true,installed:["birefnet-tiny"],preview});
  assert.equal(calls.length,2);assert.equal(result.fallback.provider,"cpu");assert.equal(result.fallback.quality,"balanced");
  let attempts=0;
  await assert.rejects(previewWithModelFallback({inputPath:"source.png",options:{keyMode:"ai"},automatic:true,preview:async()=>{attempts++;throw new Error("Invalid PNG");}}),/Invalid PNG/);
  assert.equal(attempts,1);
});
