// Verify the actual single-file EXE, with local fixture import through its IPC.
// File export/open dialogs are covered by verify-parallax-ui.mjs separately.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
const root = path.resolve(import.meta.dirname, '..'), executable = path.resolve(process.argv[2]), output = path.resolve(process.argv[3]);
await fs.mkdir(output, { recursive: true });
const fixture = path.join(output, 'layer.png'); await sharp({ create: { width: 80, height: 60, channels: 4, background: { r: 35, g: 110, b: 55, alpha: .8 } } }).png().toFile(fixture);
const original = await fs.readFile(fixture), expectedVersion = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
const child = spawn(executable, ['--ui-regression', `--remote-debugging-port=${port}`, '--self-test-user-data', path.join(output, 'profile')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { void fs.appendFile(path.join(output, 'app.log'), data); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket, evaluate, call; const exceptions = [], checks = [];
try {
  let target;
  for (let i = 0; i < 600; i++) { try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.url.includes('index.html')); if (target) break; } catch {} await pause(100); }
  assert.ok(target, 'EXE opens its own renderer');
  socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  let sequence = 0; const pending = new Map();
  socket.addEventListener('message', event => { const value = JSON.parse(event.data); if (value.method === 'Runtime.exceptionThrown') exceptions.push(value.params.exceptionDetails.exception?.description || value.params.exceptionDetails.text); if (pending.has(value.id)) { pending.get(value.id)(value); pending.delete(value.id); } });
  call = (method, params = {}) => new Promise(resolve => { const id = ++sequence; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); });
  evaluate = async expression => { const value = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (value.result.exceptionDetails) throw new Error(value.result.exceptionDetails.exception?.description || value.result.exceptionDetails.text); return value.result.result?.value; };
  const wait = async expression => { for (let i = 0; i < 300; i++) { if (await evaluate(expression)) return; await pause(100); } throw new Error('Timeout: ' + expression); };
  await call('Runtime.enable'); await call('Page.enable'); await call('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false });
  await wait('typeof spriteLabParallax === "object"'); await evaluate('if(!$("#userNameModal").classList.contains("hidden"))$("#closeUserName").click();setLocale("ru",{persist:false})');
  assert.equal(await evaluate('$("#versionBadge").textContent'), expectedVersion);
  await evaluate('document.querySelector("#conveyorView [data-open-parallax]").click()'); await wait('$("#parallaxModal").open');
  await evaluate(`spriteLabParallax.add([${JSON.stringify(fixture)}])`); assert.equal(await evaluate('spriteLabParallax.snapshot().scene.layers.length'), 1); checks.push('Version and parallax entry in packaged pipeline; PNG import via packaged IPC');
  await evaluate('(()=>{const input=document.querySelector("[data-layer=parallaxX]");input.value="1";input.dispatchEvent(new Event("change"));})()');
  await evaluate('$("#parallaxUndo").click()'); await wait('spriteLabParallax.snapshot().scene.layers[0].parallaxX===0.15');
  await evaluate('$("#parallaxRedo").click()'); await wait('spriteLabParallax.snapshot().scene.layers[0].parallaxX===1');
  await evaluate('$("#parallaxPlay").click()'); await pause(250); assert.ok(Math.abs(await evaluate('spriteLabParallax.snapshot().camera.x')) > 1);
  await evaluate('$("#parallaxClose").click()'); assert.equal(await evaluate('spriteLabParallax.snapshot().raf'), 0); checks.push('Editable scene, undo/redo, animated camera and RAF stop in actual EXE');
  await evaluate('openParallaxSceneUI()');
  for (const theme of ['light', 'dark']) { await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`); const shot = await call('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(output, `${theme}.png`), Buffer.from(shot.result.data, 'base64')); }
  assert.deepEqual(await fs.readFile(fixture), original); assert.deepEqual(exceptions, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ ok: true, version: expectedVersion, executable, rendererUrl: target.url, checks, sourceUnchanged: true, exceptions, exportDialogsCoveredBy: 'verify-parallax-ui.mjs' }, null, 2)); console.log(JSON.stringify({ ok: true, checks }));
} finally { if (socket?.readyState === WebSocket.OPEN) { try { await evaluate('window.spriteLabPrepareEditorClose=()=>true;window.spriteLabHasUnsavedChanges=()=>false;spriteLab.close()'); await pause(300); } catch {} socket.close(); } child.kill(); }
