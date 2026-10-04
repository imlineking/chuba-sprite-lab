import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {adjustImageRgba} from '../src/color-adjust.mjs';
import {openSession,adjustFrame,stepHistory,closeSession} from '../src/editor-session.mjs';
import {inspectSource,processFramePreview,processSprites} from '../src/processor.mjs';
import {processImageBatch} from '../src/image-batch.mjs';
import {readProfile,profileFormat,profileVersion} from '../src/build-profile.mjs';

const styles=globalThis.SpriteLabColorStyles;
const fixture=Buffer.from([210,40,30,255,220,180,30,128,255,255,255,255,0,0,0,255,60,140,70,255,200,100,70,0]);
const luminance=(rgb,i)=>.2126*rgb[i]+.7152*rgb[i+1]+.0722*rgb[i+2];
test('all fixed styles preserve alpha, hidden RGB, luminance and input; neutral hue-family details survive',()=>{
  const before=Buffer.from(fixture);
  for(const {id} of styles.styles){
    const out=adjustImageRgba(fixture,{style:id});
    for(let i=0;i<out.length;i+=4){assert.equal(out[i+3],fixture[i+3]);assert.ok(Math.abs(luminance(out,i)-luminance(fixture,i))<.6);}
    assert.deepEqual(out.subarray(20),fixture.subarray(20));
    assert.deepEqual(adjustImageRgba(fixture,{style:id,styleStrength:0}),fixture);
    assert.deepEqual(out,Buffer.from(globalThis.SpriteLabPixelColors.adjust(fixture,{style:id})));
  }
  const mapped=adjustImageRgba(fixture,{style:'warm-to-cool'});
  assert.ok(mapped[1]>mapped[0] && mapped[1]>mapped[2]);
  assert.ok(mapped[6]>mapped[4]);
  assert.deepEqual(mapped.subarray(8,16),fixture.subarray(8,16));assert.deepEqual(fixture,before);
  assert.throws(()=>adjustImageRgba(fixture,{style:'invented'}),/Неизвестный/);
});
test('live colour preview is the exact committed editor result and one undo restores it',()=>{
  const session=openSession({width:6,height:1,pixels:fixture});
  try {
    const options={style:'cool-to-warm',styleStrength:68,contrast:12,warmth:7};
    const original=Uint8ClampedArray.from(session.composite), preview=globalThis.SpriteLabPixelColors.adjust(original,options);
    const changed=adjustFrame(session.sessionId,{adjustments:options});assert.deepEqual(changed.composite,preview);
    assert.deepEqual(stepHistory(session.sessionId).composite,original);
    assert.deepEqual(stepHistory(session.sessionId,'redo').composite,preview);
  } finally {closeSession(session.sessionId);}
});
test('saved recipes keep style settings and reject unknown styles or invalid strengths',()=>{
  const profile=options=>({format:profileFormat,version:profileVersion,name:'styles',source:{kind:'frames',paths:['a.png']},options:{colorAdjust:options}});
  const options={style:'cool',styleStrength:70,brightness:5};
  assert.deepEqual(readProfile(profile(options)).animations[0].options.colorAdjust,options);
  for(const bad of [{style:'other'},{style:'cool',styleStrength:101},{warmth:Infinity},{customStyle:true}])assert.throws(()=>readProfile(profile(bad)),/colorAdjust/);
});
test('PNG preview, batch, cached atlas and shared-palette export use the same series colour map',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'chuba-colour-p2-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const appRoot=path.resolve('.'), paths=[];
  for(let i=0;i<2;i++){const file=path.join(root,`${i}.png`);await sharp(fixture,{raw:{width:6,height:1,channels:4}}).png().toFile(file);paths.push(file);}
  const source=await inspectSource({kind:'frames',paths,appRoot});
  const options={keyMode:'alpha',colorAdjust:{style:'warm-to-cool',styleStrength:78},preserveFrameCanvas:true,padding:0,exports:{frames:true,sheet:true,metadata:true,preview:false}};
  const raw=file=>sharp(file).ensureAlpha().raw().toBuffer();
  const original=await raw(paths[0]), expected=adjustImageRgba(original,options.colorAdjust);
  const preview=await processFramePreview({inputPath:paths[0],appRoot,options});assert.deepEqual(await raw(preview.afterPath),expected);
  const batch=await processImageBatch({paths,appRoot,outputDir:path.join(root,'batch'),outputKind:'images',options:{...options,captureColorBase:true}});assert.equal(batch.failed,0,JSON.stringify(batch.failures));
  for(const item of batch.results)assert.deepEqual(await raw(item.imagePath),expected);
  for(const item of batch.results)assert.deepEqual(await raw(item.colorBasePath),original);
  const built=await processSprites({source,appRoot,outputDir:root,name:'styled',options});
  for(const file of built.framePaths)assert.deepEqual(await raw(file),expected);
  const changed=await processSprites({source,appRoot,outputDir:root,name:'changed',options:{...options,colorAdjust:{style:'muted'}}});
  assert.notDeepEqual(await raw(changed.framePaths[0]),expected,'style participates in prepared-stage cache key');
  const palette={size:2,colors:4,palette:'auto',paletteScope:'series'};
  const plain=await processSprites({source,appRoot,outputDir:root,name:'plain-pixels',options:{...options,colorAdjust:null,pixelate:palette}});
  const colored=await processSprites({source,appRoot,outputDir:root,name:'styled-pixels',options:{...options,pixelate:palette}});
  for(let i=0;i<2;i++)assert.deepEqual(await raw(colored.framePaths[i]),adjustImageRgba(await raw(plain.framePaths[i]),options.colorAdjust));
  assert.deepEqual(await raw(paths[0]),original);
});
