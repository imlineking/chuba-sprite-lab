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
  let cleanupDecisions = null;
  if (!process.argv[4]) {
    await evaluate("$('#closeMaskEditor').click()");
    const corpus = path.resolve(root, "../background-removal-lab/evidence/grok-matte-task-01/inputs");
    const group = ["layer-cut-sunflower-bouquet (3).png", "layer-clump-of-grass (3).png", "flowers_white_daisy_01.png"].map(name => path.join(corpus, name));
    const originalGroupHashes = await Promise.all(group.map(async file => crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex")));
    await evaluate(`(async()=>{setSource(await spriteLab.restoreProject({source:{kind:'frames',paths:${JSON.stringify(group)}}}));window.startImageEditing();initializeHistory('Palette review');window.openImageBatchPreview();})()`);
    const waitFor = async expression => {
      for (let i = 0; i < 500; i++) { if (await evaluate(expression)) return; await pause(100); }
      throw new Error(`Timeout: ${expression}`);
    };
    await waitFor("!state.busy && Object.keys(imageBatchDraft.results).length===3");
    const paletteTargets = await evaluate("imageBatchDraft.paths.map((p,i)=>({p,i})).filter(x=>/clump-of-grass|sunflower/.test(x.p)).map(x=>x.i)");
    const protectedIndex = await evaluate("imageBatchDraft.paths.findIndex(p=>p.endsWith('flowers_white_daisy_01.png'))");
    assert.deepEqual(await evaluate("batchPaletteCandidates()"), paletteTargets);
    assert.deepEqual(await evaluate("[...$('#imageBatchModel').options].map(o=>o.value)"), ["", "toonout", "birefnet-tiny"]);
    const cataloguePreview = await evaluate(`imageBatchDraft.results[${protectedIndex}].imagePath`);
    await evaluate("$('#imageBatchOtherModels').click()");
    assert.ok(await evaluate("$('#imageBatchModel').options.length>3"));
    await evaluate("$('#imageBatchOtherModels').click()");
    assert.equal(await evaluate(`imageBatchDraft.results[${protectedIndex}].imagePath`), cataloguePreview, "Expanding the catalogue reprocessed images");
    const protectedPath = await evaluate(`imageBatchDraft.results[${protectedIndex}].imagePath`);
    await screenshot("palette-suggestion.png");
    await evaluate("$('#imageBatchConfirmNoLight').click()");
    await waitFor("$('#imageBatchCleanupConfirm').open");
    assert.equal(await evaluate("$('#imageBatchCleanupConfirmFiles').children.length"), 2);
    await screenshot("palette-confirm-light.png");
    await evaluate("$('#imageBatchCleanupConfirmCancel').click()");
    await pause(100);
    assert.equal(await evaluate(`Boolean(imageBatchDraft.cleanupChoices?.[${paletteTargets[0]}])`), false);
    assert.equal(await evaluate(`imageBatchDraft.results[${paletteTargets[0]}].changeReport.changed`), 0);
    await evaluate("$('#imageBatchConfirmNoLight').click()");
    await waitFor("$('#imageBatchCleanupConfirm').open");
    await evaluate("document.documentElement.dataset.theme='dark'");
    await screenshot("palette-confirm-dark.png");
    await evaluate("$('#imageBatchCleanupConfirmAccept').click()");
    await waitFor(`!state.busy && ${JSON.stringify(paletteTargets)}.every(i=>imageBatchDraft.results[i].changeReport.changed>0)`);
    assert.equal(await evaluate(`imageBatchDraft.results[${protectedIndex}].imagePath`), protectedPath, "Confirmation reprocessed the protected white flower");
    const paletteChanges = await evaluate(`${JSON.stringify(paletteTargets)}.map(i=>imageBatchDraft.results[i].changeReport.changed)`);
    await screenshot("palette-cleaned.png");
    await evaluate("$('#applyImageBatch').click()");
    await waitFor("$('#imageBatchModal').classList.contains('hidden')");
    assert.equal(await evaluate("Object.keys(state.frameOverrides).length"), 3);
    await evaluate("undoWorkspace()");
    assert.equal(await evaluate("Object.keys(state.frameOverrides).length"), 0);

    const colors = [];
    for (let i = 0; i < 2; i++) {
      const pixels = Buffer.alloc(64 * 48 * 4);
      for (let at = 0; at < pixels.length; at += 4) pixels.set([210, 30, 170, 255], at);
      for (let y = 8; y < 40; y++) for (let x = 10; x < 54; x++) pixels.set([25, 90, 40, 255], (y * 64 + x) * 4);
      const file = path.join(output, `color-fixture-${i}.png`);
      await sharp(pixels, { raw: { width: 64, height: 48, channels: 4 } }).png().toFile(file); colors.push(file);
    }
    await evaluate(`(async()=>{setSource(await spriteLab.restoreProject({source:{kind:'frames',paths:${JSON.stringify(colors)}}}));window.startImageEditing();initializeHistory('Color removal');window.openImageBatchPreview({automatic:false,options:{keyMode:'alpha',edgeRefine:{mode:'none'}}});})()`);
    await waitFor("!state.busy && Object.keys(imageBatchDraft.results).length===2 && $('#imageBatchBefore').complete && $('#imageBatchBefore').naturalWidth===64");
    await evaluate("$('#imageBatchReviewScale').value='original';$('#imageBatchReviewScale').dispatchEvent(new Event('change'));document.querySelector('.batch-color-removal').open=true;$('#imageBatchColorPipette').click()");
    const point = await evaluate("(()=>{const e=$('#imageBatchBefore'),r=e.getBoundingClientRect(),s=Math.min(r.width/64,r.height/48);return {x:r.left+(r.width-64*s)/2+1.5*s,y:r.top+(r.height-48*s)/2+1.5*s};})()");
    await call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
    await call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
    assert.equal(await evaluate("$('#imageBatchRemoveColor').value"), "#d21eaa", "Pipette sampled the backdrop rather than the source pixel");
    await evaluate("$('#imageBatchReviewScale').value='zoom-4';$('#imageBatchReviewScale').dispatchEvent(new Event('change'));$('#imageBatchColorPipette').click()");
    const zoomPoint = await evaluate("(()=>{const r=$('#imageBatchBeforeGamePreview').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()");
    await call("Input.dispatchMouseEvent", { type: "mousePressed", ...zoomPoint, button: "left", clickCount: 1 });
    await call("Input.dispatchMouseEvent", { type: "mouseReleased", ...zoomPoint, button: "left", clickCount: 1 });
    assert.equal(await evaluate("$('#imageBatchRemoveColor').value"), "#195a28", "Zoomed pipette chose the wrong source pixel");
    await evaluate("$('#imageBatchReviewScale').value='original';$('#imageBatchReviewScale').dispatchEvent(new Event('change'));$('#imageBatchRemoveColor').value='#d21eaa';$('#imageBatchRemoveColor').dispatchEvent(new Event('input'))");
    await evaluate("$('#imageBatchScope').value='selected';imageBatchDraft.selected=[1];renderImageBatchDraft();$('#imageBatchRemovePickedColor').click()");
    await waitFor("$('#imageBatchCleanupConfirm').open");
    assert.equal(await evaluate("$('#imageBatchCleanupConfirmFiles').children.length"), 1);
    await screenshot("color-confirm-selected.png");
    await evaluate("$('#imageBatchCleanupConfirmCancel').click()"); await pause(100);
    assert.equal(await evaluate("Boolean(imageBatchDraft.cleanupChoices?.[1]?.colors?.length)"), false);
    await evaluate("$('#imageBatchRemovePickedColor').click()"); await waitFor("$('#imageBatchCleanupConfirm').open");
    await evaluate("$('#imageBatchCleanupConfirmAccept').click()");
    await waitFor("!state.busy && imageBatchDraft.results[1].changeReport.changed>0");
    assert.equal(await evaluate("imageBatchDraft.results[0].changeReport.changed"), 0);
    await evaluate("$('#imageBatchScope').value='all';renderImageBatchDraft();$('#imageBatchRemovePickedColor').click()");
    await waitFor("$('#imageBatchCleanupConfirm').open");
    assert.equal(await evaluate("$('#imageBatchCleanupConfirmFiles').children.length"), 2);
    await evaluate("$('#imageBatchCleanupConfirmAccept').click()");
    await waitFor("!state.busy && imageBatchDraft.results[0].changeReport.changed>0");
    assert.equal(await evaluate("imageBatchDraft.cleanupChoices[1].colors.length"), 1, "The same selected colour was added twice");
    await screenshot("color-group-cleaned.png");
    await evaluate("showImageBatchPair(1);$('#imageBatchScope').value='current';renderImageBatchDraft();$('#imageBatchRemovePickedColor').click()");
    await waitFor("$('#imageBatchCleanupConfirm').open");
    assert.equal(await evaluate("$('#imageBatchCleanupConfirmFiles').innerText"), path.basename(colors[1]), "Current mode targets a different previewed file");
    await evaluate("$('#imageBatchCleanupConfirmCancel').click()");
    for (const [i, file] of group.entries()) assert.equal(crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex"), originalGroupHashes[i]);
    cleanupDecisions = { paletteChanges, protectedFlowerNotReprocessed: true, cancelledWithoutChanges: true, sourcePipette: true, selectedOnly: true, groupColorRemoval: true, groupUndo: true };
  }
  assert.deepEqual(exceptions, []);
  const report = { executable, originalHash, initial, layoutChecks, manual, cleanupDecisions, saved: saved.results[0].imagePath, savedPixelsMatch: true, originalUnchanged: true, exceptions };
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  socket?.close();
  if (child.exitCode === null) {
    if (process.platform === "win32") await new Promise(resolve => execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => resolve()));
    else child.kill();
  }
}
