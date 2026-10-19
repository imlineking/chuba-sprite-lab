// Isolated source-app acceptance. Dialog choices are supplied by this test driver,
// not by changes to the production preload or IPC permission surface.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import { processImageBatch } from '../src/image-batch.mjs';
const root = path.resolve(import.meta.dirname, '..'), output = path.resolve(process.argv[2] || '.diagnostics/parallax-2026-10-19');
await fs.mkdir(output, { recursive: true });
const inputs = [];
for (const [name, svg] of [
  ['mountains', '<path d="M0 300 180 80 320 250 440 100 640 300V360H0" fill="#697f91"/>'],
  ['forest', '<path d="m40 340 60-220 60 220m180 0 60-200 60 200m60 0 60-170 60 170" fill="#375941"/>'],
]) { const file = path.join(output, name + '.png'); await sharp(Buffer.from(`<svg width="640" height="360">${svg}</svg>`)).png().toFile(file); inputs.push(file); }
const real = 'C:/Users/User/Pictures/Chuba/chuba the game/new assets/branch_leaves_hanging_04.png';
try { await fs.access(real); inputs.push(real); } catch { /* Synthetic complete scene still verifies. */ }
const original = await Promise.all(inputs.map(file => fs.readFile(file)));
const rimPath = path.join(output, 'rim.png'), rgba = Buffer.alloc(50 * 40 * 4);
for (let y = 8; y < 32; y++) for (let x = 8; x < 42; x++) rgba.set(x === 8 || x === 41 || y === 8 || y === 31 ? [220, 220, 220, 255] : [20 + x, 85 + y, 25, 255], (y * 50 + x) * 4);
await sharp(rgba, { raw: { width: 50, height: 40, channels: 4 } }).png().toFile(rimPath);
const retryBatch = await processImageBatch({ paths: [rimPath], outputDir: path.join(output, 'retry-output'), outputKind: 'images', automatic: true, installed: ['toonout'],
  options: { keyMode: 'alpha', colorAdjust: { brightness: 0, contrast: 0, warmth: 0 }, edgeRefine: { mode: 'none', lightArtworkPolicy: 'auto' } }, appRoot: root,
  previewFrame: async () => ({ afterPath: rimPath, bounds: { left: 8, top: 8, width: 34, height: 24 } }) });
