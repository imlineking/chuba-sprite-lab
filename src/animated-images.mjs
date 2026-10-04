import fs from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import sharp from 'sharp';
const signature=Buffer.from([137,80,78,71,13,10,26,10]);
export function crc32(data){let c=0xffffffff;for(const b of data){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
export function pngChunk(type,data){const body=Buffer.concat([Buffer.from(type),data]),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);body.copy(out,4);out.writeUInt32BE(crc32(body),data.length+8);return out;}
export function pngChunks(buffer){if(buffer.length>128*1024*1024||!buffer.subarray(0,8).equals(signature))throw new Error('Неверный или слишком большой PNG.');const chunks=[];let p=8;while(p<buffer.length){if(p+12>buffer.length)throw new Error('Оборванный PNG.');const n=buffer.readUInt32BE(p);if(n>buffer.length-p-12)throw new Error('Повреждён размер блока PNG.');const type=buffer.toString('ascii',p+4,p+8),data=buffer.subarray(p+8,p+8+n);if(buffer.readUInt32BE(p+8+n)!==crc32(buffer.subarray(p+4,p+8+n)))throw new Error('Контрольная сумма PNG не совпадает.');chunks.push({type,data});p+=n+12;if(type==='IEND')break;}return chunks;}
function validateFrames(frames,width,height){if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||!frames.length||frames.length>512||width*height*4*frames.length>256*1024*1024||frames.some(f=>f.pixels?.length!==width*height*4))throw new Error('Анимация: до 512 кадров и 256 МБ пикселей с одинаковым холстом.');}
export function encodeAPNG(frames,width,height,{loop=0}={}){
  validateFrames(frames,width,height);const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;
  const actl=Buffer.alloc(8);actl.writeUInt32BE(frames.length);actl.writeUInt32BE(Math.max(0,Math.round(loop)),4);const parts=[signature,pngChunk('IHDR',ihdr),pngChunk('acTL',actl)];let sequence=0;
  for(const [index,frame]of frames.entries()){
    const fctl=Buffer.alloc(26);fctl.writeUInt32BE(sequence++);fctl.writeUInt32BE(width,4);fctl.writeUInt32BE(height,8);const ms=Math.max(10,Math.min(10000,Math.round(frame.durationMs||100)));fctl.writeUInt16BE(ms,20);fctl.writeUInt16BE(1000,22);parts.push(pngChunk('fcTL',fctl));
    const raw=Buffer.alloc((width*4+1)*height),pixels=Buffer.from(frame.pixels);for(let y=0;y<height;y++)pixels.copy(raw,y*(width*4+1)+1,y*width*4,(y+1)*width*4);const compressed=deflateSync(raw,{level:9});
    if(index===0)parts.push(pngChunk('IDAT',compressed));else{const data=Buffer.alloc(compressed.length+4);data.writeUInt32BE(sequence++);compressed.copy(data,4);parts.push(pngChunk('fdAT',data));}
  }
  parts.push(pngChunk('IEND',Buffer.alloc(0)));return Buffer.concat(parts);
}
export async function decodeAPNG(buffer){
  const chunks=pngChunks(buffer),header=chunks.find(c=>c.type==='IHDR')?.data,actl=chunks.find(c=>c.type==='acTL')?.data;
  if(header?.length!==13||actl?.length!==8)throw new Error('В PNG нет корректной APNG-анимации.');
  const width=header.readUInt32BE(0),height=header.readUInt32BE(4),count=actl.readUInt32BE(0),loop=actl.readUInt32BE(4);
  if(!count||count>512||width*height*4*count>256*1024*1024)throw new Error('APNG превышает лимит кадров или памяти.');
  const shared=chunks.filter(c=>['PLTE','tRNS','gAMA','sRGB','iCCP'].includes(c.type)).map(c=>pngChunk(c.type,c.data)),encoded=[];let current=null,seq=0;
  for(const chunk of chunks){if(chunk.type==='fcTL'){if(chunk.data.length!==26||chunk.data.readUInt32BE(0)!==seq++)throw new Error('Повреждён порядок кадров APNG.');current={control:chunk.data,parts:[]};encoded.push(current);}else if(chunk.type==='IDAT'&&current)current.parts.push(chunk.data);else if(chunk.type==='fdAT'){if(!current||chunk.data.length<4||chunk.data.readUInt32BE(0)!==seq++)throw new Error('Повреждён APNG.');current.parts.push(chunk.data.subarray(4));}}
  if(encoded.length!==count)throw new Error('Число кадров APNG не совпадает.');
  const canvas=Buffer.alloc(width*height*4),frames=[];
  for(const item of encoded){const c=item.control,w=c.readUInt32BE(4),h=c.readUInt32BE(8),left=c.readUInt32BE(12),top=c.readUInt32BE(16),dispose=c[24],blend=c[25];if(!w||!h||left+w>width||top+h>height||dispose>2||blend>1||!item.parts.length)throw new Error('Повреждена область кадра APNG.');const before=Buffer.from(canvas),ihdr=Buffer.from(header);ihdr.writeUInt32BE(w);ihdr.writeUInt32BE(h,4);const png=Buffer.concat([signature,pngChunk('IHDR',ihdr),...shared,...item.parts.map(data=>pngChunk('IDAT',data)),pngChunk('IEND',Buffer.alloc(0))]);const decoded=await sharp(png).toColourspace('srgb').ensureAlpha().raw().toBuffer();
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){const s=(y*w+x)*4,t=((top+y)*width+left+x)*4;if(!blend)canvas.set(decoded.subarray(s,s+4),t);else{const a=decoded[s+3]/255,b=canvas[t+3]/255,o=a+b*(1-a);for(let k=0;k<3;k++)canvas[t+k]=o?Math.round((decoded[s+k]*a+canvas[t+k]*b*(1-a))/o):0;canvas[t+3]=Math.round(o*255);}}
    frames.push({pixels:Buffer.from(canvas),durationMs:Math.max(10,Math.round(c.readUInt16BE(20)/(c.readUInt16BE(22)||100)*1000))});
    if(dispose===2&&frames.length>1)before.copy(canvas);else if(dispose===1||dispose===2)for(let y=0;y<h;y++)canvas.fill(0,((top+y)*width+left)*4,((top+y)*width+left+w)*4);
  }
  return{width,height,loop,frames};
}
export async function encodeGIF(frames,width,height,{loop=0}={}){validateFrames(frames,width,height);const data=Buffer.concat(frames.map(f=>Buffer.from(f.pixels)));return sharp(data,{raw:{width,height:height*frames.length,pageHeight:height,channels:4}}).gif({loop,delay:frames.map(f=>Math.max(10,Math.round((f.durationMs||100)/10)*10)),dither:0,keepDuplicateFrames:true,effort:4}).toBuffer();}
export async function decodeGIF(buffer){const meta=await sharp(buffer,{animated:true}).metadata(),width=meta.width,height=meta.pageHeight||meta.height,count=meta.pages||1;if(count>512||width*height*4*count>256*1024*1024)throw new Error('GIF превышает лимит кадров или памяти.');const pixels=await sharp(buffer,{animated:true}).toColourspace('srgb').ensureAlpha().raw().toBuffer();return{width,height,loop:meta.loop??0,frames:Array.from({length:count},(_,i)=>({pixels:Buffer.from(pixels.subarray(i*width*height*4,(i+1)*width*height*4)),durationMs:meta.delay?.[i]||100}))};}
export async function readAnimatedImage(file){const buffer=await fs.readFile(file);return path.extname(file).toLowerCase()==='.gif'?decodeGIF(buffer):decodeAPNG(buffer);}
export async function hasAnimatedPNG(file){
  if(!['.png','.apng'].includes(path.extname(file).toLowerCase()))return false;
  const handle=await fs.open(file,'r');
  try{const size=(await handle.stat()).size,head=Buffer.alloc(8);await handle.read(head,0,8,0);if(!head.equals(signature)||size>128*1024*1024)return false;
    let p=8;const chunk=Buffer.alloc(8);while(p+12<=size){if((await handle.read(chunk,0,8,p)).bytesRead!==8)return false;const n=chunk.readUInt32BE(0),type=chunk.toString('ascii',4,8);if(n>size-p-12)return false;if(type==='acTL')return true;if(type==='IDAT'||type==='IEND')return false;p+=n+12;}return false;
  }finally{await handle.close();}
}
export async function writeAnimatedImage(file,image,format){const encode=format==='gif'?encodeGIF:encodeAPNG;await fs.writeFile(file,await encode(image.frames,image.width,image.height,{loop:image.loop}));return file;}
