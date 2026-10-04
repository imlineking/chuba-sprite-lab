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
  await sharp(input).resize(240,240,{fit:'contain',background:{r:0,g:0,b:0,alpha:0}}).extend({top:70,bottom:10,left:40,right:40,background:{r:0,g:0,b:0,alpha:0}}).png().toFile(fixture);
  await evaluate(`(async()=>{setSource(await spriteLab.restoreProject({source:{kind:'frames',paths:[${JSON.stringify(fixture)}]}}));window.startImageEditing();setKeyMode('alpha');$('#fringeCleanup').checked=false;$('#edgeDecontaminate').checked=false;$('#edgeRefineMode').value='none';$('#colorStyle').value='none';$('#pixelateEnabled').checked=false;$('#toningEnabled').checked=false;await pixelEditorOpen();})()`);
  assert.equal(await evaluate('pixelEditorIsOpen()'),true);
  await evaluate("$('#pixelToolText').click()");
  await waitFor("!$('#pixelTextRefresh').disabled");
  const fonts=await evaluate("[...$('#pixelTextFont').options].map(o=>o.value)");assert.ok(fonts.includes('Arial'));assert.ok(fonts.length>100);
  await evaluate("$('#pixelTextContent').value='Ёлка · Жук\\nПривет!';$('#pixelTextFont').value='Arial';$('#pixelTextSize').value='24';$('#pixelTextColor').value='#44dd88';$('#pixelTextStrokeColor').value='#151525';$('#pixelTextStroke').value='2';$('#pixelTextSpacing').value='1';$('#pixelTextLineGap').value='5';$('#pixelTextX').value='10';$('#pixelTextY').value='4';$('#pixelTextContent').dispatchEvent(new Event('input'))");
  await waitFor("!$('#pixelTextApply').disabled");
  const preview=await evaluate('Array.from(pixelEditor.preview)');
  assert.ok(preview.some((v,i)=>i%4===3&&v>0&&preview[i-3]===68&&preview[i-2]===221&&preview[i-1]===136));
  await evaluate("$('#pixelTextApply').click()");await waitFor("pixelEditor.layers.some(l=>l.kind==='text') && !spriteLabTextUI.hasDraft()");
  assert.deepEqual(await evaluate('Array.from(pixelEditor.composite)'),preview);
  const firstText=await evaluate("pixelEditor.layers.find(l=>l.kind==='text').text");assert.equal(firstText.text,'Ёлка · Жук\nПривет!');
  await evaluate("$('#pixelUndo').click();await pixelEditorFlush()");assert.equal(await evaluate("pixelEditor.layers.some(l=>l.kind==='text')"),false);
  await evaluate("$('#pixelRedo').click();await pixelEditorFlush()");assert.deepEqual(await evaluate('Array.from(pixelEditor.composite)'),preview);
  await evaluate("$('#pixelAddText').click()");assert.equal(await evaluate("$('#pixelTextContent').value"),'Текст');
  await evaluate("$('#pixelTextContent').value='Второй';$('#pixelTextContent').dispatchEvent(new Event('input'))");await waitFor("!$('#pixelTextApply').disabled");
  await evaluate("$('#pixelTextApply').click()");await waitFor("pixelEditor.layers.filter(l=>l.kind==='text').length===2&&!spriteLabTextUI.hasDraft()");
  assert.equal(await evaluate("pixelEditor.layers.find(l=>l.id===pixelEditor.activeLayerId).text.text"),'Второй');
  await evaluate("$('#pixelUndo').click();await pixelEditorFlush()");assert.equal(await evaluate("pixelEditor.layers.filter(l=>l.kind==='text').length"),1);
  await evaluate("$('#pixelRedo').click();await pixelEditorFlush()");assert.equal(await evaluate("pixelEditor.layers.filter(l=>l.kind==='text').length"),2);
  await evaluate("$('#pixelRemoveLayer').click();await pixelEditorFlush()");assert.equal(await evaluate("pixelEditor.layers.filter(l=>l.kind==='text').length"),1);
  await evaluate("$('#pixelUndo').click();await pixelEditorFlush()");assert.equal(await evaluate("pixelEditor.layers.filter(l=>l.kind==='text').length"),2);
  await evaluate("$('#pixelRedo').click();await pixelEditorFlush()");assert.equal(await evaluate("pixelEditor.layers.filter(l=>l.kind==='text').length"),1);
  await evaluate("spriteLabTextUI.position({x:30,y:8})");await waitFor("!$('#pixelTextApply').disabled");await evaluate("$('#pixelTextApply').click();await pixelEditorFlush()");
  await waitFor("pixelEditor.layers.find(l=>l.kind==='text').text.x===30");
  await evaluate("$('#pixelUndo').click();await pixelEditorFlush()");assert.equal(await evaluate("pixelEditor.layers.find(l=>l.kind==='text').text.x"),10);
  await evaluate("$('#pixelRedo').click();await pixelEditorFlush()");assert.equal(await evaluate("pixelEditor.layers.find(l=>l.kind==='text').text.x"),30);
  for(const theme of ['light','dark']) {
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};$('.pixel-editor-side').scrollTop=0`);await pause(100);await screenshot('text-'+theme+'.png');
    assert.equal(await evaluate("$('#pixelTextFont').getBoundingClientRect().right<= $('.pixel-editor-side').getBoundingClientRect().right"),true);
    await evaluate("$('#pixelTextStroke').scrollIntoView({block:'center'})");await pause(100);await screenshot('text-parameters-'+theme+'.png');
    assert.equal(await evaluate("$('#pixelTextStroke').getBoundingClientRect().right<= $('.pixel-editor-side').getBoundingClientRect().right"),true);
    await evaluate("$('.pixel-editor-side').scrollTop=0");
  }
  await call('Emulation.setDeviceMetricsOverride',{width:1024,height:768,deviceScaleFactor:1,mobile:false});await pause(100);await screenshot('text-1024.png');
  assert.equal(await evaluate("$('.pixel-editor-card').getBoundingClientRect().right<=innerWidth"),true);
  await call('Emulation.setDeviceMetricsOverride',{width:1360,height:900,deviceScaleFactor:1,mobile:false});
  await evaluate("$('#pixelTextSize').value='';$('#pixelTextSize').dispatchEvent(new Event('input'))");assert.equal(await evaluate("$('#pixelTextApply').disabled"),true);
  await evaluate("$('#pixelTextSize').value='25';$('#pixelTextSize').dispatchEvent(new Event('input'));document.dispatchEvent(new KeyboardEvent('keydown',{key:'s',code:'KeyS',ctrlKey:true,bubbles:true,cancelable:true}))");
  await waitFor("!pixelEditorApplying&&!spriteLabTextUI.hasDraft()&&Boolean(state.frameDocuments[0])");
  assert.equal(await evaluate("pixelEditor.layers.find(l=>l.kind==='text').text.size"),25);
  const record=await evaluate('state.frameDocuments[0]'),composite=await evaluate('Array.from(pixelEditor.composite)');
  const decoded=await sharp(record.imagePath).ensureAlpha().raw().toBuffer();assert.deepEqual([...decoded],composite);
  const rawDoc=JSON.parse(await fs.readFile(record.path,'utf8'));assert.equal(rawDoc.layers.find(l=>l.kind==='text').text.text,firstText.text);
  await evaluate('await pixelEditorClose();await pixelEditorOpen()');assert.equal(await evaluate("pixelEditor.layers.find(l=>l.kind==='text').text.text"),firstText.text);
  await evaluate("$('#pixelTextRasterize').click();await pixelEditorFlush()");assert.equal(await evaluate("pixelEditor.layers.some(l=>l.kind==='text')"),false);
  await evaluate("$('#pixelUndo').click();await pixelEditorFlush()");assert.equal(await evaluate("pixelEditor.layers.some(l=>l.kind==='text')"),true);
  await evaluate('await pixelEditorClose()');
  const projectDir=path.join(output,'project-original');await fs.mkdir(projectDir,{recursive:true});const projectPath=path.join(projectDir,'text.cslab');
  await evaluate(`spriteLab.saveProject({projectPath:${JSON.stringify(projectPath)},project:buildProjectDocument()})`);
  const moved=path.join(output,'project-moved');await fs.cp(projectDir,moved,{recursive:true});
  await evaluate(`(async()=>{const result=await spriteLab.loadProjectPath(${JSON.stringify(path.join(moved,'text.cslab'))});await applyProjectDocument(result.project,result.source,result.projectPath);window.startImageEditing();await pixelEditorOpen();})()`);
  assert.equal(await evaluate("pixelEditor.layers.find(l=>l.kind==='text').text.text"),firstText.text);
  assert.deepEqual(await evaluate('Array.from(pixelEditor.composite)'),composite);
  await evaluate("spriteLabTextUI.open();$('#pixelTextContent').value='Снова Ёж';$('#pixelTextContent').dispatchEvent(new Event('input'));void pixelEditorClose()");
  await waitFor("!$('#pixelClosePrompt').classList.contains('hidden')");await evaluate("$('#pixelCloseKeep').click()");assert.equal(await evaluate('pixelEditorIsOpen()'),true);
  await evaluate("void pixelEditorClose()");await waitFor("!$('#pixelClosePrompt').classList.contains('hidden')");await evaluate("$('#pixelCloseApply').click()");await waitFor('!pixelEditorIsOpen()');
  await evaluate('await pixelEditorOpen()');assert.equal(await evaluate("pixelEditor.layers.find(l=>l.kind==='text').text.text"),'Снова Ёж');
  const finalComposite=await evaluate('Array.from(pixelEditor.composite)');await evaluate('await pixelEditorClose()');
  const exported=await evaluate(`(async()=>{state.outputFolder=${JSON.stringify(path.join(output,'exported'))};return window.saveIndependentImages({all:true});})()`);
  assert.equal(exported.completed,1);assert.equal(exported.failed,0);const exportedRaw=await sharp(exported.results[0].imagePath).ensureAlpha().raw().toBuffer();assert.deepEqual([...exportedRaw],finalComposite);
  assert.equal(crypto.createHash('sha256').update(await fs.readFile(input)).digest('hex'),originalHash);assert.deepEqual(exceptions,[]);
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({ok:true,input,fonts:fonts.length,cyrillic:true,outline:true,spacingAndMultiline:true,positionUndoRedo:true,layerUndoRedo:true,multipleTextLayers:true,rasterizeUndo:true,ctrlSSavesPendingPreview:true,closeApply:true,portableProjectReopened:true,exportMatchesComposite:true,sourceUnchanged:true,exceptions},null,2));
  console.log(JSON.stringify({ok:true,output}));
} finally {socket?.close();child.kill();}
