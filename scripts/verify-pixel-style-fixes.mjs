// Compare changed arithmetic styles on the same prepared alpha mask, without AI inference.
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { processFramePreview } from "../src/processor.mjs";
const root = path.resolve(import.meta.dirname,"..");
const input = path.resolve(process.argv[2]), baseline = path.resolve(process.argv[3]), output = path.resolve(process.argv[4]);
await fs.mkdir(output,{recursive:true});
const cases = [];
for(const mode of ["clean","shaded","lineart"]) {
  const result = await processFramePreview({inputPath:input,appRoot:root,options:{keyMode:"alpha",pixelate:{mode,size:6,colors:24,dither:"none"}}});
  const file=path.join(output,`${mode}.png`); await fs.copyFile(result.afterPath,file); cases.push({mode,file});
}
const panels = [], w=360, h=360;
for(const [i,mode] of ["clean","shaded","lineart"].entries()) for(const [j,file] of [path.join(baseline,`portrait-best-${mode}.png`),path.join(output,`${mode}.png`)].entries()) {
  const x=i*w,y=j*(h+32);
  const label=`${j?"After":"Before"}: ${mode}`;
  const pixels=await sharp(file).flatten({background:"#53bda8"}).resize(w,h,{fit:"contain",background:"#53bda8",kernel:"nearest"}).png().toBuffer();
  panels.push({input:pixels,left:x,top:y+32},{input:Buffer.from(`<svg width="${w}" height="32"><rect width="${w}" height="32" fill="#15232d"/><text x="12" y="23" font-size="17" fill="white" font-family="Segoe UI">${label}</text></svg>`),left:x,top:y});
}
await sharp({create:{width:w*3,height:(h+32)*2,channels:3,background:"#53bda8"}}).composite(panels).png().toFile(path.join(output,"style-before-after.png"));
await fs.writeFile(path.join(output,"report.json"),JSON.stringify({input,cases},null,2));
console.log(JSON.stringify(cases));
