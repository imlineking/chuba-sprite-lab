export function validateNineSlice(value,width,height){
  if(!value)return null;const margins=Object.fromEntries(['left','right','top','bottom'].map(key=>[key,Number(value[key])]));
  if(Object.values(margins).some(v=>!Number.isInteger(v)||v<0)||margins.left+margins.right>=width||margins.top+margins.bottom>=height)throw new Error('9-slice: границы должны оставлять непустой центр ячейки.');return margins;
}
export function scale9Borders(value,width,height){const m=validateNineSlice(value,width,height);return m?{x:m.left,y:m.top,w:width-m.left-m.right,h:height-m.top-m.bottom}:null;}
