import { inflateSync } from 'node:zlib';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { createDocument, addLayer, ensureCel, compositeFrame } from './sprite-document.mjs';
import { encodeEditorDocument } from './editor-document.mjs';

// Read the documented binary format. No Aseprite executable or source code is bundled.
class Reader {
  constructor(data){this.data=data;this.at=0;}
  take(n){if(!Number.isSafeInteger(n)||n<0||this.at+n>this.data.length)throw new Error('Оборванный блок Aseprite.');const out=this.data.subarray(this.at,this.at+n);this.at+=n;return out;}
  u8(){return this.take(1)[0];} u16(){return this.take(2).readUInt16LE();} i16(){return this.take(2).readInt16LE();} u32(){return this.take(4).readUInt32LE();} i32(){return this.take(4).readInt32LE();}
  string(){const n=this.u16();return this.take(n).toString('utf8');}
}
const modes={0:'normal',1:'multiply',2:'screen',3:'overlay',4:'darken',5:'lighten',10:'difference',16:'add',17:'subtract'};
export function decodeAseprite(bytes){
  const data=Buffer.from(bytes);if(data.length<128||data.length>128*1024*1024)throw new Error('Неверный размер Aseprite.');
  const h=new Reader(data.subarray(0,128)),size=h.u32(),magic=h.u16(),count=h.u16(),width=h.u16(),height=h.u16(),depth=h.u16(),flags=h.u32(),speed=h.u16();h.take(8);const transparent=h.u8();
  if(size!==data.length||magic!==0xa5e0||!count||count>512||!width||!height||![8,16,32].includes(depth)||width*height*4*count>256*1024*1024)throw new Error('Aseprite: неверный заголовок или превышен лимит 512 кадров / 256 МБ.');
  const layers=[],frames=[],tags=[],slices=[],warnings=[],palette=Array.from({length:256},(_,i)=>[i,i,i,255]);let at=128;
  for(let frameIndex=0;frameIndex<count;frameIndex++){
    const frame=new Reader(data.subarray(at)),length=frame.u32();if(length<16||length>data.length-at||frame.u16()!==0xf1fa)throw new Error('Повреждён кадр Aseprite.');
    const oldCount=frame.u16(),durationMs=frame.u16()||speed||100;frame.take(2);const chunkCount=frame.u32()||oldCount;frame.data=data.subarray(at,at+length);const cels=new Map();
    for(let i=0;i<chunkCount;i++){
      const chunkSize=frame.u32(),type=frame.u16();if(chunkSize<6)throw new Error('Повреждён блок Aseprite.');const r=new Reader(frame.take(chunkSize-6));
      if(type===0x2004){const layerFlags=r.u16(),kind=r.u16(),level=r.u16();r.take(4);const blend=r.u16(),opacity=r.u8();r.take(3);const name=r.string();
        if(kind===2)throw new Error('Тайловые слои Aseprite пока не поддерживаются. Экспортируйте PNG + JSON.');
        if(kind>1||modes[blend]==null||(kind===1&&(flags&2)&&(blend!==0||opacity!==255)))throw new Error('Режим смешивания группы или слоя Aseprite не поддерживается без потери рисунка. Экспортируйте PNG + JSON.');
        layers.push({name,kind,level,flags:layerFlags,blendMode:modes[blend],opacity:flags&1?opacity:255});
      }else if(type===0x2005){const layer=r.u16(),x=r.i16(),y=r.i16(),opacity=r.u8(),kind=r.u16(),z=r.i16();r.take(5);const cel={layer,x,y,opacity,z};
        if(cels.has(layer))throw new Error('Повтор ячейки слоя Aseprite.');
        if(kind===1)cel.link=r.u16();else if(kind===0||kind===2){cel.width=r.u16();cel.height=r.u16();const expected=cel.width*cel.height*depth/8;if(expected>256*1024*1024)throw new Error('Слишком большая ячейка Aseprite.');cel.raw=kind===2?inflateSync(r.take(r.data.length-r.at),{maxOutputLength:expected}):r.take(expected);if(cel.raw.length!==expected)throw new Error('Размер ячейки Aseprite не совпадает.');}else throw new Error('Тайловые ячейки Aseprite пока не поддерживаются. Экспортируйте PNG + JSON.');cels.set(layer,cel);
      }else if(type===0x2019){const total=r.u32(),from=r.u32(),to=r.u32();r.take(8);if(total>256||from>to||to>=total)throw new Error('Aseprite: палитра превышает 256 цветов.');for(let p=from;p<=to;p++){const entryFlags=r.u16();palette[p]=[r.u8(),r.u8(),r.u8(),r.u8()];if(entryFlags&1)r.string();}
      }else if(type===0x0004||type===0x0011){const packets=r.u16();let p=0;for(let j=0;j<packets;j++){p+=r.u8();const n=r.u8()||256;for(let k=0;k<n;k++){if(p>=256)throw new Error('Повреждена палитра Aseprite.');const values=[r.u8(),r.u8(),r.u8()];palette[p++]=[...values.map(v=>type===0x0011?Math.round(v*255/63):v),255];}}
      }else if(type===0x2018){const n=r.u16();r.take(8);for(let j=0;j<n;j++){const from=r.u16(),to=r.u16(),direction=r.u8(),repeat=r.u16();r.take(10);const name=r.string();if(from>to||to>=count||direction>3)throw new Error('Повреждён тег Aseprite.');tags.push({name,from,to,direction:['forward','reverse','pingpong','pingpong_reverse'][direction],repeat});}
      }else if(type===0x2022){const n=r.u32(),sliceFlags=r.u32();r.take(4);const name=r.string(),keys=[];for(let j=0;j<n;j++){const key={frame:r.u32(),x:r.i32(),y:r.i32(),width:r.u32(),height:r.u32()};if(sliceFlags&1)key.center={x:r.i32(),y:r.i32(),width:r.u32(),height:r.u32()};if(sliceFlags&2)key.pivot={x:r.i32(),y:r.i32()};keys.push(key);}slices.push({name,keys});
      }else if(type===0x2007){const profile=r.u16(),profileFlags=r.u16();if(profile===2||profileFlags&1)throw new Error('ICC-профиль или нестандартная гамма Aseprite требуют экспорта в sRGB PNG.');
      }else if(type===0x2006){warnings.push('Дробные координаты Cel Extra не импортированы. Используется пиксельная сетка.');}
    }
    frames.push({durationMs,cels,palette:structuredClone(palette)});at+=length;
  }
  if(at!==data.length||!layers.some(l=>l.kind===0)||layers.length>128||width*height*4*layers.filter(l=>l.kind===0).length*count>256*1024*1024)throw new Error('Aseprite: неверные слои или превышен лимит памяти.');
  const ancestors=[];for(const layer of layers){ancestors.length=layer.level;layer.parents=ancestors.filter(Boolean);if(layer.kind===1)ancestors[layer.level]=layer;}
  const resolve=(frameIndex,layerIndex,seen=new Set())=>{const key=frameIndex+':'+layerIndex;if(seen.has(key))throw new Error('Циклическая связанная ячейка Aseprite.');seen.add(key);const cel=frames[frameIndex]?.cels.get(layerIndex);if(!cel)throw new Error('Не найдена связанная ячейка Aseprite.');return cel.link==null?cel:resolve(cel.link,layerIndex,seen);};
  const documents=frames.map((frame,frameIndex)=>{
    const document=createDocument({width,height});document.layers=[];document.cels.clear();document.palette=frame.palette;document.asepriteColorDepth=depth;
    const ordered=layers.map((layer,i)=>({layer,i,z:frame.cels.get(i)?.z||0})).filter(({layer})=>layer.kind===0&&!(layer.flags&64)).sort((a,b)=>(a.i+a.z)-(b.i+b.z)||a.z-b.z);
    for(const{layer:source,i}of ordered){const layer=addLayer(document,[...source.parents.map(p=>p.name),source.name].join(' / '));Object.assign(layer,{visible:Boolean(source.flags&1)&&source.parents.every(p=>p.flags&1),locked:!(source.flags&2),opacity:source.opacity,blendMode:source.blendMode});const original=frame.cels.get(i);if(!original)continue;const cel=original.link==null?original:resolve(original.link,i),out=ensureCel(document,layer.id,0);
      for(let y=0;y<cel.height;y++)for(let x=0;x<cel.width;x++){const tx=original.x+x,ty=original.y+y;if(tx<0||ty<0||tx>=width||ty>=height)continue;const s=(y*cel.width+x)*depth/8,t=(ty*width+tx)*4;let rgba;if(depth===32)rgba=[...cel.raw.subarray(s,s+4)];else if(depth===16)rgba=[cel.raw[s],cel.raw[s],cel.raw[s],cel.raw[s+1]];else{const index=cel.raw[s];rgba=[...(frame.palette[index]||[0,0,0,255])];if(index===transparent&&!(source.flags&8))rgba[3]=0;}rgba[3]=Math.round(rgba[3]*original.opacity/255);out.set(rgba,t);}
    }
    if(!document.layers.length)addLayer(document,'Слой');return document;
  });
  return{width,height,depth,frames:documents.map((document,i)=>({document,pixels:Buffer.from(compositeFrame(document,0)),durationMs:frames[i].durationMs})),tags,slices,warnings:[...new Set(warnings)]};
}
export async function extractAseprite(file,directory){const image=decodeAseprite(await fs.readFile(file));await fs.mkdir(directory,{recursive:true});const framePaths=[],frameDocuments={};for(const[ i,frame]of image.frames.entries()){const png=path.join(directory,String(i).padStart(4,'0')+'.png'),doc=png+'.csframe';await sharp(frame.pixels,{raw:{width:image.width,height:image.height,channels:4}}).png().toFile(png);await fs.writeFile(doc,JSON.stringify(encodeEditorDocument(frame.document,0)));framePaths.push(png);frameDocuments[i]={path:doc,imagePath:png};}return{...image,frames:undefined,framePaths,frameDocuments,durations:image.frames.map(f=>f.durationMs)};}
