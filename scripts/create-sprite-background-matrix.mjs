// Build a background matrix from prepared local sprites, never writing their files.
// node scripts/create-sprite-background-matrix.mjs <new-output-directory>
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
const root=path.resolve(import.meta.dirname,".."),output=path.resolve(process.argv[2]);
const evidence=path.resolve(root,"../background-removal-lab/evidence");
const donors=[
 ["white-flower",path.join(evidence,"healing-shape-review-03/after.png")],
 ["fly-agaric",path.join(evidence,"healing-light-safe-review-04/mushroom_fly_agaric_01.png/result.png")],
 ["reeds",path.join(evidence,"alpha-seams-final/reeds_cattail_02.png/result.png")],
 ["dense-branch",path.join(evidence,"structure-checker-final/branch_leaves_hanging_04.png/result.png")],
 ["pine",path.join(root,".diagnostics/p1-tools-compare-confirmed-2026-10-02/05/layer-pine-branch (3).png")],
];
const hash=async file=>crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
await fs.mkdir(output); await fs.mkdir(path.join(output,"inputs"));
const cases=[],originals={};
for(const [name,reference]of donors){
 const fingerprint=await hash(reference);originals[reference]=fingerprint;
 const metadata=await sharp(reference).metadata(),width=metadata.width,height=metadata.height;
 for(const [background,color,size]of [["pink",[255,145,190],0],["magenta",[255,0,255],0],["green",[0,255,0],0],["black",[0,0,0],0],["white",[255,255,255],0],["checker-light",[255,255,255],8],["checker-dark",[65,65,65],24]]){
  const id=`${name}-${background}`,input=path.join(output,"inputs",`${id}.png`);
  if(!size)await sharp(reference).flatten({background:{r:color[0],g:color[1],b:color[2]}}).png().toFile(input);
  else{
   const buffer=Buffer.alloc(width*height*3), other=background==="checker-light"?205:25;
   for(let y=0;y<height;y++)for(let x=0;x<width;x++){const value=(Math.floor(x/size)+Math.floor(y/size))%2?other:color[0];const at=(y*width+x)*3;buffer[at]=buffer[at+1]=buffer[at+2]=value;}
   await sharp(buffer,{raw:{width,height,channels:3}}).composite([{input:reference}]).png().toFile(input);
  }
  cases.push({id,input,reference,category:"prepared-sprite-composite",color:size?null:color,inputHash:await hash(input),background,donor:name});
 }
 if(await hash(reference)!==fingerprint)throw new Error("Prepared sprite modified");
}
await fs.writeFile(path.join(output,"corpus.json"),JSON.stringify({cases,originals,note:"Reference alpha is the prepared sprite before compositing; not a hand-labelled ideal mask. Existing donor defects are not a ground-truth objective."},null,2));
console.log(`Prepared ${cases.length} cases, ${donors.length} sprites on 7 backgrounds.`);
