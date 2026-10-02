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
  await evaluate(`(async()=>{setSource(await spriteLab.restoreProject({source:{kind:'frames',paths:[${JSON.stringify(input)}]}}));window.startImageEditing();setTab('process');})()`);
  await pause(450);
  await screenshot("image-actions.png");
  await evaluate("$('#imageAutoCleanup').click()");
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await evaluate("!state.busy && Boolean(imageBatchDraft?.results?.[0])")) break;
    await pause(100);
  }
  const initial = await evaluate("({modal:!$('#imageBatchModal').classList.contains('hidden'), report:imageBatchDraft?.results?.[0]?.cleanupReport, changed:imageBatchDraft?.results?.[0]?.changeReport?.changed, healingButton:!$('#imageBatchTasks button[data-batch-task=healing]').disabled, text:$('#imageBatchList').innerText})");
  assert.ok(initial.modal && initial.changed > 0 && initial.report?.removed > 0, JSON.stringify(initial));
  await screenshot("cleanup.png");
  const layoutChecks = [];
  for (const [width, height] of [[1360, 900], [1280, 720], [1024, 768]]) {
    await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    for (const theme of ["light", "dark"]) {
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      await pause(100);
      const layout = await evaluate("(()=>{const arts=[...document.querySelectorAll('#imageBatchComparison .batch-preview-art')].map(e=>e.getBoundingClientRect().height);const footer=document.querySelector('.batch-preview-footer').getBoundingClientRect();return {arts,footerBottom:footer.bottom,viewport:innerHeight};})()");
      assert.ok(layout.arts.every(value => value >= 110), `Превью скрыто: ${JSON.stringify({width,height,theme,layout})}`);
      assert.ok(layout.footerBottom <= layout.viewport, "Кнопки применения вышли за окно");
      layoutChecks.push({ width, height, theme, ...layout });
      await screenshot(`cleanup-${width}-${height}-${theme}.png`);
    }
  }
  await call("Emulation.setDeviceMetricsOverride", { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate("document.documentElement.dataset.theme='light'");
  await evaluate("$('#imageBatchReviewScale').value='zoom-4';$('#imageBatchReviewScale').dispatchEvent(new Event('change'));$('#imageBatchReviewBackdrop').value='black';$('#imageBatchReviewBackdrop').dispatchEvent(new Event('change'))");
  const inputMetadata = await sharp(input).metadata();
  assert.equal(await evaluate("$('#imageBatchGamePreview').style.width"), `${inputMetadata.width * 4}px`);
  await screenshot("cleanup-zoom-black.png");
  await evaluate("$('#imageBatchBrightness').value='12';$('#imageBatchBrightness').dispatchEvent(new Event('input',{bubbles:true}))");
  assert.equal(await evaluate("$('#applyImageBatch').disabled"), true, "Изменённые настройки требуют обновить просмотр");
  await evaluate("$('#prepareImageBatch').click()");
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await evaluate("!state.busy && Boolean(imageBatchDraft?.results?.[0])")) break;
    await pause(100);
  }
  assert.ok(await evaluate("imageBatchDraft.results[0].changeReport.changed > 0"));
  await screenshot("color-adjusted.png");
  await evaluate("$('#imageBatchTasks button[data-batch-task=healing]').click()");
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await evaluate("!state.busy && Boolean(imageBatchDraft?.results?.[0])")) break;
    await pause(100);
  }
  assert.ok(await evaluate("Boolean(imageBatchDraft.results[0].healingPath) && !$('#imageBatchHealingFigure').classList.contains('hidden')"));
  await screenshot("healing-route.png");
  await evaluate("$('#applyImageBatch').click()");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate("$('#imageBatchModal').classList.contains('hidden')")) break;
    await pause(100);
  }
  assert.equal(await evaluate("Object.keys(state.frameOverrides).length"), 1, "Применение не заменило кадр в проекте");
  const appliedPath = await evaluate("state.frameOverrides[0]?.path || state.frameOverrides[0]");
  const saved = await evaluate(`(async()=>{state.outputFolder=${JSON.stringify(path.join(output, "saved-png"))};return window.saveIndependentImages({all:true});})()`);
  assert.equal(saved?.completed, 1, "Сохранение PNG не завершилось");
  assert.equal(saved.failed, 0);
  const appliedPixels = await sharp(appliedPath).ensureAlpha().raw().toBuffer();
  const savedPixels = await sharp(saved.results[0].imagePath).ensureAlpha().raw().toBuffer();
  assert.deepEqual(savedPixels, appliedPixels, "Сохранённый PNG отличается от применённого результата");
  assert.equal(crypto.createHash("sha256").update(await fs.readFile(input)).digest("hex"), originalHash, "Изменён исходный файл");
  await evaluate("undoWorkspace()");
  assert.equal(await evaluate("Object.keys(state.frameOverrides).length"), 0, "Ctrl+Z не вернул исходник");
  await evaluate("$('#openPixelEditor').click()");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate("!$('#pixelEditorModal').classList.contains('hidden')")) break;
    await pause(100);
  }
  const manual = await evaluate("({open:!$('#pixelEditorModal').classList.contains('hidden'),min:$('#pixelBrushSize').min,shape:$('#pixelBrushShape').value,warmth:!!$('#pixelAdjust-warmth')})");
  assert.deepEqual(manual, { open: true, min: "1", shape: "square", warmth: true });
  await pause(200);
  await screenshot("pixel-editor.png");
  await evaluate("$('#closePixelEditor').click()");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate("$('#pixelEditorModal').classList.contains('hidden')")) break;
    await pause(100);
  }
  await evaluate("$('#regionEditImage').click()");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate("!$('#aiMaskModal').classList.contains('hidden')")) break;
    await pause(100);
  }
  assert.equal(await evaluate("$('#maskBrushSize').min"), "1");
  await evaluate("setMaskTool('erase');$('#maskBrushSize').value='1';$('#maskBrushSize').dispatchEvent(new Event('input'));$('#maskBrushShape').value='square'");
  await screenshot("mask-pixel-brush.png");
  assert.deepEqual(exceptions, []);
  const report = { executable, originalHash, initial, layoutChecks, manual, saved: saved.results[0].imagePath, savedPixelsMatch: true, originalUnchanged: true, exceptions };
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  socket?.close();
  if (child.exitCode === null) {
    if (process.platform === "win32") await new Promise(resolve => execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => resolve()));
    else child.kill();
  }
}
