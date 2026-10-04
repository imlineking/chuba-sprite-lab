(() => {
  function points(kind, from, to, filled = false) {
    const left=Math.min(from[0],to[0]),right=Math.max(from[0],to[0]),top=Math.min(from[1],to[1]),bottom=Math.max(from[1],to[1]);
    if(kind==='line')return [from,to];
    if(kind==='rectangle'){
      if(!filled)return [[left,top],[right,top],[right,bottom],[left,bottom],[left,top]];
      const path=[];for(let y=top;y<=bottom;y++)path.push(...(y%2?[[right,y],[left,y]]:[[left,y],[right,y]]));return path;
    }
    if(kind!=='ellipse')throw new Error('Неизвестная фигура.');
    const rx=(right-left)/2,ry=(bottom-top)/2,cx=(right+left)/2,cy=(top+bottom)/2;
    if(!rx||!ry)return [[left,top],[right,bottom]];
    const path=[];
    if(filled){for(let y=top;y<=bottom;y++){const half=rx*Math.sqrt(Math.max(0,1-((y-cy)/ry)**2)),a=[Math.ceil(cx-half),y],b=[Math.floor(cx+half),y];path.push(...(y%2?[b,a]:[a,b]));}}
    else {const steps=Math.max(12,Math.ceil(2*Math.PI*Math.max(rx,ry)));for(let i=0;i<=steps;i++){const angle=i*2*Math.PI/steps;path.push([Math.round(cx+rx*Math.cos(angle)),Math.round(cy+ry*Math.sin(angle))]);}}
    return path;
  }
  globalThis.SpriteLabShapes={points};
})();
