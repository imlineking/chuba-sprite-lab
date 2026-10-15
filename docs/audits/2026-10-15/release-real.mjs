import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { processSprites, processFramePreview, inspectSource, clearRenderCache } from '../../../src/processor.mjs';

const appRoot=path.resolve('.');
const game='C:/Users/User/Pictures/Chuba/chuba the game';
const output=path.join(appRoot,'docs/audits/2026-10-15/release-real-output');
await fs.mkdir(output,{recursive:true});
const pig=path.join(game,'public/images/enemies/ordinary-pig-left-rescue-v1/ordinary-pig-left-rescue-v1/frames/0000.png');
const video=path.join(game,'public/images/video/pig artist.mp4');
const hash=async file=>crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
const originals=new Map(await Promise.all([pig,video].map(async file=>[file,await hash(file)])));
const report={cases:[],sampledPeakRssMiB:0,sourceHashes:{}};
const sample=()=>report.sampledPeakRssMiB=Math.max(report.sampledPeakRssMiB,Math.round(process.memoryUsage().rss/1024**2));
const timer=setInterval(sample,100);
try {
  const source=await inspectSource({kind:'video',paths:[video],appRoot});
  const started=performance.now();
  const result=await processSprites({source,appRoot,outputDir:output,name:'video-eight-frames',options:{keyMode:'alpha',fps:2,maxFrames:8,preserveFrameCanvas:true,autoSize:true,autoColumns:true,padding:2,removeDuplicates:false,exports:{sheet:true,frames:true,metadata:true,preview:false}}});
  const manifest=JSON.parse(await fs.readFile(result.manifestPath,'utf8'));
  assert.equal(result.frameCount,8);assert.equal(manifest.frames.length,8);
  report.cases.push({id:'real-video',ms:Math.round(performance.now()-started),frames:result.frameCount,sheet:(await sharp(result.sheetPath).metadata()).width});
  clearRenderCache();
  const white=path.join(output,'pig-white.png');
  await sharp(pig).flatten({background:'white'}).png().toFile(white);
  const inferenceStart=performance.now();
  const cut=await processFramePreview({inputPath:white,appRoot,options:{keyMode:'ai',aiModel:'toonout',aiForceModel:true,aiQuality:'fast',aiProvider:'cpu',aiModelDirs:[path.join(appRoot,'models')],preserveFrameCanvas:true}});
  await fs.copyFile(cut.afterPath,path.join(output,'pig-toonout.png'));
  const truth=await sharp(pig).ensureAlpha().raw().toBuffer();const actual=await sharp(cut.afterPath).ensureAlpha().raw().toBuffer();assert.equal(actual.length,truth.length);
  let intersection=0,union=0,foreground=0,retained=0;
  for(let o=3;o<truth.length;o+=4){const t=truth[o]>127,a=actual[o]>127;if(t||a)union++;if(t&&a)intersection++;if(t)foreground++;if(t&&a)retained++;}
  report.cases.push({id:'real-pig-toonout-cpu',ms:Math.round(performance.now()-inferenceStart),foregroundRecall:retained/foreground,maskIoU:intersection/union});
  for(const [file,before] of originals){const after=await hash(file);assert.equal(after,before);report.sourceHashes[file]=after;}
  report.ok=true;
} finally {clearInterval(timer);sample();await fs.writeFile(path.join(appRoot,'docs/audits/2026-10-15/release-real.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report));
