// Inspect the actual bundled export before deciding how its output is decoded.
// node scripts/inspect-segmentation-output.mjs <input> <model> [cpu|dml]
import path from "node:path";
import sharp from "sharp";
import * as ort from "onnxruntime-node";
import { modelById, readSessionShapes } from "../src/ai-models.mjs";
import { segmentationInput, segmentationProbabilities } from "../src/ai-tensors.mjs";
const model=modelById(process.argv[3]), provider=process.argv[4]||"cpu", root=path.resolve(import.meta.dirname,"..");
const session=await ort.InferenceSession.create(path.join(root,"models",model.file),{executionProviders:[provider],intraOpNumThreads:2,executionMode:"sequential"});
const size=readSessionShapes(session).inputSize;
let pipeline=sharp(process.argv[2]).toColourspace("srgb");if(model.flattenBackground)pipeline=pipeline.flatten({background:model.flattenBackground});
const rgb=await pipeline.removeAlpha().resize(size,size,{fit:"fill"}).raw().toBuffer();
const outputs=await session.run({[session.inputNames[0]]:new ort.Tensor("float32",segmentationInput(rgb,model),[1,3,size,size])});
for(const [name,tensor]of Object.entries(outputs)){
 const sorted=Array.from(tensor.data).sort((a,b)=>a-b), n=sorted.length;
 console.log(JSON.stringify({model:model.id,provider,name,dims:tensor.dims,min:sorted[0],max:sorted[n-1],quantiles:[.01,.1,.5,.9,.99].map(p=>sorted[Math.floor(p*(n-1))]),nonfinite:sorted.filter(x=>!Number.isFinite(x)).length}));
}
if(process.argv[5]==="mirror"){
 const original=Float32Array.from(outputs[session.outputNames[0]].data);
 const mirror=await sharp(rgb,{raw:{width:size,height:size,channels:3}}).flop().raw().toBuffer();
 const second=await session.run({[session.inputNames[0]]:new ort.Tensor("float32",segmentationInput(mirror,model),[1,3,size,size])});
 const values=second[session.outputNames[0]].data, aligned=new Float32Array(values.length);
 for(let y=0;y<size;y++)for(let x=0;x<size;x++)aligned[y*size+x]=values[y*size+size-1-x];
 const bytes=segmentationProbabilities([original,aligned],model);
 console.log(JSON.stringify({mirrorMean:Array.from(values).reduce((s,v)=>s+v,0)/values.length,ensembleCoverage:Array.from(bytes).filter(v=>v>=128).length/bytes.length}));
}
await session.release();
