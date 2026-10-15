import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {writeAnimatedImage} from '../../../src/animated-images.mjs';
import {describePaths, describeSpriteSheet} from '../../../src/source-describe.mjs';
import * as processor from '../../../src/processor.mjs';
import {buildAtlas} from '../../../src/pipeline/build.mjs';
import {reviewAtlas} from '../../../src/critic/critic.mjs';
import {createConveyorStages} from '../../../src/conveyor-main.mjs';
import {runConveyor, builtinPresets} from '../../../src/conveyor.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '../../..');
const input = path.join(here, 'timing.gif');
const pixels = async color => sharp({create:{width:32,height:32,channels:4,background:color}}).raw().toBuffer();
await writeAnimatedImage(input, {width:32,height:32,loop:0,frames:[
  {pixels:await pixels({r:100,g:40,b:60,alpha:1}),durationMs:80},
  {pixels:await pixels({r:40,g:100,b:60,alpha:1}),durationMs:240},
]}, 'gif');
const stages = createConveyorStages({appRoot,sharp,
  describePaths:(kind, paths)=>describePaths(appRoot,kind,paths),
  describeSpriteSheet:(p,o)=>describeSpriteSheet(appRoot,p,o),
  executeProcessing:(op,payload)=>processor[op](payload),buildAtlas,reviewAtlas,
  runtime:null,modelsDirectory:()=>path.join(appRoot,'models')});
const detection = await stages.detect([input]);
const source = await stages.describe(detection);
const preset = {...builtinPresets[0], background:'none', edgeCleanup:false, review:false, useModel:false};
const result = await runConveyor({paths:[input],preset,outputDir:path.join(here,'timing-output'),deps:stages});
const solidPreservation = {presetBackground:preset.background, ok:result.ok,error:result.error};
const timedInput = path.join(here,'timing-shaped.gif');
const shape = async color => sharp({create:{width:32,height:32,channels:4,background:{r:0,g:0,b:0,alpha:0}}})
  .composite([{input:{create:{width:12,height:18,channels:4,background:color}},left:10,top:7}]).raw().toBuffer();
await writeAnimatedImage(timedInput,{width:32,height:32,loop:0,frames:[
  {pixels:await shape({r:100,g:40,b:60,alpha:1}),durationMs:80},
  {pixels:await shape({r:40,g:100,b:60,alpha:1}),durationMs:240},
]},'gif');
const timedResult = await runConveyor({paths:[timedInput],preset:{...preset,background:'auto'},outputDir:path.join(here,'timing-shaped-output'),deps:stages});
let atlas = null;
if (timedResult.ok) {
  const dir = path.join(timedResult.outputDir,'atlas');
  const names = (await fs.readdir(dir)).filter(n=>n.endsWith('.json'));
  atlas = Object.fromEntries(await Promise.all(names.map(async n=>[n,JSON.parse(await fs.readFile(path.join(dir,n),'utf8'))])));
}
const report = {sourceMetadata:source.frameMetadata,sourceAnimations:source.importedAnimations,solidPreservation,result:timedResult,atlas};
await fs.writeFile(path.join(here,'timing-probe.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({inputDurations:Object.values(source.frameMetadata||{}).map(x=>x.durationMs),solidPreservation,ok:timedResult.ok,error:timedResult.error,output:timedResult.outputDir,atlas}));
