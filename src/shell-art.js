// Decorative geometry appears in the empty workspace only. No asset filters.
(() => {
 const canvas=document.querySelector('#appearanceSculpture'); if(!canvas)return;
 const ctx=canvas.getContext('2d'); if(!ctx)return;
 const empty=document.querySelector('#previewEmpty');
 const state={variant:document.documentElement.dataset.theme==='light'?'alba':'prism'};
 let mesh=[],angle=0,raf=0,previousTime=0; const smoothPointer={x:0,y:0};
 function visible(){return !document.hidden && !empty.classList.contains('hidden');}
 function motion(){return document.documentElement.dataset.shellMotion!=='off' && !matchMedia('(prefers-reduced-motion: reduce)').matches;}
const add=(a,b)=>a.map((v,i)=>v+b[i]),sub=(a,b)=>a.map((v,i)=>v-b[i]),mul=(a,n)=>a.map(v=>v*n),dot=(a,b)=>a.reduce((v,x,i)=>v+x*b[i],0),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],unit=a=>mul(a,1/(Math.hypot(...a)||1));
function rotate(p,ax,ay,az){let [x,y,z]=p;let c=Math.cos(ax),s=Math.sin(ax);[y,z]=[y*c-z*s,y*s+z*c];c=Math.cos(ay);s=Math.sin(ay);[x,z]=[x*c+z*s,-x*s+z*c];c=Math.cos(az);s=Math.sin(az);return[x*c-y*s,x*s+y*c,z];}
function makeTube(curve,tube,steps=96,sides=12,transform=p=>p,material=0){const vertices=[];for(let i=0;i<=steps;i++){const t=i/steps*Math.PI*2,c=curve(t),tangent=unit(sub(curve(t+.002),curve(t-.002)));const curvature=sub(add(curve(t+.002),curve(t-.002)),mul(c,2));let n=unit(sub(curvature,mul(tangent,dot(curvature,tangent)))),b=unit(cross(tangent,n));let ring=[];for(let j=0;j<sides;j++){const v=j/sides*Math.PI*2,point=add(c,add(mul(n,Math.cos(v)*tube),mul(b,Math.sin(v)*tube)));ring.push(transform(point));}vertices.push(ring);}for(let i=0;i<steps;i++)for(let j=0;j<sides;j++)mesh.push({points:[vertices[i][j],vertices[i+1][j],vertices[i+1][(j+1)%sides],vertices[i][(j+1)%sides]],phase:i/steps,material});}
function resetSculpture(){mesh=[];angle=0;if(state.variant==='prism'){makeTube(t=>{const r=.9+.3*Math.cos(3*t);return[r*Math.cos(2*t),r*Math.sin(2*t),.44*Math.sin(3*t)];},.21,144,24,p=>rotate(p,.32,.18,.18));}
 else if(state.variant==='alba'){makeTube(t=>[.78*Math.cos(t),.78*Math.sin(t),0],.22,120,24,p=>add(rotate(p,.28,.55,-.3),[-.33,.03,.1]),0);makeTube(t=>[.73*Math.cos(t),.73*Math.sin(t),0],.2,120,24,p=>add(rotate(p,1.1,-.3,.35),[.43,-.13,-.1]),1);}
 else{makeTube(t=>[.85*Math.cos(t),.85*Math.sin(t),.23*Math.sin(t*3)],.23,64,5,p=>rotate(p,.8,.15,.2),0);makeTube(t=>[.7*Math.cos(t),.7*Math.sin(t),0],.14,56,4,p=>add(rotate(p,.25,.85,-.5),[.27,-.1,-.3]),1);}
 resizeSculpture();}
function resizeSculpture(){if(!visible())return;const r=canvas.getBoundingClientRect();if(r.width<2||r.height<2)return;const dpr=Math.min(1.5,window.devicePixelRatio||1);canvas.width=Math.round(r.width*dpr);canvas.height=Math.round(r.height*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);drawSculpture();}
function drawSculpture(){if(!visible())return;const w=canvas.clientWidth,h=canvas.clientHeight;if(w<2||h<2)return;ctx.clearRect(0,0,w,h);const size=Math.min(w*.335,h*.29),cx=w*.51,cy=h*.48,ay=angle+smoothPointer.x*.13,ax=-.13+smoothPointer.y*.09;
 const light=unit([-1,-1.2,1.8]),view=[0,0,1],half=unit(add(light,view));
 const faces=mesh.map(f=>{const p=f.points.map(p=>rotate(p,ax,ay,.04)),normal=unit(cross(sub(p[3],p[0]),sub(p[1],p[0]))),center=mul(p.reduce((a,b)=>add(a,b),[0,0,0]),.25);return{...f,p,normal,center};}).filter(f=>dot(f.normal,sub([0,0,3.7],f.center))>0).sort((a,b)=>a.center[2]-b.center[2]);
 for(const f of faces){const diffuse=Math.max(0,dot(f.normal,light)),spec=Math.pow(Math.max(0,dot(f.normal,half)),state.variant==='prism'?28:state.variant==='alba'?44:70),rim=Math.pow(1-Math.abs(f.normal[2]),3);let r,g,b;
 if(state.variant==='prism'){const t=f.phase*Math.PI*2,hue=.5+.5*Math.sin(t+.8);r=32+82*hue+85*diffuse+150*spec+35*rim;g=45+38*(1-hue)+108*diffuse+160*spec+22*rim;b=85+52*hue+116*diffuse+150*spec+37*rim;}
 else if(state.variant==='alba'){const base=f.material?144:157;r=base+66*diffuse+72*spec+16*rim;g=base+5+69*diffuse+70*spec+18*rim;b=base+10+73*diffuse+70*spec+20*rim;}
 else{const base=f.material?28:36;r=base+63*diffuse+190*spec+45*rim;g=base+5+72*diffuse+190*spec+52*rim;b=base+11+83*diffuse+190*spec+63*rim;}
 const project=p=>{const z=3.7/(3.7-p[2]);return[cx+p[0]*size*z,cy+p[1]*size*z];};ctx.beginPath();f.p.forEach((p,i)=>{const q=project(p);i?ctx.lineTo(...q):ctx.moveTo(...q);});ctx.closePath();ctx.fillStyle=`rgb(${Math.min(255,r)|0},${Math.min(255,g)|0},${Math.min(255,b)|0})`;ctx.strokeStyle=ctx.fillStyle;ctx.lineWidth=.65;ctx.fill();ctx.stroke();}
}

 function tick(time){raf=0;if(!visible()||!motion())return;raf=requestAnimationFrame(tick);if(time-previousTime<90)return;const dt=Math.min(120,time-previousTime||90);previousTime=time;angle+=dt*.00007;drawSculpture();}
 function refresh(){cancelAnimationFrame(raf);raf=0;if(!visible())return;resizeSculpture();if(motion())raf=requestAnimationFrame(tick);}
 const resizeObserver=new ResizeObserver(refresh);resizeObserver.observe(canvas);
 const visibilityObserver=new MutationObserver(refresh);visibilityObserver.observe(empty,{attributes:true,attributeFilter:['class']});
 document.addEventListener('spriteLab:appearance',()=>{state.variant=document.documentElement.dataset.theme==='light'?'alba':'prism';resetSculpture();refresh();});
 document.addEventListener('visibilitychange',refresh);
 window.addEventListener('pagehide',()=>{cancelAnimationFrame(raf);resizeObserver.disconnect();visibilityObserver.disconnect();});
 resetSculpture();refresh();
})();
