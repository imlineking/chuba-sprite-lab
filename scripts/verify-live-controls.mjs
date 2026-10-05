// Real renderer events and processor IPC in an isolated Electron profile.
// Optional second argument checks an existing packaged executable; never builds.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
const root=path.resolve(import.meta.dirname,'..'), output=path.resolve(process.argv[2]);
await fs.mkdir(output,{recursive:true});
const fixture=path.join(output,'islands.png'), w=160,h=100;
const pixels=Buffer.alloc(w*h*4);
for(let y=25;y<75;y++)for(let x=40;x<120;x++)pixels.set([70,130,35,255],(y*w+x)*4);
for(const [x,y,c] of [[10,10,255],[50,15,255],[110,80,255],[15,15,235]])pixels.set([c,c,c,255],(y*w+x)*4);
await sharp(pixels,{raw:{width:w,height:h,channels:4}}).png().toFile(fixture);
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const exe=process.argv[3]||path.join(root,'node_modules/electron/dist/electron.exe');
const child=spawn(exe,[...(process.argv[3]?[]:['.']),'--ui-regression',`--remote-debugging-port=${port}`,'--self-test-user-data',path.join(output,'profile')],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{void fs.appendFile(path.join(output,'app.log'),chunk);});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));let socket,call,evaluate;const checks=[],exceptions=[];
try{
  let target;
  for(let i=0;i<900;i++){try{target=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.url.includes('index.html'));if(target)break;}catch{}await pause(200);}
  assert.ok(target,'App opens');socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise(resolve=>socket.addEventListener('open',resolve,{once:true}));
  let id=0;const pending=new Map();socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.method==='Runtime.exceptionThrown')exceptions.push(message.params.exceptionDetails.text);if(pending.has(message.id)){pending.get(message.id)(message);pending.delete(message.id);}});
  call=(method,params={})=>new Promise(resolve=>{const n=++id;pending.set(n,resolve);socket.send(JSON.stringify({id:n,method,params}));});
  evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.result.exceptionDetails)throw new Error(r.result.exceptionDetails.exception?.description||r.result.exceptionDetails.text);return r.result.result?.value;};
  const wait=async expression=>{for(let i=0;i<600;i++){if(await evaluate(expression))return;await pause(100);}throw new Error('Timeout: '+expression);};
  await call('Runtime.enable');await call('Page.enable');await call('Page.bringToFront');await call('Emulation.setDeviceMetricsOverride',{width:1360,height:900,deviceScaleFactor:1,mobile:false});
  await wait('typeof window.resetMaskNavigation==="function"');
  await pause(800);await evaluate('if(!$("#userNameModal").classList.contains("hidden"))$("#closeUserName").click();setLocale("ru",{persist:false})');
  await evaluate(`(async()=>{setSource(await spriteLab.restoreProject({source:{kind:'frames',paths:[${JSON.stringify(fixture)},${JSON.stringify(fixture)}]}}));state.intent='images';document.body.dataset.intent='images';setKeyMode('alpha');$('#fringeCleanup').checked=false;state.maskEdits=[];await requestFramePreview(currentFramePath());setTab('process');})()`);
  await pause(400);await evaluate('document.getAnimations().filter(a=>Number.isFinite(a.effect.getComputedTiming().endTime)).forEach(a=>a.finish());updateHandTool()');
  assert.equal(await evaluate('$("#toleranceRow").classList.contains("hidden")'),true);checks.push('Inactive background tolerance hidden for existing transparency');
  const mouse=async(type,x,y,buttons=1)=>call('Input.dispatchMouseEvent',{type,x,y,button:'left',buttons,clickCount:1});
  const drag=async(selector,dx,dy)=>{const p=await evaluate(`(()=>{const r=$(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()`);await mouse('mousePressed',p.x,p.y);await mouse('mouseMoved',p.x+dx,p.y+dy);await mouse('mouseReleased',p.x+dx,p.y+dy,0);};
  await drag('#previewImage',40,20);assert.equal(await evaluate('state.viewportPanX'),40);assert.equal(await evaluate('state.viewportPanY'),20);
  await evaluate('state.selectedFrameIndex=1');assert.equal(await evaluate('handToolActive()'),true);
  const preview=await evaluate('(()=>{const r=$("#previewStage").getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()');
  await call('Input.dispatchMouseEvent',{type:'mouseWheel',...preview,deltaX:0,deltaY:-120});await pause(100);assert.ok(await evaluate('state.zoom>1'));checks.push('Main preview pans by default and wheel zooms after object change');
  await evaluate('openMaskEditor({tool:"color"})');await wait('!$("#aiMaskModal").classList.contains("hidden")');
  assert.ok(await evaluate('$("#maskCanvas").getBoundingClientRect().width>400'));await drag('#maskCanvas',30,20);assert.equal(await evaluate('maskNav.x'),30);assert.equal(await evaluate('maskNav.y'),20);
  const point=await evaluate('(()=>{const r=$("#maskCanvas").getBoundingClientRect();return{x:r.left+10.5/160*r.width,y:r.top+10.5/100*r.height};})()');
  await call('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:-120});await pause(100);assert.ok(await evaluate('maskNav.zoom>1'));
  const seed=await evaluate('(()=>{const r=$("#maskCanvas").getBoundingClientRect();return{x:r.left+10.5/160*r.width,y:r.top+10.5/100*r.height};})()');
  await mouse('mousePressed',seed.x,seed.y);await mouse('mouseReleased',seed.x,seed.y,0);
  assert.equal(await evaluate('state.maskEdits.at(-1)?.type'),'region-color');assert.equal(await evaluate('state.maskEdits.at(-1).selection'),null);
  assert.ok(await evaluate('(()=>{const p=$("#maskCanvas").getContext("2d").getImageData(10,10,1,1).data;return p[0]>170 && p[0]>p[1];})()'));
  await evaluate('$("#smartRegionTolerance").value="0";$("#smartRegionTolerance").dispatchEvent(new Event("input"))');
  assert.ok(await evaluate('$("#maskToolTip").textContent.includes("3 пикселей")'));
  await evaluate('$("#smartRegionTolerance").value="90";$("#smartRegionTolerance").dispatchEvent(new Event("input"))');assert.ok(await evaluate('$("#maskToolTip").textContent.includes("4 пикселей")'));
  await evaluate('closeMaskEditor({discard:true})');assert.equal(await evaluate('state.maskEdits.length'),0);checks.push('Mask fit, drag, zoom, transformed sample, all disconnected islands, live tolerance and cancel');
  await evaluate('openMaskEditor({tool:"color"})');await wait('state.maskEditorImage!==null');await evaluate('previewGlobalMaskColor([255,255,255]);$("#applyMaskEditor").click()');
  await wait('state.framePreview && state.framePreview.afterUrl && state.maskEditorImage===null');await pause(800);
  const bytes=await evaluate('(async()=>{const img=await loadUiImage(state.framePreview.afterUrl,"test");const c=document.createElement("canvas");c.width=img.naturalWidth;c.height=img.naturalHeight;const ctx=c.getContext("2d");ctx.drawImage(img,0,0);return Array.from(ctx.getImageData(0,0,c.width,c.height).data);})()');
  for(const [x,y]of [[10,10],[50,15],[110,80],[15,15]])assert.equal(bytes[(y*w+x)*4+3],0);
  assert.equal(bytes[(50*w+70)*4+3],255);assert.equal(await evaluate('state.maskEdits.at(-1).frameIndex'),1);checks.push('Applied mask removes every island in selected second frame, preserves green object');
  await evaluate('state.maskEdits=[];setKeyMode("white");$("#keyScope").value="all";$("#tolerance").value="0";$("#tolerance").dispatchEvent(new Event("input"))');await pause(1000);
  const a=await evaluate('state.framePreview.afterUrl');await evaluate('$("#tolerance").value="90";$("#tolerance").dispatchEvent(new Event("input"))');await wait(`state.framePreview.afterUrl!==${JSON.stringify(a)}`);checks.push('Background strength invokes processor and refreshes after preview');
  const gradient=path.join(output,'gradient.png'), grad=Buffer.alloc(61*41*4);
  for(let y=2;y<=38;y++)for(let x=2;x<=58;x++)grad.set([x*3,y*4,30,255],(y*61+x)*4);
  await sharp(grad,{raw:{width:61,height:41,channels:4}}).png().toFile(gradient);
  await evaluate(`(async()=>{setSource(await spriteLab.restoreProject({source:{kind:'frames',paths:[${JSON.stringify(gradient)}]}}));state.intent='images';state.maskEdits=[];setKeyMode('alpha');$('#fringeCleanup').checked=false;$('#edgeRefineWhiteOnly').checked=false;$('#edgeRefineMode').value='recolor';$('#edgeRefineWidth').value='1';$('#edgeRefineDepth').value='2';await requestFramePreview(currentFramePath());})()`);
  await wait('state.framePreview?.afterPath');const shallowPath=await evaluate('state.framePreview.afterPath');
  await evaluate('$("#edgeRefineDepth").value="8";$("#edgeRefineDepth").dispatchEvent(new Event("input"))');await wait(`state.framePreview.afterPath!==${JSON.stringify(shallowPath)}`);
  const deepPath=await evaluate('state.framePreview.afterPath'), shallowBytes=await sharp(shallowPath).raw().toBuffer(), deepBytes=await sharp(deepPath).raw().toBuffer();
  assert.notDeepEqual(shallowBytes,deepBytes);for(let i=3;i<grad.length;i+=4)assert.equal(deepBytes[i],grad[i]);checks.push('Changing inward sample depth from 2 to 8 px updates distinct local contour colours without changing alpha');
  for(const theme of ['light','dark']){await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};openMaskEditor({tool:'color'})`);await pause(500);const shot=await call('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(output,'mask-'+theme+'.png'),Buffer.from(shot.result.data,'base64'));await evaluate('closeMaskEditor({discard:true})');}
  assert.deepEqual(await fs.readFile(fixture),await sharp(pixels,{raw:{width:w,height:h,channels:4}}).png().toBuffer());assert.deepEqual(exceptions,[]);
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({ok:true,checks,exceptions,sourceUnchanged:true},null,2));console.log(JSON.stringify({ok:true,checks}));
}catch(error){if(call){const shot=await call('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(output,'failure.png'),Buffer.from(shot.result.data,'base64'));}await fs.writeFile(path.join(output,'report.json'),JSON.stringify({ok:false,checks,error:error.stack,exceptions,view:await evaluate?.('({mode:state.previewMode,hand:handToolActive(),source:state.source?.kind,preview:state.framePreview,transform:state.transformPanelOpen,modals:[...document.querySelectorAll("[role=dialog]")].filter(e=>!e.classList.contains("hidden")).map(e=>e.id)})')},null,2));throw error;}
finally{if(socket?.readyState===WebSocket.OPEN){try{await evaluate?.('window.spriteLabPrepareEditorClose=()=>true;window.spriteLabHasUnsavedChanges=()=>false;spriteLab.close()');await pause(500);}catch{}socket.close();}child.kill();}
