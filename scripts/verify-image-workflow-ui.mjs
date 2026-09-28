// Source-only end-to-end check of the three image actions. No EXE is built.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import net from "node:net";

const root = path.resolve(import.meta.dirname, "..");
const input = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
await fs.access(input); await fs.mkdir(output, { recursive: true });
const port = await new Promise((resolve, reject) => {
  const server = net.createServer(); server.on("error", reject);
  server.listen(0, "127.0.0.1", () => { const value = server.address().port; server.close(() => resolve(value)); });
});
const child = spawn(path.join(root, "node_modules/electron/dist/electron.exe"),
  [".", "--ui-regression", `--remote-debugging-port=${port}`, "--self-test-user-data", path.join(output, "profile")],
  { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { void fs.appendFile(path.join(output, "app.log"), chunk); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket;
try {
  let target;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.url.includes("index.html")); if (target) break; } catch { /* Starting. */ }
    await pause(200);
  }
  assert.ok(target, "Окно исходной версии не открылось");
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
  await evaluate("$('#imageBatchReviewScale').value='zoom-4';$('#imageBatchReviewScale').dispatchEvent(new Event('change'));$('#imageBatchReviewBackdrop').value='black';$('#imageBatchReviewBackdrop').dispatchEvent(new Event('change'))");
  assert.equal(await evaluate("$('#imageBatchGamePreview').style.width"), "596px");
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
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify({ initial, manual, exceptions }, null, 2));
  console.log(JSON.stringify({ initial, manual, exceptions }, null, 2));
} finally {
  socket?.close();
  if (child.exitCode === null) {
    if (process.platform === "win32") await new Promise(resolve => execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => resolve()));
    else child.kill();
  }
}
