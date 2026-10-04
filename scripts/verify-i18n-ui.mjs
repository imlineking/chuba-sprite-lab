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
let socket;let companionSocket;
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



  await evaluate('setLocale("en",{persist:false})');await pause(300);
  const staticMissing=await evaluate(`(()=>{const out=[];for(const node of i18nTextNodes(document.body)){const text=node.textContent.trim();if(/[А-Яа-яЁё]/.test(text)&&text!=="Русский")out.push(text);}for(const element of document.querySelectorAll('*')){if(i18nSkipped(element))continue;for(const key of i18nAttributes){const value=element.getAttribute(key);if(value&&/[А-Яа-яЁё]/.test(value)&&value!=="Русский")out.push(value);}}return [...new Set(out)];})()`);
  await fs.writeFile(path.join(output,'missing.json'),JSON.stringify(staticMissing,null,2));
  const fixture=path.join(output,'tile.png');await sharp({create:{width:32,height:32,channels:4,background:{r:70,g:140,b:50,alpha:1}}}).png().toFile(fixture);
  await evaluate('(async()=>{setSource(await spriteLab.restoreProject({source:{kind:"frames",paths:['+JSON.stringify(fixture)+']}}));await pixelEditorOpen();})()');
  await evaluate(`const user=document.createElement('span');user.id='qaUserData';user.setAttribute('data-i18n-skip','');user.textContent='Источник';document.body.append(user);$('#pixelTextContent').value='Мой цветок — Ёж';`);
  const snapshots=[];
  for(const width of [1360,1024])for(const theme of ['light','dark']){
    await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    await evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme)+';$("#pixelTextDetails").open=true;$("#pixelTextDetails").scrollIntoView({block:"center"});document.getAnimations().forEach(a=>a.finish())');await pause(650);await screenshot('editor-en-'+theme+'-'+width+'.png');
    snapshots.push(await evaluate(`(()=>{const rect=$('#pixelEditorModal .pixel-dialog')?.getBoundingClientRect()||$('#pixelEditorModal').getBoundingClientRect();return {width:innerWidth,theme:document.documentElement.dataset.theme,left:rect.left,right:rect.right,overflow:document.documentElement.scrollWidth>innerWidth,language:document.documentElement.lang};})()`));
  }
  await evaluate('showError("Слой заблокирован.");$("#pixelUndo").title="Отменить (Ctrl+Z)"');await pause(200);
  assert.equal(await evaluate('$("#errorText").textContent'),'Layer locked.');assert.equal(await evaluate('$("#pixelUndo").title'),'Undo (Ctrl+Z)');
  assert.equal(await evaluate('$("#pixelTextContent").value'),'Мой цветок — Ёж');assert.equal(await evaluate('$("#qaUserData").textContent'),'Источник');
  await evaluate('setLocale("ru",{persist:false})');await pause(200);assert.equal(await evaluate('$("#pixelUndo").title'),'Отменить (Ctrl+Z)');assert.equal(await evaluate('$("#errorText").textContent'),'Слой заблокирован.');
  await evaluate('await pixelEditorClose();document.documentElement.dataset.theme="light";setLocale("en",{persist:false});setTab("export");$("#exportFormat").value="three";$("#exportFormat").dispatchEvent(new Event("change"));$("#gpuFormat").scrollIntoView({block:"center"});document.getAnimations().forEach(a=>a.finish())');await pause(650);await screenshot('export-en-light-1024.png');
  await evaluate('await spriteLab.showCompanion({open:true});await spriteLab.updateCompanion({locale:"en",theme:"light",loading:false,busy:false,greeting:"Привет, Дмитрий! Давай начнём работу.",error:"Слой заблокирован.",scenarios:[{task:"cutout",title:"Вырезать объект",why:"Проверьте контуры и размеры выбранного изображения перед экспортом."}],tasks:[]});');await pause(400);
  const companionTarget=(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item=>item.url.includes('surface=bubble'));
  assert.ok(companionTarget,'Desktop assistant bubble available');companionSocket=new WebSocket(companionTarget.webSocketDebuggerUrl);await new Promise(resolve=>companionSocket.addEventListener('open',resolve,{once:true}));
  let companionId=0;const companionPending=new Map();companionSocket.addEventListener('message',event=>{const response=JSON.parse(event.data);if(companionPending.has(response.id)){companionPending.get(response.id)(response);companionPending.delete(response.id);}});
  const companionCall=(method,params={})=>new Promise(resolve=>{const id=++companionId;companionPending.set(id,resolve);companionSocket.send(JSON.stringify({id,method,params}));});
  const companionEval=async expression=>{const response=await companionCall('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(response.result.exceptionDetails)throw new Error(response.result.exceptionDetails.text);return response.result.result.value;};
  const bubble=await companionEval('({lang:document.documentElement.lang,body:document.body.innerText,title:document.getElementById("hide").title,width:innerWidth})');
  await fs.writeFile(path.join(output,'assistant.json'),JSON.stringify(bubble,null,2));
  assert.equal(bubble.lang,'en');assert.equal(bubble.title,'Hide assistant');assert.ok(bubble.body.includes('Hello, Дмитрий!'));assert.ok(bubble.body.includes('Layer locked.'));assert.ok(bubble.body.includes('Cut out object'));assert.ok(!/[А-Яа-яЁё]/.test(bubble.body.replace('Дмитрий','')),'Assistant labels translated');
  for(const theme of ['light','dark']){await companionEval('document.documentElement.dataset.theme='+JSON.stringify(theme));await pause(150);const shot=await companionCall('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(output,'assistant-en-'+theme+'.png'),Buffer.from(shot.result.data,'base64'));}
  await evaluate('setLocale("ru",{persist:false})');await pause(200);assert.equal(await companionEval('document.documentElement.lang'),'ru');assert.equal(await companionEval('document.getElementById("hide").title'),'Скрыть помощника');
  const userPixels=await evaluate('Array.from(pixelEditor.composite||[])');
  assert.deepEqual(exceptions,[]);assert.equal(crypto.createHash('sha256').update(await fs.readFile(input)).digest('hex'),originalHash);
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({ok:staticMissing.length===0,missing:staticMissing,snapshots,reversible:true,dynamicTitles:true,dynamicErrors:true,userTextUnchanged:true,sourceUnchanged:true,exceptions,companionEnglish:true,companionSwitchBack:true,companion:bubble,userPixels:userPixels.length},null,2));assert.deepEqual(staticMissing,[]);assert.ok(snapshots.every(item=>!item.overflow));console.log(JSON.stringify({output,missing:staticMissing.length,snapshots}));

} finally {socket?.close();companionSocket?.close();child.kill();}
