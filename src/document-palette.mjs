export function validatePalette(value){
  if(!Array.isArray(value)||value.length<1||value.length>256||value.some(c=>!Array.isArray(c)||c.length!==4||c.some(v=>!Number.isInteger(v)||v<0||v>255)))throw new Error('Палитра: от 1 до 256 цветов RGBA.');
  return value.map(c=>[...c]);
}
export function makePalette(buffers,limit=32){
  limit=Math.max(2,Math.min(256,Math.round(limit)));let histogram=new Map();let reduced=false;
  const add=(r,g,b,a,n=1)=>{const key=[r,g,b,a].join(',');const item=histogram.get(key);if(item)item.n+=n;else histogram.set(key,{c:[r,g,b,a],n});};
  for(const pixels of buffers)for(let i=0;i<pixels.length;i+=4){if(!pixels[i+3])continue;const c=[...pixels.subarray(i,i+4)];if(reduced)for(let k=0;k<4;k++)c[k]=(c[k]>>4)*17;add(...c);if(histogram.size>16384){const old=[...histogram.values()];histogram=new Map();reduced=true;for(const{c,n}of old)add(...c.map(v=>(v>>4)*17),n);}}
  const entries=[...histogram.values()],boxes=entries.length?[entries]:[];
  while(boxes.length<limit-1){let selected=-1,best=-1,axis=0;for(let i=0;i<boxes.length;i++){const box=boxes[i];if(box.length<2)continue;for(let k=0;k<4;k++){let min=255,max=0,total=0;for(const e of box){min=Math.min(min,e.c[k]);max=Math.max(max,e.c[k]);total+=e.n;}const score=(max-min)*Math.sqrt(total);if(score>best){best=score;selected=i;axis=k;}}}if(selected<0)break;
    const box=boxes.splice(selected,1)[0].sort((a,b)=>a.c[axis]-b.c[axis]),total=box.reduce((n,e)=>n+e.n,0);let n=0,split=1;for(let i=0;i<box.length-1;i++){n+=box[i].n;split=i+1;if(n>=total/2)break;}boxes.push(box.slice(0,split),box.slice(split));
  }
  return[[0,0,0,0],...boxes.map(box=>{const total=box.reduce((n,e)=>n+e.n,0);return[0,1,2,3].map(k=>Math.round(box.reduce((n,e)=>n+e.c[k]*e.n,0)/total));})];
}
export function quantize(pixels,palette){
  palette=validatePalette(palette);if(pixels.length%4)throw new Error('Неверные пиксели палитры.');const indices=new Uint8Array(pixels.length/4),output=new Uint8ClampedArray(pixels.length),cache=new Map();let changed=0;
  for(let i=0;i<indices.length;i++){const o=i*4,key=[...pixels.subarray(o,o+4)].join(',');let index=cache.get(key);if(index==null){let best=Infinity;index=0;for(let p=0;p<palette.length;p++){const color=palette[p];let d=0;for(let k=0;k<4;k++){const delta=color[k]-pixels[o+k];d+=delta*delta*(k===3?3:1);}if(!pixels[o+3]&&!color[3])d=0;if(d<best){best=d;index=p;}}cache.set(key,index);}indices[i]=index;output.set(palette[index],o);if(output.subarray(o,o+4).some((v,k)=>v!==pixels[o+k]))changed++;}
  return{indices,pixels:output,changed};
}
export function expandIndices(indices,palette){palette=validatePalette(palette);const pixels=new Uint8ClampedArray(indices.length*4);for(let i=0;i<indices.length;i++){if(indices[i]>=palette.length)throw new Error('Индекс выходит за палитру.');pixels.set(palette[indices[i]],i*4);}return pixels;}
