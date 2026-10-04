import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';
import { encodeDDS,decodeDDS } from '../src/dds-bc3.mjs';
import { validateNineSlice } from '../src/nine-slice.mjs';
import { processSprites } from '../src/processor.mjs';
test('BC3 uses exact block size, transparent padding and independent Three.js DDS parser',()=>{
  const data=Buffer.alloc(7*5*4);for(let y=0;y<5;y++)for(let x=0;x<7;x++)data.set([40+x*4,140+y*5,70,x?Math.round(x*255/6):0],(y*7+x)*4);const encoded=encodeDDS(data,7,5);assert.equal(encoded.buffer.length,128+8*8);const arrayBuffer=encoded.buffer.buffer.slice(encoded.buffer.byteOffset,encoded.buffer.byteOffset+encoded.buffer.byteLength),parsed=new DDSLoader().parse(arrayBuffer,true);assert.equal(parsed.width,8);assert.equal(parsed.height,8);assert.equal(parsed.mipmaps.length,1);assert.equal(parsed.mipmaps[0].data.length,64);const decoded=decodeDDS(encoded.buffer);let maxAlpha=0,maxColour=0;for(let y=0;y<5;y++)for(let x=0;x<7;x++){const s=(y*7+x)*4,t=(y*8+x)*4;maxAlpha=Math.max(maxAlpha,Math.abs(data[s+3]-decoded.pixels[t+3]));if(x)for(let k=0;k<3;k++)maxColour=Math.max(maxColour,Math.abs(data[s+k]-decoded.pixels[t+k]));}assert.ok(maxAlpha<=18);assert.ok(maxColour<=25);for(let y=0;y<8;y++)for(let x=0;x<8;x++)if(x>=7||y>=5)assert.equal(decoded.pixels[(y*8+x)*4+3],0);
});
test('Nine-slice and DDS export keep PNG fallback, engine metadata, geometry and quality report',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'chuba-three-'));try{const input=path.join(directory,'input.png');await sharp({create:{width:16,height:16,channels:4,background:{r:50,g:140,b:70,alpha:.5}}}).png().toFile(input);const options={keyMode:'alpha',cellWidth:16,cellHeight:16,autoSize:false,padding:0,preserveFrameCanvas:true,packing:'grid',anchor:'center',exportFormat:'three',gpuFormat:'dds-bc3',nineSlice:{left:3,right:4,top:2,bottom:5},exports:{sheet:true,metadata:true,frames:false,preview:false}};const result=await processSprites({source:{kind:'frames',paths:[input]},outputDir:directory,name:'panel',options,appRoot:path.resolve('.')});const manifest=JSON.parse(await fs.readFile(result.engineFiles.find(p=>p.endsWith('.three.json')),'utf8'));assert.deepEqual(manifest.frames[0].nineSlice,options.nineSlice);assert.equal(manifest.pages[0].gpu.format,'BC3/DXT5');assert.equal(manifest.pages[0].gpu.rgbaBytes,1024);assert.ok(result.engineFiles.some(p=>p.endsWith('.dds')));await fs.access(result.sheetPath);assert.match(await fs.readFile(result.engineFiles.find(p=>p.endsWith('.three.mjs')),'utf8'),/frameMesh/);const report=JSON.parse(await fs.readFile(result.reportPath,'utf8'));assert.equal(report.gpuTextures[0].alphaMaxError,0);
    const phaser=await processSprites({source:{kind:'frames',paths:[input]},outputDir:directory,name:'phaser',options:{...options,gpuFormat:'none',exportFormat:'phaser3'},appRoot:path.resolve('.')});const json=JSON.parse(await fs.readFile(phaser.engineFiles.find(p=>p.endsWith('.phaser.json')),'utf8'));assert.deepEqual(json.textures[0].frames[0].scale9Borders,{x:3,y:2,w:9,h:9});await assert.rejects(()=>processSprites({source:{kind:'frames',paths:[input]},outputDir:directory,name:'bad',options:{...options,packing:'tight'},appRoot:path.resolve('.')}),/9-slice/);assert.throws(()=>validateNineSlice({left:8,right:8,top:0,bottom:0},16,16));
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
