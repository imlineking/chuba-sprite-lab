import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { planAtlas, processAnimationSet } from '../src/processor.mjs';
test('global atlas reuse crosses animation groups, keeps metadata and survives scaling/split',()=>{
  const a={width:18,height:18,textureKey:'same',offsetX:2},b={width:18,height:18,textureKey:'same',offsetX:7},c={width:18,height:18,textureKey:'other'};
  const groups=[{items:[a,c],cellWidth:24,cellHeight:24,columns:2},{items:[b],cellWidth:32,cellHeight:32,columns:1}];
  for(const overflow of['split','scale']){const atlas=planAtlas(groups,{packing:'maxrects',maxSize:24,overflow,gap:0});assert.equal(atlas.pages.reduce((n,p)=>n+p.rects.length,0),2);assert.equal(atlas.groups[1].items[0].offsetX,7);assert.equal(atlas.pages.flatMap(p=>p.rects).flatMap(r=>r.aliases||[]).length,1);}
  assert.equal(planAtlas(groups,{packing:'maxrects',maxSize:24,overflow:'split',gap:0,deduplicate:false}).pages.flatMap(p=>p.rects).length,3);
});
test('export retains logical frames and durations while identical images occupy one atlas rectangle',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'chuba-dedup-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const file=path.join(directory,'same.png');await sharp({create:{width:24,height:24,channels:4,background:{r:40,g:90,b:20,alpha:1}}}).png().toFile(file);
  const result=await processAnimationSet({animations:[{name:'idle',source:{kind:'frames',paths:[file]},options:{timeline:[{src:0,durationMs:80},{src:0,durationMs:160}]}},{name:'walk',source:{kind:'frames',paths:[file]},options:{timeline:[{src:0,durationMs:240}]}}],appRoot:path.resolve('.'),outputDir:directory,name:'reuse',options:{keyMode:'alpha',anchor:'center',autoSize:false,cellWidth:32,cellHeight:32,padding:0,preserveFrameCanvas:true,packing:'maxrects',atlasGap:0,exports:{sheet:true,frames:false,metadata:true,preview:false}}});
  const manifest=JSON.parse(await fs.readFile(result.manifestPath,'utf8'));assert.equal(manifest.frames.length,3);assert.deepEqual(manifest.frames.map(f=>f.durationMs),[80,160,240]);assert.equal(new Set(manifest.frames.map(f=>[f.page,f.x,f.y,f.width,f.height].join(':'))).size,1);assert.equal(manifest.animations.length,2);
});

