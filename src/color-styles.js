// Shared by renderer previews and Node exports. No per-frame palette fitting:
// a given RGB value always receives the same mapping across an entire series.
(() => {
  const styles = Object.freeze([
    { id: 'none', label: 'Без стиля', english: 'No style' },
    { id: 'warm', label: 'Тёплый', english: 'Warm' },
    { id: 'cool', label: 'Холодный', english: 'Cool' },
    { id: 'warm-to-cool', label: 'Красный / жёлтый → зелёный / синий', english: 'Red / yellow → green / blue' },
    { id: 'cool-to-warm', label: 'Зелёный / синий → красный / жёлтый', english: 'Green / blue → red / yellow' },
    { id: 'muted', label: 'Приглушённый', english: 'Muted' },
  ].map(Object.freeze));
  const knots = [[0,120],[60,210],[120,240],[180,270],[240,300],[300,360],[360,480]];
  const clamp = value => Math.max(0, Math.min(1, value));
  const luma = rgb => rgb[0]*.2126 + rgb[1]*.7152 + rgb[2]*.0722;
  function hueMap(h, inverse) {
    const points = inverse ? knots.map(([x,y]) => [y,x]) : knots;
    if (inverse && h < 120) h += 360;
    for (let i=1; i<points.length; i++) if (h <= points[i][0]) {
      const [x,y]=points[i-1], [x2,y2]=points[i];
      return ((y+(h-x)/(x2-x)*(y2-y))%360+360)%360;
    }
    return h;
  }
  function hueRgb(h,s,v) {
    const k=n=>(n+h/60)%6;
    const f=n=>v*(1-s*Math.max(0,Math.min(k(n),4-k(n),1)));
    return [f(5),f(3),f(1)];
  }
  // Compress chroma toward the original luminance to fit sRGB without clipping
  // light petals or moving painted shading. Alpha and hidden RGB stay byte-identical.
  function preserveLuma(candidate, lum) {
    const shift=lum-luma(candidate), rgb=candidate.map(v=>v+shift);
    let amount=1;
    for (const v of rgb) if (v>1) amount=Math.min(amount,(1-lum)/(v-lum)); else if (v<0) amount=Math.min(amount,lum/(lum-v));
    return rgb.map(v=>clamp(lum+(v-lum)*amount));
  }
  function apply(pixels, {style='none',styleStrength=100}={}) {
    if (!styles.some(item=>item.id===style)) throw new Error('Неизвестный цветовой стиль: '+style);
    const amount=clamp(Number(styleStrength)/100 || 0), out=Uint8ClampedArray.from(pixels);
    if (style==='none' || !amount) return out;
    for (let i=0; i<out.length; i+=4) {
      if (!pixels[i+3]) continue;
      const rgb=[pixels[i]/255,pixels[i+1]/255,pixels[i+2]/255], lum=luma(rgb);
      let candidate;
      if (style==='muted') candidate=rgb.map(v=>lum+(v-lum)*.55);
      else if (style==='warm' || style==='cool') {
        const shift=(style==='warm'?1:-1)*.10*4*lum*(1-lum);
        candidate=[rgb[0]+shift,rgb[1]+shift*.12,rgb[2]-shift];
      } else {
        const max=Math.max(...rgb), min=Math.min(...rgb), delta=max-min;
        if (delta<.02) continue;
        let h=max===rgb[0]?((rgb[1]-rgb[2])/delta)%6:max===rgb[1]?(rgb[2]-rgb[0])/delta+2:(rgb[0]-rgb[1])/delta+4;
        h=(h*60+360)%360;
        candidate=hueRgb(hueMap(h,style==='cool-to-warm'),max?delta/max:0,max);
      }
      const mapped=preserveLuma(candidate,lum);
      for(let c=0;c<3;c++) out[i+c]=Math.round(255*(rgb[c]+(mapped[c]-rgb[c])*amount));
    }
    return out;
  }
  function active(options={}) {
    return Boolean(options.style && options.style!=='none' && (options.styleStrength===undefined || Number(options.styleStrength)>0));
  }
  globalThis.SpriteLabColorStyles=Object.freeze({styles,apply,active});
})();
