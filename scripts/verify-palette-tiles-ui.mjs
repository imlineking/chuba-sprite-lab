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



  const fixture=path.join(output,'tile.png');const pixels=Buffer.alloc(16*16*4);for(let y=4;y<12;y++)for(let x=4;x<12;x++)pixels.set([200+x,80+y,60,255],(y*16+x)*4);await sharp(pixels,{raw:{width:16,height:16,channels:4}}).png().toFile(fixture);
  await evaluate('(async()=>{setSource(await spriteLab.restoreProject({source:{kind:"frames",paths:['+JSON.stringify(fixture)+']}}));await pixelEditorOpen();})()');
  const original=await evaluate('Array.from(pixelEditor.composite)');
  await evaluate('$("#pixelDocumentPaletteLimit").value="8";$("#pixelDocumentPalettePrepare").click()');await waitFor('window.spriteLabPaletteUI.hasDraft()');assert.deepEqual(await evaluate('Array.from(pixelEditor.composite)'),original);assert.notDeepEqual(await evaluate('Array.from(pixelEditor.preview)'),original);
  await evaluate('$("#pixelDocumentPaletteApply").click();await pixelEditorFlush()');assert.equal(await evaluate('pixelEditor.colorMode'),'indexed');assert.equal(await evaluate('pixelEditor.documentPalette.length'),8);
  await evaluate('$("#pixelUndo").click();await pixelEditorFlush()');assert.equal(await evaluate('pixelEditor.colorMode'),'rgba');assert.deepEqual(await evaluate('Array.from(pixelEditor.composite)'),original);await evaluate('$("#pixelRedo").click();await pixelEditorFlush()');
  await evaluate('$("#pixelTileWrap").checked=true;$("#pixelTileWrap").dispatchEvent(new Event("change"));pixelEditorSetColor([210,90,60,255]);await pixelEditorSend({op:"paint",from:[0,0],to:[0,0],color:pixelEditor.color,size:3,wrap:true});');assert.equal(await evaluate('pixelEditor.composite[(15*16+15)*4+3]'),255);assert.equal(await evaluate('$("#pixelTilePreview").hidden'),false);
  for(const theme of ['light','dark']){await evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme)+';$("#pixelDocumentPaletteLimit").closest("details").open=true;$("#pixelDocumentPaletteLimit").scrollIntoView({block:"center"});document.getAnimations().forEach(a=>a.finish())');await pause(600);await screenshot('palette-'+theme+'.png');}
  await evaluate('await pixelEditorSave();await pixelEditorClose();await pixelEditorOpen()');assert.equal(await evaluate('pixelEditor.colorMode'),'indexed');assert.equal(await evaluate('pixelEditor.documentPalette.length'),8);
  const record=await evaluate('state.frameDocuments[0]'),encoded=JSON.parse(await fs.readFile(record.path,'utf8'));assert.ok(encoded.layers[0].indices);const doc=(await import('../src/editor-document.mjs')).decodeEditorDocument(encoded,{width:16,height:16}),model=await import('../src/sprite-document.mjs');assert.deepEqual(Buffer.from(model.compositeFrame(doc,0)),await sharp(record.imagePath).ensureAlpha().raw().toBuffer());await evaluate('await pixelEditorClose()');
  assert.deepEqual(exceptions,[]);assert.equal(crypto.createHash('sha256').update(await fs.readFile(input)).digest('hex'),originalHash);
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({ok:true,indexedMode:true,previewApplyUndoRedo:true,indicesReopened:true,seamlessBrush:true,trueAlpha:true,sourceUnchanged:true,exceptions},null,2));console.log(JSON.stringify({ok:true,output}));
} finally {socket?.close();child.kill();}
