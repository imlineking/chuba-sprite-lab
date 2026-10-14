import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {contourAlphaRgba} from '../src/contour-alpha.mjs';
import {processFramePreview,processSprites,inspectSource} from '../src/processor.mjs';
import {preparedCleanupRecord,resolvePreparedCleanup} from '../src/prepared-cleanup.mjs';
const info={width:31,height:31,channels:4};
function shape(){const b=Buffer.alloc(31*31*4);for(let y=3;y<=27;y++)for(let x=3;x<=27;x++)b.set([255,250,248,220],(y*31+x)*4);return b;}
const opts={enabled:true,width:7,curve:1,thinRadius:2,protectCore:true};
const at=(b,x,y)=>b[(y*31+x)*4+3];
test('disabled is reversible; enabled follows every contour and keeps RGB and alpha holes',()=>{
 const b=shape();b.set([70,40,130,0],(15*31+15)*4);const original=Buffer.from(b);
 assert.deepEqual(contourAlphaRgba(b,info,{enabled:false}).data,b);
 const r=contourAlphaRgba(b,info,opts).data;
 assert.deepEqual(b,original);assert.equal(at(r,15,15),0);
 assert.ok(at(r,3,8)<at(r,6,8));assert.equal(at(r,9,9),220);
 assert.ok(at(r,15,14)<at(r,15,10),'inside cutout has its own contour');
 for(let p=0;p<b.length;p+=4){assert.deepEqual(r.subarray(p,p+3),b.subarray(p,p+3));assert.ok(r[p+3]<=b[p+3]);}
});
test('width and curve change falloff without cutting a narrow branch',()=>{
 const b=shape(),narrow=Buffer.alloc(b.length);for(let y=3;y<=27;y++)narrow.set([180,190,255,180],(y*31+15)*4);
 const a=contourAlphaRgba(b,info,{...opts,width:5,protectCore:false}).data;
 const wide=contourAlphaRgba(b,info,{...opts,width:12,protectCore:false}).data;
 const curved=contourAlphaRgba(b,info,{...opts,curve:2,protectCore:false}).data;
 const base=contourAlphaRgba(b,info,{...opts,protectCore:false}).data;
 assert.ok(at(wide,5,15)<at(a,5,15));assert.ok(at(curved,5,15)<at(base,5,15));
 const branch=contourAlphaRgba(narrow,info,opts).data;
 for(let y=3;y<=27;y++)assert.equal(at(branch,15,y),180);
});
test('preview and actual export match; disabling invalidates cache and restores original alpha',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'chuba-contour-test-'));
 try{
  const input=path.join(temp,'input.png');await sharp(shape(),{raw:info}).png().toFile(input);
  const options={keyMode:'alpha',contourAlpha:opts,columns:1,cellWidth:31,cellHeight:31,padding:0,anchor:'center',preserveFrameCanvas:true,pixelScale:1,removeDuplicates:false,exports:{sheet:true,frames:true,metadata:true,preview:false},outputBackground:'transparent'};
  const preview=await processFramePreview({inputPath:input,appRoot:path.resolve('.'),options});
  const source=await inspectSource({kind:'frames',paths:[input],appRoot:path.resolve('.')});
  const result=await processSprites({source,outputDir:temp,name:'contour',appRoot:path.resolve('.'),options});
  const expected=await sharp(preview.afterPath).raw().toBuffer();
  assert.deepEqual(await sharp(result.framePaths[0]).raw().toBuffer(),expected);
  const off=await processFramePreview({inputPath:input,appRoot:path.resolve('.'),options:{...options,contourAlpha:{...opts,enabled:false}}});
  assert.deepEqual(await sharp(off.afterPath).raw().toBuffer(),shape());
  const record=preparedCleanupRecord(options,preview.afterPath);
  const resolved=resolvePreparedCleanup({...options,preparedCleanup:{0:record}},0,preview.afterPath);
  assert.equal(resolved.contourAlpha.enabled,false,'accepted processing is not baked twice');
 }finally{await fs.rm(temp,{recursive:true,force:true});}
});
