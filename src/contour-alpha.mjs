/** Alpha-only inward contour falloff. RGB and source pixels are never repainted. */
export function contourAlphaRgba(data, info, options = {}) {
  const out = Buffer.from(data);
  if (!options.enabled) return { data: out, changed: 0, protected: 0 };
  const {width:w,height:h,channels}=info;
  if (channels !== 4 || data.length !== w*h*4) throw new Error('Градиент контура требует RGBA.');
  const width = Math.max(1, Math.min(256, Number(options.width) || 24));
  const curve = Math.max(.25, Math.min(4, Number(options.curve) || 1));
  const thin = Math.max(0, Math.min(32, Number(options.thinRadius) || 0));
  const d = new Float32Array(w*h), diag=Math.SQRT2;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const i=y*w+x;
    d[i]=data[i*4+3]===0?0:Math.min(x+1,y+1,w-x,h-y);
    if(!d[i])continue;
    if(x) d[i]=Math.min(d[i],d[i-1]+1);
    if(y){d[i]=Math.min(d[i],d[i-w]+1);if(x)d[i]=Math.min(d[i],d[i-w-1]+diag);if(x+1<w)d[i]=Math.min(d[i],d[i-w+1]+diag);}
  }
  for(let y=h-1;y>=0;y--)for(let x=w-1;x>=0;x--){
    const i=y*w+x;if(!d[i])continue;
    if(x+1<w)d[i]=Math.min(d[i],d[i+1]+1);
    if(y+1<h){d[i]=Math.min(d[i],d[i+w]+1);if(x)d[i]=Math.min(d[i],d[i+w-1]+diag);if(x+1<w)d[i]=Math.min(d[i],d[i+w+1]+diag);}
  }
  // A separable local thickness envelope adapts the falloff across narrow branches.
  // It protects their complete cross-section, rather than isolated ridge pixels.
  const radius=Math.ceil(thin),horizontal=new Float32Array(w*h),thickness=new Float32Array(w*h);
  if(radius>0){
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      let m=0;for(let xx=Math.max(0,x-radius);xx<=Math.min(w-1,x+radius);xx++)m=Math.max(m,d[y*w+xx]);horizontal[y*w+x]=m;
    }
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      let m=0;for(let yy=Math.max(0,y-radius);yy<=Math.min(h-1,y+radius);yy++)m=Math.max(m,horizontal[yy*w+x]);thickness[y*w+x]=m;
    }
  }
  const smooth=t=>{t=Math.max(0,Math.min(1,t));return t*t*(3-2*t);};
  let changed=0,protectedPixels=0;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const i=y*w+x,p=i*4,a=data[p+3];if(!a)continue;
    let factor=Math.max(.02,smooth((d[i]-.5)/width)**curve);
    // Protection is tied to depth within the real contour, never to white colour alone.
    if(options.protectCore !== false){
      const lo=Math.min(data[p],data[p+1],data[p+2]),hi=Math.max(data[p],data[p+1],data[p+2]);
      if(lo>=235&&hi-lo<=24) factor=Math.max(factor,smooth((d[i]/width-.3)/.45));
    }
    if(thin>0&&thickness[i]<=thin){
      const adapted=Math.max(.02,smooth((d[i]-.5)/Math.max(.5,thickness[i]-.5))**curve);
      if(adapted>factor){factor=adapted;protectedPixels++;}
    }
    const alpha=Math.min(a,Math.round(a*factor));
    if(alpha!==a){out[p+3]=alpha;changed++;}
  }
  return {data:out,changed,protected:protectedPixels};
}
