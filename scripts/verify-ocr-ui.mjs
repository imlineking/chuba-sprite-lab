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


  const fixture=path.join(output,'fixture.png');
  const png=await evaluate("(()=>{const c=document.createElement('canvas');c.width=700;c.height=230;const x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,700,230);x.fillStyle='#151515';x.font='48px Arial';x.fillText('SPRITE LAB 2026',25,65);x.fillText('Привет мир',25,135);return c.toDataURL('image/png').split(',')[1]})()");
  await fs.writeFile(fixture,Buffer.from(png,'base64'));
  await evaluate('(async()=>{setSource(await spriteLab.restoreProject({source:{kind:"frames",paths:['+JSON.stringify(fixture)+']}}));window.startImageEditing();await pixelEditorOpen();await pixelEditorSend({op:"selectPixels",from:[5,5],to:[680,150]});$("#pixelOCRDetails").open=true;$("#pixelOCRRun").click();})()');
  await waitFor('!$("#pixelOCRRun").disabled');
  const recognized=await evaluate('$("#pixelOCRResult").value');assert.match(recognized,/SPRITE LAB 2026/);assert.match(recognized,/Привет мир/);
  const confidence=await evaluate('$("#pixelOCRStatus").textContent');assert.match(confidence,/Уверенность OCR:/);
  await evaluate('$("#pixelOCRResult").value="Исправлено Ёж";$("#pixelOCRResult").dispatchEvent(new Event("input"));$("#pixelOCRUse").click()');
  await waitFor('!$("#pixelTextApply").disabled');
  assert.equal(await evaluate('$("#pixelTextContent").value'),'Исправлено Ёж');
  await evaluate('$("#pixelTextApply").click()');await waitFor('pixelEditor.layers.some(l=>l.kind==="text")&&!spriteLabTextUI.hasDraft()');
  await evaluate('$("#pixelUndo").click();await pixelEditorFlush();await pixelEditorSend({op:"selectPixels",from:[10,10],to:[650,80]});spriteLabTextUI.open(true);$("#pixelFontSample").value="SPRITE LAB 2026";$("#pixelFontMatchDetails").open=true;$("#pixelFontFind").click()');
  await waitFor('!$("#pixelFontFind").disabled');
  const candidates=await evaluate('[...$("#pixelFontCandidates").children].map(x=>x.firstChild.textContent)');console.log(await evaluate('$("#pixelFontMatchStatus").textContent'));assert.equal(candidates.length,5);assert.ok(candidates.some(name=>name.startsWith('Arial')),candidates.join(', '));
  await evaluate('$("#pixelFontCandidates").firstChild.click()');await waitFor('!$("#pixelTextApply").disabled');await evaluate('pixelEditorCancelPreview()');
  await evaluate('await pixelEditorSend({op:"selectPixels",from:[10,10],to:[650,150]});$("#pixelTextRepairRun").click()');
  await waitFor('!$("#pixelTextRepairRun").disabled');assert.equal(await evaluate('$("#pixelTextRepairApply").disabled'),false);
  const beforeRepair=await evaluate('Array.from(pixelEditor.composite)');
  await evaluate('$("#pixelTextRepairApply").click();await pixelEditorFlush()');
  const repaired=await evaluate('Array.from(pixelEditor.composite)');assert.notDeepEqual(repaired,beforeRepair);assert.equal(repaired[(50*700+50)*4],255);
  await evaluate('$("#pixelUndo").click();await pixelEditorFlush()');assert.deepEqual(await evaluate('Array.from(pixelEditor.composite)'),beforeRepair);
  await evaluate('$("#pixelRedo").click();await pixelEditorFlush()');assert.deepEqual(await evaluate('Array.from(pixelEditor.composite)'),repaired);
  await evaluate('$("#pixelOCRDetails").open=true;$("#pixelOCRDetails").scrollIntoView({block:"center"})');
  for(const theme of ['light','dark']){await evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme));await pause(100);await screenshot('ocr-'+theme+'.png');}
  await call('Emulation.setDeviceMetricsOverride',{width:1024,height:768,deviceScaleFactor:1,mobile:false});await pause(100);await screenshot('ocr-1024.png');
  assert.equal(await evaluate('$(".pixel-editor-card").getBoundingClientRect().right<=innerWidth'),true);
  assert.deepEqual(exceptions,[]);assert.equal(crypto.createHash('sha256').update(await fs.readFile(input)).digest('hex'),originalHash);
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({ok:true,recognized,confidence,candidates,manualCorrection:true,textLayer:true,repairPreviewAndUndo:true,sourceUnchanged:true,exceptions},null,2));console.log(JSON.stringify({ok:true,output}));
} finally {socket?.close();child.kill();}
