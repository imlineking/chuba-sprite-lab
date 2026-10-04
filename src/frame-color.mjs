import { randomUUID } from "node:crypto";
import { captureRect, celKey, compositeFrame } from "./sprite-document.mjs";
import "./color-styles.js";
import "./pixel-colors.js";

// One reversible operation on the visible RGBA composite. Hidden layers and other frames
// stay intact. Blended colours get a correction layer rather than an approximate edit.
function outputPatch(document, frameIndex, pixels, output, label) {
  const offsets=[];
  const {width,height}=document;
  let minX=width,minY=height,maxX=-1,maxY=-1;
  for(let i=0;i<pixels.length;i+=4) {
    if(!pixels[i+3] || [0,1,2,3].every(k=>pixels[i+k]===output[i+k]))continue;
    offsets.push(i);
    const index=i/4,x=index%width,y=Math.floor(index/width);
    minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
  }
  if(!offsets.length)return null;
  const visible=document.layers.filter(layer=>layer.visible&&layer.opacity>0&&document.cels.has(celKey(layer.id,frameIndex)));
  for (const layer of visible) if (layer.kind === 'text' && offsets.some(i => document.cels.get(celKey(layer.id,frameIndex))[i+3])) throw new Error('Правка всего кадра затрагивает текст. Измените цвет в текстовом слое или выберите его и нажмите «В пиксели» перед общей цветокоррекцией.');
  for(const layer of visible)if(layer.locked && offsets.some(i=>document.cels.get(celKey(layer.id,frameIndex))[i+3]))throw new Error(`Слой «${layer.name}» заблокирован. Разблокируйте его для правки всего кадра.`);
  const rect={x:minX,y:minY,width:maxX-minX+1,height:maxY-minY+1};
  const parts=[];
  const local=i=>((Math.floor(i/4/width)-minY)*rect.width+(i/4%width-minX))*4;
  const direct=visible.length===1&&visible[0].opacity===255&&visible[0].blendMode==="normal";
  for(const layer of visible) {
    const cel=document.cels.get(celKey(layer.id,frameIndex));
    if(!offsets.some(i=>cel[i+3]))continue;
    const before=captureRect(document,layer.id,frameIndex,rect),after=Uint8ClampedArray.from(before);
    for(const i of offsets) {
      const j=local(i);
      if(direct)after.set(output.subarray(i,i+4),j);
      else after.fill(0,j,j+4);
    }
    parts.push({layerId:layer.id,frameIndex,rect,before,after});
  }
  let addedLayer=null;
  if(!direct&&offsets.some(i=>output[i+3])) {
    addedLayer={id:`color-${randomUUID()}`,name:"Правка цвета",visible:true,locked:false,opacity:255,blendMode:"normal",kind:"normal"};
    const before=new Uint8ClampedArray(rect.width*rect.height*4),after=Uint8ClampedArray.from(before);
    for(const i of offsets)after.set(output.subarray(i,i+4),local(i));
    parts.push({layerId:addedLayer.id,frameIndex,rect,before,after});
  }
  return {label,parts,addedLayer,layerIndex:document.layers.length,changedPixels:offsets.length};
}

export function frameColorPatch(document, frameIndex, source, replacement, {erase=false,tolerance=0}={}) {
  const valid=color=>Array.isArray(color)&&color.length>=3&&color.slice(0,3).every(n=>Number.isInteger(n)&&n>=0&&n<=255);
  if(!valid(source))throw new Error("Выберите исходный цвет кадра.");
  if(!erase&&!valid(replacement))throw new Error("Выберите новый цвет.");
  const limit=Number.isFinite(Number(tolerance))?Math.max(0,Math.min(255,Math.round(Number(tolerance)))):0;
  const pixels=compositeFrame(document,frameIndex),colors=globalThis.SpriteLabPixelColors;
  const offsets=colors.matches(pixels,source,limit);
  return outputPatch(document,frameIndex,pixels,colors.preview(pixels,offsets,replacement,erase),erase?"Удалён цвет кадра":"Заменён цвет кадра");
}

export function frameAdjustmentPatch(document,frameIndex,options={}) {
  const pixels=compositeFrame(document,frameIndex);
  return outputPatch(document,frameIndex,pixels,globalThis.SpriteLabPixelColors.adjust(pixels,options),"Настроены свет и цвет кадра");
}
