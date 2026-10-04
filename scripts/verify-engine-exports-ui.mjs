// End-to-end check of image actions; optional fourth argument tests an existing EXE.
// This script never builds an EXE.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import net from "node:net";
import http from "node:http";
import crypto from "node:crypto";
import sharp from "sharp";

const root = path.resolve(import.meta.dirname, "..");
const input = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const executable = process.argv[4] ? path.resolve(process.argv[4]) : path.join(root, "node_modules/electron/dist/electron.exe");
await fs.access(input); await fs.mkdir(output, { recursive: true });
await fs.access(executable);
const originalHash = crypto.createHash("sha256").update(await fs.readFile(input)).digest("hex");
const port = await new Promise((resolve, reject) => {
  const server = net.createServer(); server.on("error", reject);
  server.listen(0, "127.0.0.1", () => { const value = server.address().port; server.close(() => resolve(value)); });
});
const child = spawn(executable,
  [...(process.argv[4] ? [] : ["."]), "--ui-regression", `--remote-debugging-port=${port}`, "--self-test-user-data", path.join(output, "profile")],
  { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { void fs.appendFile(path.join(output, "app.log"), chunk); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket;let server;
try {
  let target;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.url.includes("index.html")); if (target) break; } catch { /* Starting. */ }
    await pause(200);
  }
  assert.ok(target, "Окно проверяемой версии не открылось");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
  let nextId = 0; const pending = new Map(); const exceptions = [];
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  });
  const call = (method, params = {}) => new Promise(resolve => { const id = ++nextId; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => {
    if (/\bawait\b/.test(expression) && !expression.startsWith("(async")) expression = `(async()=>{${expression}})()`;
    const response = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (response.result.exceptionDetails) throw new Error(response.result.exceptionDetails.exception?.description || response.result.exceptionDetails.text);
    return response.result.result?.value;
  };
  const screenshot = async name => {
    const result = await call("Page.captureScreenshot", { format: "png" });
    await fs.writeFile(path.join(output, name), Buffer.from(result.result.data, "base64"));
  };
  await call("Runtime.enable"); await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate("typeof setSource==='function' && typeof window.openImageBatchPreview==='function'")) break;
    await pause(100);
  }
  await evaluate("if (!$('#userNameModal').classList.contains('hidden')) $('#closeUserName').click()");

  await pause(800);await evaluate("if (!$('#userNameModal').classList.contains('hidden')) $('#closeUserName').click()");
  const waitFor = async expression => {
    for(let i=0;i<400;i++){if(await evaluate(expression))return;await pause(100);}
    throw new Error('Timeout: '+expression);
  };



  const directory=path.join(output,'fixture');await fs.mkdir(directory,{recursive:true});const file=path.join(directory,'panel.png'),pixels=Buffer.alloc(16*16*4);
  for(let y=0;y<16;y++)for(let x=0;x<16;x++){const border=x<4||x>=12||y<4||y>=12;pixels.set(border?[x<8?255:0,y<8?0:255,x>=8?255:0,255]:[120,170,80,128],(y*16+x)*4);}await sharp(pixels,{raw:{width:16,height:16,channels:4}}).png().toFile(file);
  const processor=await import('../src/processor.mjs'),options={keyMode:'alpha',cellWidth:16,cellHeight:16,autoSize:false,padding:0,preserveFrameCanvas:true,packing:'grid',anchor:'center',exportFormat:'three',gpuFormat:'dds-bc3',nineSlice:{left:4,right:4,top:4,bottom:4},exports:{sheet:true,metadata:true,frames:false,preview:false}};
  const three=await processor.processSprites({source:{kind:'frames',paths:[file]},outputDir:output,name:'three-panel',options,appRoot:root}),phaser=await processor.processSprites({source:{kind:'frames',paths:[file]},outputDir:output,name:'phaser-panel',options:{...options,gpuFormat:'none',exportFormat:'phaser3'},appRoot:root});
  await evaluate('setTab("export");$("#exportFormat").value="three";$("#exportFormat").dispatchEvent(new Event("change"));$("#gpuFormat").value="dds-bc3";$("#gpuFormat").dispatchEvent(new Event("change"));$("#nineSliceEnabled").checked=true;$("#nineSliceEnabled").closest("details").open=true;document.getAnimations().forEach(a=>a.finish());$("#gpuFormat").scrollIntoView({block:"start"});');await pause(600);await screenshot('engine-export-light.png');
  const html='<!doctype html><html><head><script type="importmap">'+JSON.stringify({imports:{three:'/node_modules/three/build/three.module.js','three/addons/':'/node_modules/three/examples/jsm/'}})+'</script><script src="/node_modules/phaser/dist/phaser.js"></script></head><body></body></html>';
  server=http.createServer(async(req,res)=>{try{if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname),target=path.resolve(root,'.'+pathname);if(!target.startsWith(root+path.sep))throw new Error('Outside');res.setHeader('Content-Type',/\.(js|mjs)$/.test(target)?'text/javascript':target.endsWith('.json')?'application/json':target.endsWith('.png')?'image/png':'application/octet-stream');res.end(await fs.readFile(target));}catch{res.statusCode=404;res.end();}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port,url=file=>origin+'/'+path.relative(root,file).replaceAll('\\','/');
  await call('Page.navigate',{url:origin+'/'});await waitFor('document.querySelector("script[src]") && typeof Phaser!=="undefined"');
  const moduleURL=url(three.engineFiles.find(p=>p.endsWith('.three.mjs'))),jsonURL=url(three.engineFiles.find(p=>p.endsWith('.three.json')));
  const engine=await evaluate('(async()=>{const THREE=await import("three"),helper=await import('+JSON.stringify(moduleURL)+'),renderer=new THREE.WebGLRenderer({alpha:true,antialias:false});renderer.setSize(80,56);document.body.append(renderer.domElement);const atlas=await helper.loadAtlas('+JSON.stringify(jsonURL)+',{renderer,preferCompressed:true});const png=await helper.loadAtlas('+JSON.stringify(jsonURL)+',{renderer});const name=atlas.manifest.frames[0].name;const camera=new THREE.OrthographicCamera(-8,8,8,-8,.1,10);camera.position.z=1;const target=new THREE.WebGLRenderTarget(16,16);target.texture.colorSpace=THREE.SRGBColorSpace;function render(a){const mesh=helper.frameMesh(a,name);mesh.material.blending=THREE.NoBlending;const scene=new THREE.Scene();scene.add(mesh);renderer.setRenderTarget(target);renderer.clear();renderer.render(scene,camera);const pixels=new Uint8Array(16*16*4);renderer.readRenderTargetPixels(target,0,0,16,16,pixels);mesh.geometry.dispose();mesh.material.dispose();return [...pixels];}const exact=render(png),compressed=render(atlas);const mesh=helper.frameMesh(atlas,name,{width:64,height:40});const scene=new THREE.Scene();scene.add(mesh);const view=new THREE.OrthographicCamera(-40,40,28,-28,.1,10);view.position.z=1;renderer.setRenderTarget(null);renderer.render(scene,view);const out={isCompressed:atlas.textures[0].isCompressedTexture===true,s3tc:renderer.extensions.has("WEBGL_compressed_texture_s3tc"),s3tcSRGB:renderer.extensions.has("WEBGL_compressed_texture_s3tc_srgb"),positionCount:mesh.geometry.attributes.position.count,exact,compressed,renderer:renderer.getContext().getParameter(renderer.getContext().RENDERER)};return out;})()');
  assert.equal(engine.isCompressed,true,'The real Three.js renderer must use DDS, not the PNG fallback');assert.equal(engine.positionCount,54);let maxRGB=0,maxAlpha=0;for(let i=0;i<engine.exact.length;i+=4){maxAlpha=Math.max(maxAlpha,Math.abs(engine.exact[i+3]-engine.compressed[i+3]));if(engine.exact[i+3])for(let k=0;k<3;k++)maxRGB=Math.max(maxRGB,Math.abs(engine.exact[i+k]-engine.compressed[i+k]));}assert.ok(maxRGB<=10,'GPU colour error: '+maxRGB);assert.ok(maxAlpha<=1,'GPU alpha error: '+maxAlpha);await screenshot('three-nine-slice.png');
  const phaserJSON=url(phaser.engineFiles.find(p=>p.endsWith('.phaser.json'))),phaserBase=url(phaser.outputDir)+ '/';
  const phaserResult=await evaluate('(async()=>{return await new Promise((resolve,reject)=>{const game=new Phaser.Game({type:Phaser.WEBGL,width:80,height:56,transparent:true,render:{antialias:false,preserveDrawingBuffer:true},scene:{preload(){this.load.multiatlas("panel",'+JSON.stringify(phaserJSON)+','+JSON.stringify(phaserBase)+');},create(){try{const frame=this.textures.getFrame("panel","frame_0000"),name=this.textures.get("panel").getFrameNames()[0],real=this.textures.getFrame("panel",name),object=this.add.nineslice(40,28,"panel",name,64,40);setTimeout(()=>resolve({version:Phaser.VERSION,frameName:name,nineSlice:real.data.scale9Borders,left:object.leftWidth,right:object.rightWidth,top:object.topHeight,bottom:object.bottomHeight,width:object.width,height:object.height}),200);}catch(e){reject(e);}}}});});})()');
  assert.deepEqual(phaserResult.nineSlice,{x:4,y:4,w:8,h:8});assert.equal(phaserResult.left,4);assert.equal(phaserResult.width,64);assert.equal(phaserResult.height,40);await screenshot('phaser-nine-slice.png');
  const codecReports={three:{...engine,exact:undefined,compressed:undefined,maxRGB,maxAlpha},phaser:phaserResult};
  assert.deepEqual(exceptions,[]);assert.equal(crypto.createHash('sha256').update(await fs.readFile(input)).digest('hex'),originalHash);
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({ok:true,codecReports,realEngineImport:true,DDSGPU:true,nineSlice:true,sourceUnchanged:true,exceptions},null,2));console.log(JSON.stringify({ok:true,output}));
} finally {socket?.close();child.kill();server?.close();}
