// Source Electron only; real algorithmic review and explicit human feedback in an isolated profile.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import { labelledReviews } from '../src/critic/review-data.mjs';

const root = path.resolve(import.meta.dirname, '..'), output = path.resolve(process.argv[2] || '.diagnostics/audit-2026-10-21/critic-ui');
await fs.mkdir(output, { recursive: true });
const fixtureDir = path.join(output, 'inputs'); await fs.mkdir(fixtureDir, { recursive: true });
const fixture = path.join(fixtureDir, 'leaf.png');
await sharp({ create: { width: 48, height: 48, channels: 4, background: { r: 45, g: 100, b: 60, alpha: .8 } } }).png().toFile(fixture);
const original = await fs.readFile(fixture), preferences = path.join(output, 'web-preferences.json');
const profile = path.join(output, 'profile'), driver = path.join(output, 'driver.mjs');
// Reset only this harness's previous synthetic labels, never a real user's database.
await fs.rm(path.join(profile, 'review.sqlite'), { force: true });
await fs.writeFile(driver, `import {app,dialog} from 'electron';import fs from 'node:fs';
app.on('web-contents-created',(_e,w)=>w.on('did-finish-load',()=>{if(w.getURL().includes('index.html'))fs.writeFileSync(${JSON.stringify(preferences)},JSON.stringify({sandbox:w.getLastWebPreferences().sandbox}));}));
dialog.showOpenDialog=async()=>({canceled:true,filePaths:[]});
await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/bootstrap.mjs')).href)});`);
await fs.writeFile(path.join(output, 'package.json'), JSON.stringify({ name: 'sprite-lab-ui-audit', version: JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version, main: 'driver.mjs' }));
const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const selected = server.address().port; server.close(() => resolve(selected)); }); });
const app = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [output, '--ui-regression', `--remote-debugging-port=${port}`, '--self-test-user-data', profile], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
for (const stream of [app.stdout, app.stderr]) stream.on('data', chunk => { void fs.appendFile(path.join(output, 'app.log'), chunk); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const exceptions = [], checks = []; let socket, evaluate, call;
try {
  let target;
  for (let i = 0; i < 300; i++) { try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.url.includes('index.html')); if (target) break; } catch {} await pause(100); }
  assert.ok(target, 'Source app opened');
  socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  let sequence = 0; const pending = new Map();
  socket.addEventListener('message', event => { const item = JSON.parse(event.data); if (item.method === 'Runtime.exceptionThrown') exceptions.push(item.params.exceptionDetails.exception?.description || item.params.exceptionDetails.text); if (pending.has(item.id)) { pending.get(item.id)(item); pending.delete(item.id); } });
  call = (method, params = {}) => new Promise(resolve => { const id = ++sequence; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); });
  evaluate = async expression => { const item = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (item.result.exceptionDetails) throw new Error(item.result.exceptionDetails.exception?.description || item.result.exceptionDetails.text); return item.result.result?.value; };
  const wait = async expression => { for (let i = 0; i < 300; i++) { if (await evaluate(expression)) return; await pause(100); } throw new Error('Timeout: ' + expression); };
  const screenshot = async name => { await pause(80); const result = await call('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(output, name), Buffer.from(result.result.data, 'base64')); };
  await call('Runtime.enable'); await wait("Boolean(window.spriteLab?.criticFeedback) && typeof setLocale==='function' && Boolean(window.userProfileReady)");
  for (let i = 0; i < 100; i++) { try { await fs.access(preferences); break; } catch {} await pause(50); }
  assert.equal(JSON.parse(await fs.readFile(preferences)).sandbox, true);
  assert.equal(await evaluate("typeof window.spriteLab.criticFeedback==='function' && typeof require==='undefined'"), true);
  await evaluate('(async()=>{await window.userProfileReady;if(!document.getElementById("userNameModal").classList.contains("hidden"))document.getElementById("skipUserName").click()})()');
  await wait('document.getElementById("userNameModal").classList.contains("hidden")');
  await evaluate("setLocale('ru',{persist:false})");
  await pause(250);
  assert.equal(await evaluate("document.getElementById('criticStatus')===null && !('criticStatus' in window.spriteLab) && !('compareCopilots' in window.spriteLab)"), true);
  checks.push('Real sandboxed preload, no Node integration, removed model status and planner endpoints');
  const layout = [];
  const config = { name: 'audit-fixture', input: [fixtureDir], output: path.join(output, 'atlas'), formats: ['phaser-hash'], background: 'none' };
  await evaluate(`(async()=>{window.auditResult=await window.spriteLab.criticReview({config:${JSON.stringify(config)},useModel:false});window.auditDialog=window.renderReviewPanel(window.auditResult);window.auditDialog.showModal();})()`);
  assert.equal(await evaluate("window.auditResult.review.mode==='light' && !Array.isArray(window.auditResult.review.metrics) && Boolean(window.auditResult.review.feedbackToken)"), true);
  assert.equal(await evaluate("document.querySelector('.review-feedback select').value"), '');
  await evaluate("document.querySelector('.review-feedback').open=true;document.querySelector('.review-feedback button').click()");
  await wait("document.querySelector('.review-feedback [role=status]').textContent.length>0");
  assert.equal((await labelledReviews(path.join(profile, 'review.sqlite'))).length, 0, 'No default/pseudo human label');
  await evaluate("(()=>{const f=document.querySelector('.review-feedback');f.querySelector('select').value='accepted';f.querySelector('textarea').value='QA-only synthetic fixture assessment';f.querySelector('button').click()})()");
  await wait("document.querySelector('.review-feedback [role=status]').textContent.includes('сохранена')");
  assert.equal((await labelledReviews(path.join(profile, 'review.sqlite'))).length, 1);
  await screenshot('human-assessment-ru.png');
  await evaluate('window.auditDialog.scrollTop=window.auditDialog.scrollHeight'); await screenshot('human-assessment-ru-bottom.png');
  await evaluate('window.auditDialog.scrollTop=0');
  await evaluate("setLocale('en',{persist:false})"); await screenshot('human-assessment-en.png');
  assert.equal(await evaluate("/[А-Яа-яЁё]/.test(window.auditDialog.textContent)"), false, 'Review UI is fully translated');
  await evaluate('window.auditDialog.scrollTop=window.auditDialog.scrollHeight'); await screenshot('human-assessment-en-bottom.png');
  await evaluate("setLocale('ru',{persist:false})");
  await evaluate(`(async()=>await window.spriteLab.criticReview({config:${JSON.stringify(config)},useModel:false}))()`);
  await evaluate("document.querySelector('.review-feedback button').click()");
  await wait("document.querySelector('.review-feedback [role=status]').textContent.includes('изменился')");
  assert.equal((await labelledReviews(path.join(profile, 'review.sqlite'))).length, 1);
  assert.deepEqual(await fs.readFile(fixture), original);
  checks.push('Real atlas build/export, object metrics rendered, explicit SQLite human assessment; stale form blocked; fixture unchanged');
  assert.deepEqual(exceptions, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ ok: true, checks, layout, exceptions, sandbox: true, sourceUnchanged: true,
    limitations: ['One QA-only synthetic label lives in the isolated test profile; it is not a user-labelled golden dataset.'] }, null, 2));
  console.log(JSON.stringify({ ok: true, output, checks }));
} finally {
  socket?.close();
  const { execFile } = await import('node:child_process');
  if (app.pid) await new Promise(resolve => execFile('taskkill', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
}
