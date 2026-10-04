import sharp from "sharp";
import crypto from 'node:crypto';

// Diagnostic only: motion, highlights and occlusion can legitimately change.
// Sample bounded thumbnails serially; never choose or repaint a mask here.
export async function reviewSeries(frames, signal) {
  const samples = [];
  for (const frame of frames) {
    signal?.throwIfAborted();
    const native=await sharp(frame.buffer).ensureAlpha().raw().toBuffer();
    const { data } = await sharp(frame.buffer).resize(128, 128, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let area = 0, pale = 0, bottom=-1,footX=0,footCount=0,edgeCount=0,fringeCount=0;
    for (let o = 0; o < data.length; o += 4) { if (data[o + 3] >= 128) { area++; if (Math.min(data[o], data[o + 1], data[o + 2]) >= 200) pale++; } }
    for(let i=0;i<128*128;i++)if(data[i*4+3]>=128)bottom=Math.max(bottom,Math.floor(i/128));
    const mask=Uint8Array.from({length:128*128},(_,i)=>data[i*4+3]>=128?1:0);
    for(let y=1;y<127;y++)for(let x=1;x<127;x++){
      const i=y*128+x,o=i*4;if(!data[o+3])continue;
      if(y>=bottom-2&&data[o+3]>=128){footX+=x;footCount++;}
      if([i-1,i+1,i-128,i+128].some(j=>data[j*4+3]<16)){
        edgeCount++;const color=[data[o],data[o+1],data[o+2]],bright=Math.min(...color)>210,colored=(color[0]>180&&color[2]>180&&color[1]<100)||(color[1]>200&&color[0]<80&&color[2]<80);
        if(bright||colored){const donors=[];for(const [dx,dy]of[[-3,0],[3,0],[0,-3],[0,3]]){const nx=x+dx,ny=y+dy;if(nx>=2&&ny>=2&&nx<126&&ny<126){const j=ny*128+nx;if([j,j-2,j+2,j-256,j+256].every(k=>data[k*4+3]>=240))donors.push(j);}}
          if(donors.length&&donors.every(j=>Math.hypot(...color.map((v,k)=>v-data[j*4+k]))>140))fringeCount++;
        }
      }
    }
    samples.push({ frameIndex: frame.sourceIndex, area, pale, bottom,footX:footCount?footX/footCount:null,edgeCount,fringeCount,hash:crypto.createHash('sha256').update(native).digest('hex'),mask });
  }
  const issues = [];
  if(samples.length>2&&samples[0].hash===samples.at(-1).hash&&samples.some(s=>s.hash!==samples[0].hash))issues.push({code:'series-repeated-end',frameIndex:samples.at(-1).frameIndex,message:'Последний кадр совпадает с первым. В цикле это может удлинять паузу; проверьте, нужен ли повтор.'});
  const fringe=samples.filter(s=>s.fringeCount>=6&&s.fringeCount/Math.max(1,s.edgeCount)>.04);
  if(fringe.length)issues.push({code:'series-edge-fringe',frameIndex:fringe[0].frameIndex,message:`Контрастная светлая или цветная кайма у ${fringe.length} кадров. Это может быть ореол или часть рисунка; проверьте на тёмной и светлой подложках.`});
  const sliding=[];for(let i=1;i<samples.length;i++){const a=samples[i-1],b=samples[i];if(a.footX!=null&&b.footX!=null&&Math.abs(a.bottom-b.bottom)<=1&&Math.abs(a.footX-b.footX)>8)sliding.push(b.frameIndex);}
  if(sliding.length)issues.push({code:'series-foot-slide',frameIndex:sliding[0],message:`Нижняя опора смещается при почти неизменной высоте (${sliding.length} переходов). Проверьте скольжение; для полёта и намеренного движения это допустимо.`});
  for (let i = 1; i + 1 < samples.length; i++) {
    const before = samples[i - 1], here = samples[i], after = samples[i + 1];
    const comparable = (a, b) => Math.abs(a - b) <= Math.max(10, Math.max(a, b) * .15);
    const isolatedDrop = (key) => comparable(before[key], after[key]) && Math.min(before[key], after[key]) >= 40 && here[key] < Math.min(before[key], after[key]) * .6;
    if (isolatedDrop("area") || isolatedDrop("pale")) issues.push({ code: "series-mask-change", frameIndex: here.frameIndex, message: "Резкое уменьшение силуэта или светлых деталей относительно соседних кадров. Проверьте маску; движение тоже может объяснять изменение." });
  }
  const similarity=(a,b)=>{let union=0,intersection=0;for(let i=0;i<a.length;i++){if(a[i]||b[i])union++;if(a[i]&&b[i])intersection++;}return union?intersection/union:1;};
  for(let i=1;i+1<samples.length;i++)if(similarity(samples[i-1].mask,samples[i+1].mask)>.85&&similarity(samples[i-1].mask,samples[i].mask)<.55)issues.push({code:'series-mask-flicker',frameIndex:samples[i].frameIndex,message:'Маска среднего кадра резко отличается от похожих соседних. Проверьте мерцание прозрачности или намеренную смену позы.'});
  return { samples:samples.map(({mask:_mask,hash:_hash,...sample})=>sample), issues, diagnosticOnly: true };
}
