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



  const fixtures=[path.join(output,'flower-0.png'),path.join(output,'flower-1.png')];
  for(let i=0;i<2;i++)await sharp(input).resize(180,180,{fit:'contain',background:{r:0,g:0,b:0,alpha:0}}).extend({top:60,bottom:0,left:10+i*5,right:20-i*5,background:{r:0,g:0,b:0,alpha:0}}).png().toFile(fixtures[i]);
  await evaluate('(async()=>{setSource(await spriteLab.restoreProject({source:{kind:"frames",paths:'+JSON.stringify(fixtures)+'}}));window.startImageEditing();state.intent="animation";await pixelEditorOpen();})()');
  assert.deepEqual(await evaluate('pixelEditor.frameIndices'),[0,1]);assert.equal(await evaluate('pixelEditorHasPendingEdits()'),false);
  await evaluate('$("#pixelFrameNext").click();await pixelEditorFlush()');assert.equal(await evaluate('pixelEditor.frameIndex'),1);assert.equal(await evaluate('pixelEditorHasPendingEdits()'),false);
  await evaluate('$("#pixelFramePrev").click();await pixelEditorFlush();$("#pixelBrushOpacity").value="50";$("#pixelBrushSize").value="4";pixelEditorSyncBrush();pixelEditorSetColor([120,90,220,255]);pixelEditor.cursor={x:20,y:20,inside:true};pixelEditorRenderCanvas()');
  const strokeBefore=await evaluate('Array.from(pixelEditor.composite)');
  // Exercise actual pointer handlers and capture path rather than calling the pixel model.
  await evaluate('(()=>{const c=$("#pixelCanvas"),b=c.getBoundingClientRect(),p=(x,y)=>({button:0,pointerId:7,clientX:b.left+(x+.5)/pixelEditor.width*b.width,clientY:b.top+(y+.5)/pixelEditor.height*b.height,currentTarget:{}});pixelEditorPointerDown(p(20,20));pixelEditorPointerMove(p(40,20));pixelEditorPointerMove(p(25,20));pixelEditorPointerUp(p(25,20));})()');await evaluate('await pixelEditorFlush()');
  assert.equal(await evaluate('pixelEditor.composite[(20*pixelEditor.width+30)*4+3]'),128);
  await evaluate('$("#pixelUndo").click();await pixelEditorFlush()');assert.deepEqual(await evaluate('Array.from(pixelEditor.composite)'),strokeBefore);assert.equal(await evaluate('pixelEditorHasPendingEdits()'),false);
  await evaluate('$("#pixelRedo").click();await pixelEditorFlush();$("#pixelFrameNext").click();await pixelEditorFlush()');assert.equal(await evaluate('pixelEditorHasPendingEdits()'),true);
  await evaluate('$("#pixelFrameDuration").value="240";$("#pixelFrameDuration").dispatchEvent(new Event("change"));await pixelEditorFlush();$("#pixelFrameOnion").checked=true;$("#pixelFrameOnion").dispatchEvent(new Event("change"));await pixelEditorFlush()');
  assert.equal(await evaluate('pixelEditor.durationMs'),240);assert.equal(await evaluate('pixelEditor.onion.length'),1);
  await evaluate('spriteLabTextUI.open(true);$("#pixelTextContent").value="Ёж 2026";$("#pixelTextX").value="10";$("#pixelTextY").value="3";$("#pixelTextContent").dispatchEvent(new Event("input"))');await waitFor('!$("#pixelTextApply").disabled');await evaluate('$("#pixelTextApply").click()');await waitFor('pixelEditor.layers.some(l=>l.kind==="text")&&!spriteLabTextUI.hasDraft()');
  await evaluate('$("#pixelTextAcrossFrames").click();await pixelEditorFlush();$("#pixelFramePrev").click();await pixelEditorFlush()');assert.equal(await evaluate('pixelEditor.layers.find(l=>l.kind==="text").text.text'),'Ёж 2026');
  await evaluate('$("#pixelFrameOnion").checked=false;$("#pixelFrameOnion").dispatchEvent(new Event("change"));await pixelEditorFlush();await pixelEditorSave()');
  const records=await evaluate('state.frameDocuments');assert.equal(Object.keys(records).length,2);
  for(const record of Object.values(records)){const doc=JSON.parse(await fs.readFile(record.path,'utf8'));assert.equal(doc.layers.filter(l=>l.kind==='text').length,1);assert.equal(doc.layers.find(l=>l.kind==='text').text.text,'Ёж 2026');}
  await evaluate('await pixelEditorClose();await pixelEditorOpen();$("#pixelFrameNext").click();await pixelEditorFlush()');assert.equal(await evaluate('pixelEditor.durationMs'),240);assert.equal(await evaluate('pixelEditor.layers.find(l=>l.kind==="text").text.text'),'Ёж 2026');
  for(const theme of ['light','dark']){await evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme));await pause(100);await screenshot('editor-'+theme+'.png');}
  await call('Emulation.setDeviceMetricsOverride',{width:1024,height:768,deviceScaleFactor:1,mobile:false});await pause(100);await screenshot('editor-1024.png');assert.equal(await evaluate('$(".pixel-editor-card").getBoundingClientRect().right<=innerWidth'),true);
  await evaluate('$("#pixelFramePlay").click()');await pause(350);await evaluate('$("#pixelFramePlay").click()');assert.equal(await evaluate('$("#pixelFramePlay").textContent'),'▶ Просмотр');
  assert.deepEqual(exceptions,[]);assert.equal(crypto.createHash('sha256').update(await fs.readFile(input)).digest('hex'),originalHash);
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({ok:true,twoRealFlowerFrames:true,sharedHistory:true,strokeOpacityAndSingleUndo:true,onion:true,frameDurationReopened:true,commonEditableTextReopened:true,saveAllFrames:true,playback:true,sourceUnchanged:true,exceptions},null,2));console.log(JSON.stringify({ok:true,output}));
} finally {socket?.close();child.kill();}
