(() => {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v)));
  function footprint(x, y, size = 1, shape = 'square', hardness = 100) {
    size = Math.round(clamp(size || 1, 1, 64)); hardness = clamp(hardness ?? 100, 0, 100);
    const left = Math.round(x - (size - 1) / 2), top = Math.round(y - (size - 1) / 2), radius = size === 2 ? .72 : (size - 1) / 2 + .01, softRadius = Math.max(.5, size / 2);
    const pixels = [];
    for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) {
      const distance = shape === 'round' ? Math.hypot(dx - (size - 1) / 2, dy - (size - 1) / 2) : Math.max(Math.abs(dx - (size - 1) / 2), Math.abs(dy - (size - 1) / 2));
      let coverage = 1;
      if (hardness === 100) { if (shape === 'round' && distance > radius) continue; }
      else { const core = softRadius * hardness / 100; coverage = distance <= core ? 1 : Math.max(0, (softRadius - distance) / (softRadius - core)); }
      if (coverage > 0) pixels.push([left + dx, top + dy, coverage]);
    }
    return pixels;
  }
  function line(from, to) {
    let [x,y]=from.map(Math.round); const [tx,ty]=to.map(Math.round), dx=Math.abs(tx-x),dy=Math.abs(ty-y),sx=x<tx?1:-1,sy=y<ty?1:-1; let e=dx-dy; const points=[];
    for (;;) { points.push([x,y]); if(x===tx&&y===ty)break;const d=e*2;if(d>-dy){e-=dy;x+=sx;}if(d<dx){e+=dx;y+=sy;} }
    return points;
  }
  function stroke(data, width, height, { points = [], color = [0,0,0,255], size = 1, shape = 'square', hardness = 100, opacity = 100, erase = false, symmetry = 'none', pixelPerfect = false, wrap = false } = {}) {
    if (data.length !== width * height * 4 || points.length > 100000) throw new Error('Недопустимый мазок.');
    points = points.map(p => [Math.round(clamp(p[0],0,width-1)),Math.round(clamp(p[1],0,height-1))]);
    const path = []; for(let i=0;i<points.length;i++){ const segment=i?line(points[i-1],points[i]).slice(1):[points[i]];path.push(...segment); }
    if (pixelPerfect && size === 1) for (let i=1;i<path.length-1;i++) { const a=path[i-1],b=path[i],c=path[i+1];if(Math.abs(a[0]-c[0])===1&&Math.abs(a[1]-c[1])===1&&(a[0]===b[0]||a[1]===b[1])&&(b[0]===c[0]||b[1]===c[1])){path.splice(i,1);i--;}}
    const coverage = new Float32Array(width*height);
    for (const [x,y] of path) {
      const centres=[[x,y]]; if(['x','both'].includes(symmetry))centres.push([width-1-x,y]);if(['y','both'].includes(symmetry))centres.push([x,height-1-y]);if(symmetry==='both')centres.push([width-1-x,height-1-y]);
      for(const [cx,cy] of centres)for(const [px,py,value]of footprint(cx,cy,size,shape,hardness)){const tx=wrap?((px%width)+width)%width:px,ty=wrap?((py%height)+height)%height:py;if(tx>=0&&ty>=0&&tx<width&&ty<height)coverage[ty*width+tx]=Math.max(coverage[ty*width+tx],value);}
    }
    const output = new Uint8ClampedArray(data), strength = clamp(opacity ?? 100,0,100)/100;
    for(let i=0;i<coverage.length;i++) {
      if(!coverage[i])continue;const o=i*4,a=coverage[i]*strength*(erase?1:(color[3]??255)/255),base=data[o+3]/255;
      if(erase){output[o+3]=Math.round(data[o+3]*(1-a));if(!output[o+3])output.fill(0,o,o+4);}
      else {const out=a+base*(1-a);for(let k=0;k<3;k++)output[o+k]=out?Math.round((color[k]*a+data[o+k]*base*(1-a))/out):0;output[o+3]=Math.round(out*255);}
    }
    return output;
  }
  globalThis.SpriteLabBrush = { footprint, line, stroke };
})();
