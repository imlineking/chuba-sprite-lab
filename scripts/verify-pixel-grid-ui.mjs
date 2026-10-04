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
  const second=path.join(output,'second.png');await fs.copyFile(input,second);
  await evaluate(`(async()=>{setSource(await spriteLab.restoreProject({source:{kind:'frames',paths:${JSON.stringify([input,second])}}}));window.startImageEditing();setKeyMode('alpha');$('#fringeCleanup').checked=false;$('#edgeDecontaminate').checked=false;$('#edgeRefineMode').value='none';$('#toningEnabled').checked=false;$('#colorStyle').value='none';setTab('process');})()`);
  const decode = file => sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const samePixels = (a,b) => assert.equal(crypto.createHash('sha256').update(a).digest('hex'),crypto.createHash('sha256').update(b).digest('hex'));
  await evaluate("$('#pixelatePanel').open=true;document.querySelector('[data-pixel-block=\"4\"]').click()");
  assert.equal(await evaluate("collectOptions().pixelate.gridMode==='fixed' && collectOptions().pixelate.size===4"), true);
  await evaluate("$('#pixelateGridMode').value='target';$('#pixelateTargetWidth').value='64';$('#pixelateTargetHeight').value='64';$('#pixelExportScale').value='2';$('#pixelateGridMode').dispatchEvent(new Event('change'));$('#pixelExportScale').dispatchEvent(new Event('change'))");
  assert.equal(await evaluate("$('#pixelateSize').disabled && !$('#pixelateTargetWidth').disabled"),true);
  await evaluate(`requestFramePreview(${JSON.stringify(input)})`);
  const livePath = await evaluate('state.framePreview.afterPath'), live = await decode(livePath);
  assert.equal(live.info.width,128);assert.equal(live.info.height,128);
  await pause(600);
  for (const theme of ['light','dark']) {
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};$('#pixelatePanel').scrollIntoView({block:'start'})`);
    await pause(150);await screenshot('main-target-'+theme+'.png');
    assert.equal(await evaluate("$('#pixelateGridMode').getBoundingClientRect().right <= $('#pixelatePanel').getBoundingClientRect().right"),true);
  }
  await evaluate("$('#pixelateTargetWidth').value='48';$('#pixelateTargetWidth').dispatchEvent(new Event('change'))");await pause(600);
  await evaluate("$('#undoAction').click()");assert.equal(await evaluate("$('#pixelateTargetWidth').value"),'64');
  await evaluate("$('#redoAction').click()");assert.equal(await evaluate("$('#pixelateTargetWidth').value"),'48');
  await evaluate("$('#pixelateEnabled').checked=false;$('#pixelateEnabled').dispatchEvent(new Event('change'));window.openImageBatchPreview({automatic:false,options:{...collectOptions(),keyMode:'alpha',pixelate:null,pixelScale:1}})");
  await waitFor('!state.busy && Object.keys(imageBatchDraft.results).length===2');
  await evaluate("$('#imageBatchPixelation').open=true;$('#imageBatchPixelateEnabled').checked=true;$('#imageBatchGridMode').value='target';$('#imageBatchTargetWidth').value='64';$('#imageBatchTargetHeight').value='64';$('#imageBatchPixelateEnabled').dispatchEvent(new Event('change'));$('#imageBatchScale').value='2';$('#imageBatchScale').dispatchEvent(new Event('change'));$('#prepareImageBatch').click()");
  await waitFor('!state.busy && Object.keys(imageBatchDraft.results).length===2');
  const results=await evaluate('Object.values(imageBatchDraft.results).map(r=>r.imagePath)');
  for(const file of results){const actual=await decode(file);assert.equal(actual.info.width,128);assert.equal(actual.info.height,128);for(let y=0;y<128;y++)for(let x=0;x<128;x++){const a=(y*128+x)*4,b=(Math.floor(y/2)*2*128+Math.floor(x/2)*2)*4;for(let c=0;c<4;c++)assert.equal(actual.data[a+c],actual.data[b+c]);}}
  for(const [width,height] of [[1360,900],[1024,768]]){
    await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    for(const theme of ['light','dark']){await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};$('#imageBatchPixelation').scrollIntoView({block:'start'})`);await pause(150);await screenshot(`batch-grid-${width}-${theme}.png`);assert.equal(await evaluate("$('.batch-preview-footer').getBoundingClientRect().bottom<=innerHeight"),true);}
  }
  await evaluate("$('#applyImageBatch').click()");await waitFor("$('#imageBatchModal').classList.contains('hidden')");
  await evaluate("$('#undoAction').click()");assert.equal(await evaluate('Object.keys(state.frameOverrides).length'),0);
  await evaluate("$('#redoAction').click()");assert.equal(await evaluate('Object.keys(state.frameOverrides).length'),2);
  const saved = await evaluate(`(async()=>{state.outputFolder=${JSON.stringify(path.join(output,'saved'))};return window.saveIndependentImages({all:true});})()`);
  assert.equal(saved.completed,2);assert.equal(saved.failed,0);
  for(let i=0;i<2;i++)samePixels((await decode(saved.results[i].imagePath)).data,(await decode(results[i])).data);
  await evaluate("window.openImageBatchPreview({automatic:false,options:{...collectOptions(),keyMode:'alpha',pixelate:null,pixelScale:1}})");await waitFor('!state.busy');
  await evaluate("$('#imageBatchOutput').value='sheet';$('#imageBatchOutput').dispatchEvent(new Event('change'))");
  assert.equal(await evaluate('Object.keys(imageBatchDraft.results).length'),0);
  await evaluate("$('#prepareImageBatch').click()");await waitFor('!state.busy && Object.keys(imageBatchDraft.results).length===2');
  const bases = await evaluate('Object.values(imageBatchDraft.results).map(r=>r.imagePath)');
  for(const file of bases){const meta=await sharp(file).metadata();assert.equal(meta.width,64);assert.equal(meta.height,64);}
  await evaluate("$('#prepareImageBatch').click()");await waitFor('!state.busy && Boolean(imageBatchDraft.assembly)');
  const assembled=await evaluate('imageBatchDraft.assembly.result');assert.equal(assembled.cellWidth,128);assert.equal(assembled.cellHeight,128);
  assert.equal(await evaluate("$('#applyImageBatch').disabled"),false);
  const sheetSaved = await evaluate(`spriteLab.build(batchAssemblyRequest(false,${JSON.stringify(path.join(output,'sheet-saved'))}))`);
  assert.equal(sheetSaved.cellWidth,128);assert.equal(sheetSaved.cellHeight,128);await fs.access(sheetSaved.manifestPath);
  assert.equal(crypto.createHash('sha256').update(await fs.readFile(input)).digest('hex'),originalHash);assert.deepEqual(exceptions,[]);
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({input,originalHash,mainTargetPreview:true,settingsUndoRedo:true,batchTarget:true,batchApplyUndoRedo:true,savedPngMatchesPreview:true,sheetScaleAppliedOnce:true,sourceUnchanged:true,exceptions},null,2));
  console.log(JSON.stringify({ok:true,output}));
} finally {socket?.close();child.kill();}
