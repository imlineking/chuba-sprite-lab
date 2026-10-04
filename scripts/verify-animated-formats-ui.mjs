// End-to-end check of image actions; optional fourth argument tests an existing EXE.
// This script never builds an EXE.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import net from "node:net";
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
let socket;
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



  const codecs=await import('../src/animated-images.mjs'),processor=await import('../src/processor.mjs'),describe=await import('../src/source-describe.mjs');
  const pixels=Buffer.alloc(48*48*4),second=Buffer.alloc(pixels.length);for(let y=8;y<24;y++)for(let x=6;x<20;x++)pixels.set([255,0,0,255],(y*48+x)*4);for(let y=10;y<26;y++)for(let x=24;x<38;x++)second.set([0,255,0,255],(y*48+x)*4);
  const frames=[{pixels,durationMs:80},{pixels:second,durationMs:230},{pixels:second,durationMs:110}];
  const codecReports={};
  for(const format of ['gif','apng']){
    const bytes=format==='gif'?await codecs.encodeGIF(frames,48,48,{loop:2}):codecs.encodeAPNG(frames,48,48,{loop:2});const file=path.join(output,'timing.'+format);await fs.writeFile(file,bytes);
    const mime=format==='gif'?'image/gif':'image/png';
    const result=await evaluate('(async()=>{const data=Uint8Array.from(atob('+JSON.stringify(bytes.toString('base64'))+'),c=>c.charCodeAt(0));const decoder=new ImageDecoder({data,type:'+JSON.stringify(mime)+'});await decoder.tracks.ready;const track=decoder.tracks.selectedTrack;const frames=[];for(let i=0;i<track.frameCount;i++){const result=await decoder.decode({frameIndex:i});const c=document.createElement("canvas");c.width=48;c.height=48;const x=c.getContext("2d");x.drawImage(result.image,0,0);frames.push({duration:result.image.duration,pixels:Array.from(x.getImageData(0,0,48,48).data)});result.image.close();}const out={count:track.frameCount,repetitionCount:track.repetitionCount,frames};decoder.close();return out;})()');
    assert.equal(result.count,3);assert.equal(result.repetitionCount,1);assert.deepEqual(result.frames.map(f=>f.duration/1000),[80,230,110]);for(let i=0;i<3;i++)assert.deepEqual(result.frames[i].pixels,[...frames[i].pixels]);
    codecReports[format]={browserFrames:result.count,durations:result.frames.map(f=>f.duration/1000),repetitionCount:result.repetitionCount};
    const descriptor=await describe.describePaths(root,'frames',[file]);assert.equal(descriptor.paths.length,3);assert.deepEqual(Object.values(descriptor.frameMetadata).map(f=>f.durationMs),[80,230,110]);
    await evaluate('(async()=>{setSource(await spriteLab.restoreProject({source:'+JSON.stringify({kind:'frames',paths:descriptor.paths,frameMetadata:descriptor.frameMetadata,animatedImport:true,maskPrepared:true})+'}));await pixelEditorOpen();})()');
    assert.equal(await evaluate('state.intent'),'animation');assert.equal(await evaluate('pixelEditor.frameIndices.length'),3);await evaluate('await pixelEditorClose()');
    const exported=await processor.processSprites({source:descriptor,outputDir:output,name:'export-'+format,appRoot:root,options:{keyMode:'alpha',autoSize:false,cellWidth:48,cellHeight:48,padding:0,preserveFrameCanvas:true,anchor:'center',exports:{sheet:false,frames:false,metadata:false,preview:false,gif:format==='gif',apng:format==='apng'}}});
    assert.equal(exported.previewPaths.length,1);const parsed=await codecs.readAnimatedImage(exported.previewPaths[0]);assert.equal(parsed.frames.length,3);assert.equal(parsed.loop,2);assert.deepEqual(parsed.frames.map(f=>f.durationMs),[80,230,110]);
  }
  await evaluate('setTab("export");$(".export-details").open=true');for(const theme of ['light','dark']){await evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme));await evaluate("document.querySelector('.export-details').scrollIntoView({block:'center'});document.getAnimations().forEach(a=>a.finish())");await pause(600);await screenshot('exports-'+theme+'.png');}
  assert.deepEqual(exceptions,[]);assert.equal(crypto.createHash('sha256').update(await fs.readFile(input)).digest('hex'),originalHash);
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({ok:true,codecReports,sourceImportDurations:true,applicationExport:true,sourceUnchanged:true,exceptions},null,2));console.log(JSON.stringify({ok:true,output}));
} finally {socket?.close();child.kill();}
