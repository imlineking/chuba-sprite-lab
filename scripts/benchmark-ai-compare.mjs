// Identical real-image preview pipeline, fresh process per provider, no result cache.
// node scripts/benchmark-ai-compare.mjs <transparent-reference.png> <output-directory> [warm-runs]
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import assert from 'node:assert/strict';
import sharp from 'sharp';

const script=fileURLToPath(import.meta.url);
const root=path.resolve(path.dirname(script),'..');
async function hash(file){const digest=crypto.createHash('sha256');for await(const chunk of createReadStream(file))digest.update(chunk);return digest.digest('hex');}
const median=values=>{const sorted=[...values].sort((a,b)=>a-b);return sorted.length%2?sorted[(sorted.length-1)/2]:(sorted[sorted.length/2-1]+sorted[sorted.length/2])/2;};

if(process.argv[2]==='--worker'){
  const [provider,input,output,count]=process.argv.slice(3);
  const {processFramePreview,clearRenderCache}=await import('../src/processor.mjs');
  const {currentAIProvider}=await import('../src/ai-segmentation.mjs');
  const result={requestedProvider:provider,runsMs:[],actualProvider:null,sampledPeakRssMiB:0};
  const sample=()=>{result.sampledPeakRssMiB=Math.max(result.sampledPeakRssMiB,Math.round(process.memoryUsage().rss/1024**2));};
  const timer=setInterval(sample,50);
  try{
    for(let index=0;index<=Number(count);index++){
      clearRenderCache();
      const started=performance.now();
      const frame=await processFramePreview({inputPath:input,appRoot:root,options:{keyMode:'ai',aiModel:'toonout',aiForceModel:true,aiQuality:'fast',aiProvider:provider,aiCutoff:'auto',aiSoftness:0,aiModelDirs:[path.join(root,'models')],preserveFrameCanvas:true}});
      result.runsMs.push(Math.round(performance.now()-started));
      result.actualProvider=currentAIProvider();sample();
      assert.equal(result.actualProvider,provider,'Provider fell back; this is not a GPU comparison');
      await fs.copyFile(frame.afterPath,path.join(output,`${provider}.png`));
      await fs.writeFile(path.join(output,`${provider}.json`),JSON.stringify(result,null,2));
      console.log(JSON.stringify({provider,run:index===0?'first':`warm-${index}`,ms:result.runsMs.at(-1),rssMiB:result.sampledPeakRssMiB}));
    }
    result.firstMs=result.runsMs[0];result.warmMedianMs=median(result.runsMs.slice(1));result.warmAverageMs=Math.round(result.runsMs.slice(1).reduce((a,b)=>a+b,0)/(result.runsMs.length-1));
  }finally{clearInterval(timer);sample();await fs.writeFile(path.join(output,`${provider}.json`),JSON.stringify(result,null,2));}
}else{
  if(!process.argv[2]||!process.argv[3])throw new Error('Provide transparent reference and output directory');
  const original=path.resolve(process.argv[2]),output=path.resolve(process.argv[3]),count=Number(process.argv[4]||3);
  assert.ok(Number.isInteger(count)&&count>=1&&count<=10,'Use 1–10 warm runs');
  const reserved=['input-white.png','cpu.png','dml.png','cpu.json','dml.json','report.json'].map(name=>path.join(output,name).toLowerCase());
  assert.ok(!reserved.includes(original.toLowerCase()),'Reference collides with a benchmark output');
  await fs.mkdir(output,{recursive:true});
  const originalHash=await hash(original),input=path.join(output,'input-white.png');
  await sharp(original).flatten({background:'white'}).png().toFile(input);
  const report={startedAt:new Date().toISOString(),input,reference:original,sourceSha256:originalHash,modelSha256:await hash(path.join(root,'models/toonout.onnx')),warmRuns:count,method:'Fresh process per provider; clearRenderCache before every preview; first includes model loading; Windows file cache not reset; CPU uses application limit of 2 intra-op threads',providers:{}};
  for(const provider of ['cpu','dml']){
    await new Promise((resolve,reject)=>{
      const child=fork(script,['--worker',provider,input,output,String(count)],{stdio:'inherit',windowsHide:true});
      const timer=setTimeout(()=>{child.kill();reject(new Error(`${provider} exceeded 5 minutes`));},300000);
      child.on('error',error=>{clearTimeout(timer);reject(error);});
      child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(`${provider} exited ${code}`));});
    });
    report.providers[provider]=JSON.parse(await fs.readFile(path.join(output,`${provider}.json`),'utf8'));
    await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
  }
  const truth=await sharp(original).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const images={};
  for(const provider of ['cpu','dml']){
    const decoded=await sharp(path.join(output,`${provider}.png`)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    assert.equal(decoded.info.width,truth.info.width);assert.equal(decoded.info.height,truth.info.height);images[provider]=decoded.data;
    let intersection=0,union=0,foreground=0;
    for(let index=3;index<truth.data.length;index+=4){const t=truth.data[index]>127,a=decoded.data[index]>127;if(t)foreground++;if(t&&a)intersection++;if(t||a)union++;}
    report.providers[provider].quality={foregroundRecall:intersection/foreground,maskIoU:intersection/union};
  }
  let changedPixels=0,alphaDifferenceSum=0,intersection=0,union=0;
  for(let index=3;index<truth.data.length;index+=4){const a=images.cpu[index],b=images.dml[index];if(a!==b)changedPixels++;alphaDifferenceSum+=Math.abs(a-b);if(a>127&&b>127)intersection++;if(a>127||b>127)union++;}
  report.cpuVsGpu={warmSpeedup:report.providers.cpu.warmMedianMs/report.providers.dml.warmMedianMs,firstSpeedup:report.providers.cpu.firstMs/report.providers.dml.firstMs,changedAlphaPixels:changedPixels,totalPixels:truth.info.width*truth.info.height,alphaMeanAbsoluteDifference:alphaDifferenceSum/(truth.info.width*truth.info.height),maskIoU:intersection/union};
  assert.equal(await hash(original),originalHash,'Reference changed');
  report.sourceUnchanged=true;report.completedAt=new Date().toISOString();
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}
