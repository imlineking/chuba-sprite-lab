// Shared pure colour math for palette, live preview and regression tests.
(() => {
  function hsvToRgb(h, s, v) {
    const k = n => (n + h / 60) % 6;
    const f = n => Math.round(255 * v * (1 - s * Math.max(0, Math.min(k(n), 4 - k(n), 1))));
    return [f(5), f(3), f(1), 255];
  }
  function rgbToHsv(rgb) {
    const [r,g,b] = rgb.map(n => n / 255), max = Math.max(r,g,b), min = Math.min(r,g,b), d = max-min;
    let h = !d ? 0 : max === r ? ((g-b)/d)%6 : max === g ? (b-r)/d+2 : (r-g)/d+4;
    return [(h*60+360)%360, max ? d/max : 0, max];
  }
  function palette(pixels) {
    const histogram = new Map();
    for (let i=0;i+3<pixels.length;i+=4) {
      if (!pixels[i+3]) continue;
      const key=(pixels[i]<<16)|(pixels[i+1]<<8)|pixels[i+2];
      histogram.set(key,(histogram.get(key)||0)+1);
    }
    const colors=[...histogram].map(([key,count])=>({color:[key>>16,(key>>8)&255,key&255,255],count}));
    const bins=new Map();
    for(const item of colors) {
      const [r,g,b]=item.color, key=((r>>4)<<8)|((g>>4)<<4)|(b>>4);
      const old=bins.get(key);
      if(!old)bins.set(key,{...item,total:item.count});
      else {old.total+=item.count;if(item.count>old.count){old.color=item.color;old.count=item.count;}}
    }
    const candidates=[...bins.values()].sort((a,b)=>b.total-a.total), chosen=[];
    while(candidates.length && chosen.length<32) {
      let best=0,score=-1;
      candidates.forEach((item,i)=>{
        const distance=chosen.length?Math.min(...chosen.map(c=>item.color.slice(0,3).reduce((sum,n,k)=>sum+(n-c[k])**2,0))):1;
        const rank=Math.cbrt(item.total)*Math.sqrt(distance);
        if(rank>score){score=rank;best=i;}
      });
      chosen.push(candidates.splice(best,1)[0].color);
    }
    // Representative first four rows, then every exact colour. No invented averaged swatches.
    const keys=new Set(chosen.map(c=>c.slice(0,3).join(',')));
    colors.sort((a,b)=>b.count-a.count);
    return [...chosen,...colors.filter(item=>!keys.has(item.color.slice(0,3).join(','))).map(item=>item.color)];
  }
  function matches(pixels, color, tolerance=0) {
    const offsets=[];
    for(let i=0;i+3<pixels.length;i+=4)if(pixels[i+3] && [0,1,2].every(k=>Math.abs(pixels[i+k]-color[k])<=tolerance))offsets.push(i);
    return offsets;
  }
  function preview(pixels, offsets, color, erase=false) {
    const output=Uint8ClampedArray.from(pixels);
    for(const i of offsets) {output[i]=erase?0:color[0];output[i+1]=erase?0:color[1];output[i+2]=erase?0:color[2];if(erase)output[i+3]=0;}
    return output;
  }
  function adjust(pixels, options={}) {
    const bounded=(name,min=-100,max=100)=>Math.max(min,Math.min(max,Number(options[name])||0))/100;
    const brightness=bounded('brightness'), saturation=1+bounded('saturation'), contrast=2**(bounded('contrast')*2), warmth=bounded('warmth');
    const shadows=bounded('shadows'),highlights=bounded('highlights'),strength=bounded('tintStrength',0,100);
    const hex=/^#([0-9a-f]{6})$/i.exec(String(options.tint||'#ffffff'));
    const tint=hex?[0,2,4].map(i=>parseInt(hex[1].slice(i,i+2),16)/255):[1,1,1];
    const out=Uint8ClampedArray.from(pixels);
    for(let i=0;i<out.length;i+=4) {
      if(!out[i+3])continue;
      const rgb=[pixels[i]/255,pixels[i+1]/255,pixels[i+2]/255];
      const lum=rgb[0]*0.2126+rgb[1]*0.7152+rgb[2]*0.0722;
      const shift=brightness+0.5*shadows*(1-lum)**2+0.5*highlights*lum**2;
      for(let c=0;c<3;c++) {
        const temperature=c===0?warmth*.18:c===1?warmth*.025:-warmth*.18;
        const value=(lum+(rgb[c]-lum)*saturation-0.5)*contrast+0.5+shift+temperature;
        out[i+c]=Math.round(255*Math.max(0,Math.min(1,value*(1-strength+strength*tint[c]))));
      }
    }
    return out;
  }
  globalThis.SpriteLabPixelColors=Object.freeze({palette,matches,preview,hsvToRgb,rgbToHsv,adjust});
})();
