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
  await evaluate(`(async()=>{setSource(await spriteLab.restoreProject({source:{kind:'frames',paths:${JSON.stringify([input,second])}}}));window.startImageEditing();setKeyMode('alpha');$('#pixelateEnabled').checked=false;$('#toningEnabled').checked=false;$('#fringeCleanup').checked=false;$('#edgeDecontaminate').checked=false;$('#edgeRefineMode').value='none';setTab('process');})()`);
  await evaluate("$('#openPixelEditor').click()");await waitFor('Boolean(pixelEditor.sessionId) && Boolean(pixelEditor.composite)');
  await evaluate("$('#pixelAdjustDetails').open=false");await pause(100);await evaluate("$('#pixelAdjustDetails').open=true");await pause(100);
  await evaluate("window.p2Original=Uint8ClampedArray.from(pixelEditor.composite);$('#pixelAdjustStyle').value='warm-to-cool';$('#pixelAdjustStyle').dispatchEvent(new Event('change',{bubbles:true}))");
  await waitFor('Boolean(pixelEditor.preview)');
  assert.equal(await evaluate("(()=>{const expected=SpriteLabPixelColors.adjust(window.p2Original,{style:'warm-to-cool',styleStrength:100});return pixelEditor.preview.every((v,i)=>v===expected[i]);})()"),true);
  for(const theme of ['light','dark']){
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};$('#pixelAdjustDetails').scrollIntoView({block:'start'})`);await pause(150);await screenshot('editor-style-'+theme+'.png');
    assert.equal(await evaluate("$('#pixelAdjustStyle').getBoundingClientRect().right <= $('.pixel-editor-side').getBoundingClientRect().right"),true,'Style select overflows editor');
  }
  await evaluate("$('#pixelAdjustCancel').click()");assert.equal(await evaluate('pixelEditor.preview===null && pixelEditor.composite.every((v,i)=>v===window.p2Original[i])'),true);
  await evaluate("$('#pixelAdjustDetails').open=true");await pause(100);await evaluate("$('#pixelAdjustStyle').value='warm-to-cool';$('#pixelAdjustStyle').dispatchEvent(new Event('change'));$('#pixelAdjustStyleStrength').value='65';$('#pixelAdjustStyleStrength').dispatchEvent(new Event('input'))");await waitFor('Boolean(pixelEditor.preview)');
  await evaluate("window.p2Expected=Uint8ClampedArray.from(pixelEditor.preview);$('#pixelAdjustApply').click()");
  await waitFor('!pixelColorBusy && pixelEditor.preview===null');assert.equal(await evaluate('pixelEditor.composite.every((v,i)=>v===window.p2Expected[i])'),true);
  await evaluate("$('#pixelUndo').click()");await waitFor('pixelEditor.composite.every((v,i)=>v===window.p2Original[i])');
  await evaluate("$('#closePixelEditor').click()");await waitFor("$('#pixelEditorModal').classList.contains('hidden')");
  await evaluate("$('#toningPanel').open=true;$('#colorStyle').value='warm-to-cool';$('#colorStyle').dispatchEvent(new Event('change'));$('#colorStyleStrength').value='65';$('#colorStyleStrength').dispatchEvent(new Event('input'))");
  await waitFor('Boolean(state.framePreview)');await pause(1000);
  const live=await evaluate('state.framePreview.afterPath');
  const {adjustImageRgba}=await import('../src/color-adjust.mjs');
  const raw=file=>sharp(file).toColourspace('srgb').ensureAlpha().raw().toBuffer();
  const samePixels=(a,b,label)=>assert.equal(crypto.createHash('sha256').update(a).digest('hex'),crypto.createHash('sha256').update(b).digest('hex'),label);
  const pixels=await raw(input);samePixels(await raw(live),adjustImageRgba(pixels,{style:'warm-to-cool',styleStrength:65}));
  await screenshot('main-live-style.png');
  await evaluate("$('#colorStyle').value='none';$('#colorStyle').dispatchEvent(new Event('change'));window.openImageBatchPreview({automatic:false,options:{...collectOptions(),keyMode:'alpha',colorAdjust:null}})");
  await waitFor('!state.busy && Object.keys(imageBatchDraft.results).length===2');
  const bases=await evaluate('Object.values(imageBatchDraft.results).map(r=>r.colorBasePath)');assert.ok(bases.every(Boolean));
  await evaluate("$('#imageBatchReviewScale').value='original';$('#imageBatchReviewScale').dispatchEvent(new Event('change'));$('#imageBatchStyle').scrollIntoView({block:'center'});$('#imageBatchStyle').value='warm-to-cool';$('#imageBatchStyle').dispatchEvent(new Event('change'))");
  await waitFor("$('#imageBatchAfter').src.startsWith('data:image/png')");assert.equal(await evaluate("$('#applyImageBatch').disabled"),true);
  const liveData=await evaluate("$('#imageBatchAfter').src.split(',')[1]");const displayed=await raw(Buffer.from(liveData,'base64')), expectedLive=adjustImageRgba(await raw(bases[0]),{style:'warm-to-cool',styleStrength:100}); let mismatch=0;for(let i=0;i<displayed.length;i+=4){assert.equal(displayed[i+3],expectedLive[i+3]);if(displayed[i+3]===255)for(let c=0;c<3;c++)if(displayed[i+c]!==expectedLive[i+c])mismatch++;} assert.equal(mismatch,0,'Opaque preview colours differ');
  for(const [width,height] of [[1360,900],[1024,768]]){
    await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    for(const theme of ['light','dark']){await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);await evaluate("(()=>{const pane=$('.batch-preview-settings'),row=$('.batch-color-adjust');pane.scrollTop+=row.getBoundingClientRect().top-pane.getBoundingClientRect().top-12;})()");await pause(150);await screenshot(`batch-style-${width}-${theme}.png`);assert.equal(await evaluate("$('.batch-preview-footer').getBoundingClientRect().bottom<=innerHeight"),true);}
  }
  await evaluate("$('#prepareImageBatch').click()");await waitFor('!state.busy && Object.keys(imageBatchDraft.results).length===2');
  const results=await evaluate('Object.values(imageBatchDraft.results).map(r=>r.imagePath)');
  for(const file of results)samePixels(await raw(file),adjustImageRgba(pixels,{style:'warm-to-cool',styleStrength:100}));
  await evaluate("$('#applyImageBatch').click()");await waitFor("$('#imageBatchModal').classList.contains('hidden')");
  const saved=await evaluate(`(async()=>{state.outputFolder=${JSON.stringify(path.join(output,'saved'))};return window.saveIndependentImages({all:true});})()`);
  assert.equal(saved.completed,2);assert.equal(saved.failed,0);
  for(let i=0;i<2;i++)samePixels(await raw(saved.results[i].imagePath),await raw(results[i]),'Style reapplied while saving accepted PNG');
  assert.equal(crypto.createHash('sha256').update(await fs.readFile(input)).digest('hex'),originalHash);
  assert.deepEqual(exceptions,[]);
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({input,originalHash,editorPreviewApplyUndo:true,mainLivePreview:true,batchLivePreview:true,seriesSavedEqualPreview:true,sourceUnchanged:true,exceptions},null,2));
  console.log(JSON.stringify({ok:true,output}));
} finally {socket?.close();child.kill();}