assert.equal(retryBatch.results[0]?.autoRetry?.accepted, true, 'Controlled first pass must trigger exactly one RGB-only retry');
const driver = path.join(output, 'driver.mjs');
await fs.writeFile(driver, `import {dialog} from 'electron';import fs from 'node:fs/promises';import path from 'node:path';dialog.showOpenDialog=async(_w,o)=>{const output=${JSON.stringify(output)};if(o.title==='Добавить слои сцены')return{canceled:false,filePaths:${JSON.stringify(inputs)}};if(o.title==='Папка для сцены и исходников')return{canceled:false,filePaths:[output]};if(o.title==='Открыть параллакс-сцену'){const dirs=(await fs.readdir(output)).filter(n=>n.startsWith('parallax-'));return{canceled:false,filePaths:[path.join(output,dirs.at(-1),'scene.parallax.json')]};}return{canceled:true,filePaths:[]};};await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/bootstrap.mjs')).href)});`);
const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [driver, '--ui-regression', `--remote-debugging-port=${port}`, '--self-test-user-data', path.join(output, 'profile')], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { void fs.appendFile(path.join(output, 'app.log'), b); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket, call, evaluate; const checks = [], exceptions = [];
try {
  let target; for (let i = 0; i < 300; i++) { try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.url.includes('index.html')); if (target) break; } catch {} await pause(100); }
  assert.ok(target, 'Application opened'); socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  let id = 0; const pending = new Map(); socket.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  call = (method, params = {}) => new Promise(resolve => { const n = ++id; pending.set(n, resolve); socket.send(JSON.stringify({ id: n, method, params })); });
  evaluate = async expression => { const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result.result?.value; };
  const wait = async expression => { for (let i = 0; i < 300; i++) { if (await evaluate(expression)) return; await pause(100); } throw new Error('Timeout ' + expression); };
  await call('Runtime.enable'); await call('Page.enable'); await call('Page.bringToFront'); await call('Emulation.setDeviceMetricsOverride', { width: 1360, height: 960, deviceScaleFactor: 1, mobile: false });
  await wait('typeof window.spriteLabParallax === "object"'); await evaluate('if(!$("#userNameModal").classList.contains("hidden"))$("#closeUserName").click();setLocale("ru",{persist:false})');
  await evaluate(`(async()=>{setSource(await spriteLab.restoreProject({source:{kind:'frames',paths:[${JSON.stringify(inputs[0])}]}}));setTab('source');document.querySelector('#sourcePanel [data-open-parallax]').click();})()`);
  await wait('document.querySelector("#parallaxModal").open');
  const project = await evaluate('JSON.stringify(state.source)'); await evaluate('$("#parallaxAdd").click()'); await wait(`spriteLabParallax.snapshot().scene.layers.length===${inputs.length}`); checks.push('Add actual PNGs through IPC; source project unchanged');
  const edit = async (field, value) => evaluate(`(()=>{const e=document.querySelector('[data-layer="${field}"]');e.value=${JSON.stringify(String(value))};e.dispatchEvent(new Event('change'));})()`);
  await edit('parallaxX', 1); await edit('scale', .45); await edit('anchorY', .5); await edit('y', -50);
  assert.equal(await evaluate('spriteLabParallax.snapshot().scene.layers.at(-1).parallaxX'), 1);
  await evaluate('$("#parallaxUndo").click()'); await wait('spriteLabParallax.snapshot().scene.layers.at(-1).y===0'); await evaluate('$("#parallaxRedo").click()'); await wait('spriteLabParallax.snapshot().scene.layers.at(-1).y===-50');
  await evaluate('$("#parallaxDuplicate").click()'); assert.equal(await evaluate('spriteLabParallax.snapshot().scene.layers.length'), inputs.length + 1); await evaluate('$("#parallaxDelete").click()');
  const lastId = await evaluate('spriteLabParallax.snapshot().scene.layers.at(-1).id');
  await evaluate(`document.querySelectorAll('#parallaxLayers button')[${inputs.length - 1}].click();$('#parallaxDelete').click()`);
  assert.equal(await evaluate('spriteLabParallax.snapshot().liveImages'), inputs.length - 1);
  await evaluate('$("#parallaxUndo").click()'); await wait(`spriteLabParallax.snapshot().liveImages===${inputs.length}`); assert.equal(await evaluate('spriteLabParallax.snapshot().scene.layers.at(-1).id'), lastId);
  checks.push('Layer fields, duplicate/delete, undo/redo and deleted-image release/reload');
  const p = await evaluate('(()=>{const r=$("#parallaxCanvas").getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()');
  for (const [type, dx, dy, buttons] of [['mousePressed', 0, 0, 1], ['mouseMoved', 60, 20, 1], ['mouseReleased', 60, 20, 0]]) await call('Input.dispatchMouseEvent', { type, x: p.x + dx, y: p.y + dy, button: 'left', buttons, clickCount: 1 });
  assert.ok(Math.abs(await evaluate('spriteLabParallax.snapshot().camera.x')) > 40); await evaluate('$("#parallaxPlay").click()'); await pause(220); assert.equal(await evaluate('spriteLabParallax.snapshot().playing'), true); await evaluate('$("#parallaxPlay").click();$("#parallaxResetCamera").click()'); checks.push('Real pointer camera drag and timed playback');
  const before = await evaluate('JSON.stringify(spriteLabParallax.snapshot().scene)'); await evaluate('$("#parallaxExport").click()'); await wait('$("#parallaxStatus").textContent.startsWith("Сохранено:")');
  await evaluate('$("#parallaxNew").click()'); assert.equal(await evaluate('spriteLabParallax.snapshot().scene.layers.length'), 0); await evaluate('$("#parallaxOpen").click()'); await wait(`spriteLabParallax.snapshot().scene.layers.length===${inputs.length}`); assert.equal(await evaluate('JSON.stringify(spriteLabParallax.snapshot().scene)'), before); checks.push('Scene export and reopen via real IPC; settings and layers survive');
  for (const width of [1360, 1024]) for (const theme of ['light', 'dark']) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: width === 1024 ? 768 : 900, deviceScaleFactor: 1, mobile: false }); await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`); await pause(100);
    assert.equal(await evaluate('$("#parallaxModal").scrollWidth <= $("#parallaxModal").clientWidth+1'), true);
    assert.equal(await evaluate('document.querySelector(".parallax-footer").getBoundingClientRect().bottom <= innerHeight'), true);
    const shot = await call('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(output, `scene-${width}-${theme}.png`), Buffer.from(shot.result.data, 'base64'));
  }
  for (let n = 0; n < 6; n++) { await evaluate('$("#parallaxPlay").click();$("#parallaxClose").click()'); assert.equal(await evaluate('spriteLabParallax.snapshot().raf'), 0); await evaluate('openParallaxSceneUI()'); }
  assert.equal(await evaluate('JSON.stringify(state.source)'), project); checks.push('Two themes and widths; six close/reopen cycles stop RAF; studio preserved');
  await evaluate('$("#parallaxClose").click()');
  await evaluate(`(async()=>{setSource(await spriteLab.restoreProject({source:{kind:'frames',paths:[${JSON.stringify(rimPath)}]}}));window.openImageBatchPreview({paths:[${JSON.stringify(rimPath)}],readyOnly:true,outputKind:'png',automatic:false});imageBatchDraft.results[0]=${JSON.stringify(retryBatch.results[0])};imageBatchDraft.settings[0]=collectOptions();renderImageBatchDraft();showImageBatchPair(0);})()`);
  const refinedPath = retryBatch.results[0].imagePath, firstPath = retryBatch.results[0].firstPassPath;
  assert.equal(await evaluate('$("#imageBatchUseFirstPass").hidden'), false);
  await evaluate('$("#imageBatchUseFirstPass").click()'); assert.equal(await evaluate('imageBatchDraft.results[0].imagePath'), firstPath);
  assert.equal(await evaluate('imageBatchDraft.results[0].changeReport.changed'), 0);
  await evaluate('$("#imageBatchUseFirstPass").click()'); assert.equal(await evaluate('imageBatchDraft.results[0].imagePath'), refinedPath);
  await evaluate('$("#imageBatchUseFirstPass").click();$("#applyImageBatch").click()'); await wait(`state.frameOverrides[0]===${JSON.stringify(firstPath)}`);
  assert.deepEqual(await sharp(firstPath).raw().toBuffer(), rgba);
  const saved = await evaluate(`spriteLab.build({source:{kind:'frames',paths:[state.frameOverrides[0]]},previewOnly:true,name:'retry-choice',options:{...collectOptions(),keyMode:'alpha',edgeRefine:{mode:'none'},aiEdits:[],pixelate:null,toning:null,padding:0,anchor:'original',preserveFrameCanvas:true,exports:{sheet:true,metadata:true,frames:true,preview:false}}})`);
  assert.deepEqual(await sharp(saved.framePaths[0]).ensureAlpha().raw().toBuffer(), rgba); checks.push('Batch RGB retry: choose first/refined/first, apply and exported RGBA matches selected original candidate');
  const dirs = (await fs.readdir(output)).filter(n => n.startsWith('parallax-')), html = pathToFileURL(path.join(output, dirs.at(-1), 'preview.html')).href;
  await call('Page.navigate', { url: html }); await wait('document.querySelector("#scene")!==null && document.querySelector("canvas").width===960'); await pause(300);
  assert.equal(await evaluate('document.querySelector("canvas").getContext("2d").getImageData(0,0,1,1).data[3]'), 255);
  await evaluate('document.querySelector("#play").click()'); await pause(150); assert.equal(await evaluate('document.querySelector("#play").textContent'), 'Пауза'); await evaluate('document.querySelector("#reset").click()'); checks.push('Standalone classic HTML loads from file URL without modules/server and plays');
  for (const [i, file] of inputs.entries()) assert.deepEqual(await fs.readFile(file), original[i]); assert.deepEqual(exceptions, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ ok: true, checks, exceptions, realAsset: inputs.includes(real), exportedDirectory: path.join(output, dirs.at(-1)) }, null, 2)); console.log(JSON.stringify({ ok: true, checks }));
} catch (error) { if (call) { const shot = await call('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(output, 'failure.png'), Buffer.from(shot.result.data, 'base64')); } throw error; }
finally { if (socket?.readyState === WebSocket.OPEN) { try { await evaluate('window.spriteLabPrepareEditorClose=()=>true;window.spriteLabHasUnsavedChanges=()=>false;window.spriteLab?.close?.()'); } catch {} socket.close(); } child.kill(); }
