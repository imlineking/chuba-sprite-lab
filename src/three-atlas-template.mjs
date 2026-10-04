// Copy this module into a Three.js project together with the JSON and image pages.
// Requires Three.js 0.186+; PNG is always available when S3TC/sRGB is unsupported.
import * as THREE from 'three';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';
export async function loadAtlas(url,{renderer=null,preferCompressed=false}={}){
  const response=await fetch(url);if(!response.ok)throw new Error('Cannot load atlas: '+response.status);
  const manifest=await response.json(),base=new URL('.',new URL(url,globalThis.location?.href||'http://localhost/')),textures=[];
  for(const page of manifest.pages){const compressed=preferCompressed&&page.gpu&&renderer?.extensions.has('WEBGL_compressed_texture_s3tc')&&renderer.extensions.has('WEBGL_compressed_texture_s3tc_srgb');let texture;
    if(compressed)try{texture=await new DDSLoader().loadAsync(new URL(page.gpu.image,base).href);}catch{/* Fall back to the exact original PNG. */}
    texture ||= await new THREE.TextureLoader().loadAsync(new URL(page.image,base).href);texture.colorSpace=THREE.SRGBColorSpace;texture.minFilter=THREE.NearestFilter;texture.magFilter=THREE.NearestFilter;texture.generateMipmaps=false;textures.push(texture);
  }
  return{manifest,textures,dispose(){textures.forEach(t=>t.dispose());}};
}
export function frameMesh(atlas,name,{width=null,height=null}={}){
  const frame=atlas.manifest.frames.find(f=>f.name===name);if(!frame)throw new Error('Unknown atlas frame: '+name);if(frame.rotated)throw new Error('Rotated Three.js frame is not supported.');
  const texture=atlas.textures[frame.page],page=atlas.manifest.pages[frame.page],compressed=texture.isCompressedTexture,tw=compressed?page.gpu.width:page.width,th=compressed?page.gpu.height:page.height;
  const size=frame.sourceSize,box=frame.spriteSourceSize,pivot=frame.pivot||{x:.5,y:.5},w=width??size.w,h=height??size.h,border=frame.nineSlice;
  if(border&&frame.trimmed)throw new Error('Nine-slice requires an untrimmed frame.');
  const sx=border?[0,border.left,size.w-border.right,size.w]:[box.x,box.x+box.w],sy=border?[0,border.top,size.h-border.bottom,size.h]:[box.y,box.y+box.h];
  if(border&&(w<border.left+border.right||h<border.top+border.bottom))throw new Error('Nine-slice target is smaller than its borders.');
  const dx=border?[0,border.left,w-border.right,w]:sx.map(x=>x*w/size.w),dy=border?[0,border.top,h-border.bottom,h]:sy.map(y=>y*h/size.h),positions=[],uv=[];
  const vertex=(x,y,i,j)=>{positions.push(dx[x]-w*pivot.x,h*pivot.y-dy[y],0);const u=(frame.x+sx[i]-box.x)/tw,v=(frame.y+sy[j]-box.y)/th;uv.push(u,compressed?v:1-v);};
  for(let y=0;y<sy.length-1;y++)for(let x=0;x<sx.length-1;x++)for(const[a,b]of[[x,y],[x,y+1],[x+1,y],[x+1,y],[x,y+1],[x+1,y+1]])vertex(a,b,a,b);
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));geometry.computeVertexNormals();
  const material=new THREE.MeshBasicMaterial({map:texture,transparent:true,depthWrite:false,side:THREE.DoubleSide});return new THREE.Mesh(geometry,material);
}
