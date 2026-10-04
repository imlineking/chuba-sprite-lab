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



  const ase=await import('../src/aseprite-import.mjs'),descriptor=await import('../src/source-describe.mjs'),model=await import('../src/sprite-document.mjs');
  const official=[];for(const name of ['link','tags3','2f-index-3x3','point2frames','slices','z-order','groups3abc']){const file=path.join(root,'.diagnostics/ase-fixtures',name+'.aseprite'),image=ase.decodeAseprite(await fs.readFile(file));official.push({name,frames:image.frames.length,layers:image.frames[0].document.layers.length,tags:image.tags.length,slices:image.slices.length});}
  const source=await descriptor.describePaths(root,'frames',[input]);assert.ok(Object.keys(source.frameDocuments).length>0);
  await evaluate('(async()=>{setSource(await spriteLab.restoreProject({source:'+JSON.stringify(source)+'}));await pixelEditorOpen();})()');
  assert.equal(await evaluate('state.intent'),'animation');assert.equal(await evaluate('pixelEditor.frameIndices.length'),source.paths.length);
  const expected=ase.decodeAseprite(await fs.readFile(input));assert.equal(await evaluate('pixelEditor.layers.length'),expected.frames[0].document.layers.length);
  await evaluate('document.getAnimations().forEach(a=>a.finish())');await pause(500);await screenshot('aseprite-layers.png');
  await evaluate('await pixelEditorSave();await pixelEditorClose()');
  for(let i=0;i<source.paths.length;i++){const doc=await evaluate('state.frameDocuments['+i+']'),raw=await sharp(doc.imagePath).ensureAlpha().raw().toBuffer();assert.deepEqual(raw,expected.frames[i].pixels);const decoded=(await import('../src/editor-document.mjs')).decodeEditorDocument(JSON.parse(await fs.readFile(doc.path,'utf8')),{width:expected.width,height:expected.height});assert.deepEqual(Buffer.from(model.compositeFrame(decoded,0)),raw);}
  const project=await evaluate('buildProjectDocument()');
  const storage=await import('../src/project-storage.mjs'),projectPath=path.join(output,'aseprite.cslab');await storage.savePortableProject(projectPath,project);const {project:restored}=await storage.loadPortableProject(projectPath);assert.deepEqual(await storage.missingProjectFiles(restored),[]);
  await evaluate('(async()=>{const p='+JSON.stringify(restored)+';await applyProjectDocument(p,await spriteLab.restoreProject({source:p.source}));})()');await evaluate('await pixelEditorOpen()');assert.equal(await evaluate('pixelEditor.layers.length'),expected.frames[0].document.layers.length);await evaluate('await pixelEditorClose()');
  assert.deepEqual(exceptions,[]);assert.equal(crypto.createHash('sha256').update(await fs.readFile(input)).digest('hex'),originalHash);
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({ok:true,official,editableLayers:true,portableProject:true,sourceUnchanged:true,exceptions},null,2));console.log(JSON.stringify({ok:true,output}));
} finally {socket?.close();child.kill();}
