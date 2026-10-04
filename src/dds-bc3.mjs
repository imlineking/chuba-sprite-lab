import fs from 'node:fs/promises';
import sharp from 'sharp';
const rgb565=c=>(Math.round(c[0]*31/255)<<11)|(Math.round(c[1]*63/255)<<5)|Math.round(c[2]*31/255);
const from565=n=>[Math.round((n>>11)*255/31),Math.round(((n>>5)&63)*255/63),Math.round((n&31)*255/31)];
export function alphaTable(a,b){return a>b?[a,b,...Array.from({length:6},(_,i)=>Math.round(((6-i)*a+(i+1)*b)/7))]:[a,b,...Array.from({length:4},(_,i)=>Math.round(((4-i)*a+(i+1)*b)/5)),0,255];}
export function colourTable(a,b){const first=from565(a),second=from565(b);return[first,second,first.map((v,k)=>Math.round((2*v+second[k])/3)),first.map((v,k)=>Math.round((v+2*second[k])/3))];}
function encodeBlock(pixels){
  const out=Buffer.alloc(16),alphas=pixels.map(p=>p[3]),a=Math.max(...alphas),b=Math.min(...alphas),table=alphaTable(a,b);out[0]=a;out[1]=b;let indices=0n;
  for(let i=0;i<16;i++){let best=0,distance=Infinity;for(let k=0;k<8;k++){const d=Math.abs(alphas[i]-table[k]);if(d<distance){distance=d;best=k;}}indices|=BigInt(best)<<BigInt(i*3);}for(let i=0;i<6;i++)out[2+i]=Number((indices>>BigInt(i*8))&255n);
  const visible=pixels.filter(p=>p[3]>0);let low=[0,0,0],high=[0,0,0];
  if(visible.length){const mean=[0,1,2].map(k=>visible.reduce((n,p)=>n+p[k],0)/visible.length);let axis=[.577,.577,.577];for(let pass=0;pass<5;pass++){const next=[0,0,0];for(const p of visible){const v=p.slice(0,3).map((c,k)=>c-mean[k]),dot=v.reduce((n,c,k)=>n+c*axis[k],0);for(let k=0;k<3;k++)next[k]+=v[k]*dot;}const length=Math.hypot(...next);if(!length)break;axis=next.map(v=>v/length);}const ordered=visible.map(p=>({p,value:p.slice(0,3).reduce((n,v,k)=>n+v*axis[k],0)})).sort((x,y)=>x.value-y.value);low=ordered[0].p;high=ordered.at(-1).p;}
  let c0=rgb565(high),c1=rgb565(low);if(c0<c1)[c0,c1]=[c1,c0];if(c0===c1){if(c0<65535)c0++;else c1--;}
  out.writeUInt16LE(c0,8);out.writeUInt16LE(c1,10);const colours=colourTable(c0,c1);let colorIndices=0;
  for(let i=0;i<16;i++){let best=0,distance=Infinity;for(let k=0;k<4;k++){const d=colours[k].reduce((n,v,c)=>n+(v-pixels[i][c])**2,0);if(d<distance){distance=d;best=k;}}colorIndices|=best<<(i*2);}out.writeUInt32LE(colorIndices>>>0,12);return out;
}
export function encodeDDS(pixels,width,height){
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>16384||height>16384||pixels.length!==width*height*4)throw new Error('Неверный размер DDS.');
  const paddedWidth=Math.ceil(width/4)*4,paddedHeight=Math.ceil(height/4)*4,blocks=Buffer.alloc(paddedWidth*paddedHeight);let offset=0;
  for(let y=0;y<paddedHeight;y+=4)for(let x=0;x<paddedWidth;x+=4){const block=[];for(let dy=0;dy<4;dy++)for(let dx=0;dx<4;dx++){const px=x+dx,py=y+dy;block.push(px<width&&py<height?[...pixels.subarray((py*width+px)*4,(py*width+px+1)*4)]:[0,0,0,0]);}encodeBlock(block).copy(blocks,offset);offset+=16;}
  const header=Buffer.alloc(128);header.write('DDS ',0,'ascii');header.writeUInt32LE(124,4);header.writeUInt32LE(0x81007,8);header.writeUInt32LE(paddedHeight,12);header.writeUInt32LE(paddedWidth,16);header.writeUInt32LE(blocks.length,20);header.writeUInt32LE(32,76);header.writeUInt32LE(4,80);header.write('DXT5',84,'ascii');header.writeUInt32LE(0x1000,108);return{buffer:Buffer.concat([header,blocks]),width:paddedWidth,height:paddedHeight,originalWidth:width,originalHeight:height};
}
// Independent CPU reconstruction used for the quality report and tests, never to replace the PNG.
export function decodeDDS(buffer){
  if(buffer.length<128||buffer.toString('ascii',0,4)!=='DDS '||buffer.toString('ascii',84,88)!=='DXT5')throw new Error('Не DDS/BC3.');const width=buffer.readUInt32LE(16),height=buffer.readUInt32LE(12);if(!width||!height||width%4||height%4||width*height>64*1024*1024||buffer.length!==128+width*height)throw new Error('Повреждён DDS/BC3.');const pixels=Buffer.alloc(width*height*4);let offset=128;
  for(let y=0;y<height;y+=4)for(let x=0;x<width;x+=4){const block=buffer.subarray(offset,offset+16),alpha=alphaTable(block[0],block[1]),colors=colourTable(block.readUInt16LE(8),block.readUInt16LE(10)),ci=block.readUInt32LE(12);let ai=0n;for(let i=0;i<6;i++)ai|=BigInt(block[2+i])<<BigInt(i*8);for(let i=0;i<16;i++){const rgba=[...colors[(ci>>>(i*2))&3],alpha[Number((ai>>BigInt(i*3))&7n)]],target=((y+(i>>2))*width+x+(i&3))*4;pixels.set(rgba,target);}offset+=16;}return{width,height,pixels};
}
export async function writeDDS(pngFile,target){const{data,info}=await sharp(pngFile).toColourspace('srgb').ensureAlpha().raw().toBuffer({resolveWithObject:true}),encoded=encodeDDS(data,info.width,info.height),decoded=decodeDDS(encoded.buffer);let colourError=0,colourChannels=0,alphaError=0;for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++){const s=(y*info.width+x)*4,t=(y*encoded.width+x)*4;alphaError=Math.max(alphaError,Math.abs(data[s+3]-decoded.pixels[t+3]));if(data[s+3])for(let k=0;k<3;k++){colourError+=Math.abs(data[s+k]-decoded.pixels[t+k]);colourChannels++;}}
  await fs.writeFile(target,encoded.buffer);return{format:'BC3/DXT5',width:encoded.width,height:encoded.height,originalWidth:info.width,originalHeight:info.height,bytes:encoded.buffer.length,rgbaBytes:encoded.width*encoded.height*4,colorMeanAbsoluteError:colourChannels?Number((colourError/colourChannels).toFixed(2)):0,alphaMaxError:alphaError,colorSpace:'sRGB',mipmaps:false};
}
