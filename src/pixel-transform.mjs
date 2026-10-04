import { selectedBounds } from './ocr.mjs';
export function transformPixels(pixels,width,height,selection,mode) {
  const bounds=selectedBounds(selection,width,height),{left,top,width:w,height:h}=bounds;
  const rotated=['rotate-left','rotate-right'].includes(mode),tw=rotated?h:w,th=rotated?w:h;
  if(!['flip-x','flip-y','rotate-left','rotate-right'].includes(mode))throw new Error('Неизвестное преобразование выделения.');
  const x0=Math.round(left+(w-tw)/2),y0=Math.round(top+(h-th)/2);
  if(x0<0||y0<0||x0+tw>width||y0+th>height)throw new Error('Поворот обрежет пиксели. Перенесите выделение ближе к центру холста.');
  const result=Buffer.from(pixels),mask=new Uint8Array(width*height);
  for(let i=0;i<selection.length;i++)if(selection[i])result.fill(0,i*4,i*4+4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const source=(top+y)*width+left+x;if(!selection[source])continue;
    const [tx,ty]=mode==='flip-x'?[w-1-x,y]:mode==='flip-y'?[x,h-1-y]:mode==='rotate-right'?[h-1-y,x]:[y,w-1-x];
    const target=(y0+ty)*width+x0+tx;result.set(pixels.subarray(source*4,source*4+4),target*4);mask[target]=1;
  }
  return{pixels:result,selection:mask};
}
