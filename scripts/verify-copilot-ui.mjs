// Source UI test; never builds an EXE. Uses Chromium's own DevTools protocol.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(process.argv[2] || ".diagnostics/copilot-ui");
const sheet = path.resolve(process.argv[3] || path.join(root, "../../public/images/monya-dream/props/yarn-ball-roll-and-guide-6-frame-review.png"));
await fs.mkdir(output, { recursive: true });
const child = spawn(path.join(root, "node_modules/electron/dist/electron.exe"), [".", "--ui-regression", "--remote-debugging-port=19395", "--self-test-user-data", path.join(output, `profile-${Date.now()}`)], { cwd: root, windowsHide: true, stdio: "ignore" });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const clients = [];
const errors = [];
const report = { ok: false, checks: [] };
async function connect(surface) {
  let target;
  for (let i = 0; i < 80; i++) {
    try { target = (await (await fetch("http://127.0.0.1:19395/json/list")).json()).find(item => item.type === "page" && item.url.includes(surface)); if (target) break; } catch { /* starting */ }
    await pause(200);
  }
  assert.ok(target, `Missing surface ${surface}`);
  const socket = new WebSocket(target.webSocketDebuggerUrl); clients.push(socket);
  await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
  const pending = new Map(); let next = 0;
  socket.addEventListener("message", event => {
    const value = JSON.parse(event.data);
    if (value.method === "Runtime.exceptionThrown") errors.push(value.params.exceptionDetails.text + ": " + value.params.exceptionDetails.exception?.description);
    if (pending.has(value.id)) { pending.get(value.id)(value); pending.delete(value.id); }
  });
  const call = (method, params = {}) => new Promise(resolve => { const id = ++next; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); });
  await call("Runtime.enable");
  const evaluate = async expression => {
    const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.exception?.description || result.result.exceptionDetails.text);
    return result.result.result?.value;
  };
  const screenshot = async name => { const result = await call("Page.captureScreenshot", { format: "png" }); await fs.writeFile(path.join(output, name), Buffer.from(result.result.data, "base64")); };
  return { evaluate, screenshot, call };
}
try {
  const main = await connect("index.html"); const bubble = await connect("surface=bubble"); const pet = await connect("surface=pet");
  await main.evaluate(`(async () => { const source = await window.spriteLab.resliceSheet({ sheetPath: ${JSON.stringify(sheet)}, options: { mode: 'objects' } }); setSource(source); state.intent='animation'; $('#autoSize').checked=true; $('#pixelPerfect').checked=true; $('#fps').value='8'; setAnchor('body'); window.taskChoose('animation','manual'); await runBuild(true); initializeHistory('Контрольное состояние'); setTab('process'); return state.result.frameCount; })()`);
  assert.equal(await main.evaluate("state.result.frameCount"), 6);
  const before = await main.evaluate("({fps:$('#fps').value,packing:$('#atlasPacking').value,index:state.historyIndex,key:state.result.sheetPath})");
  await main.evaluate("applyCopilotSuggestion({id:'ui-atomic',title:'Проверка атомарной правки',steps:[{op:'option',control:'fps',value:12},{op:'option',control:'atlasPacking',value:'tight'},{op:'rebuild'}]})");
  const after = await main.evaluate("({fps:$('#fps').value,packing:$('#atlasPacking').value,index:state.historyIndex})");
  assert.equal(after.fps, "12"); assert.equal(after.packing, "tight"); assert.equal(after.index, before.index + 1);
  await main.evaluate("document.activeElement?.blur()");
  await main.call("Input.dispatchKeyEvent", { type: "keyDown", key: "z", code: "KeyZ", modifiers: 2 });
  await main.call("Input.dispatchKeyEvent", { type: "keyUp", key: "z", code: "KeyZ", modifiers: 2 });
  const undo = await main.evaluate("({fps:$('#fps').value,packing:$('#atlasPacking').value,index:state.historyIndex,key:state.result.sheetPath})");
  assert.deepEqual(undo, before); report.checks.push({ name: "one-Ctrl-Z-restores-settings-and-preview", ok: true });
  await main.evaluate("redoWorkspace()");
  assert.equal(await main.evaluate("$('#fps').value"), "12");
  await main.evaluate("window.spriteLab.onCompanionCommand; copilotState.lastAdvice.index=state.historyIndex; renderCopilot()");
  await bubble.evaluate("desktopCompanion.action({action:'command',command:{kind:'undo-advice',id:'undo'}})");
  await pause(200); assert.equal(await main.evaluate("$('#fps').value"), before.fps);
  report.checks.push({ name: "desktop-bubble-undo", ok: true });
  const autoUndo = await main.evaluate(`(() => {
    const read = () => ({controls:captureControlState(), masks:JSON.stringify(state.maskEdits),index:state.historyIndex});
    const before=read();
    autoPilotState.plan={steps:[{stage:'key',tool:'alpha'},{stage:'fringe'},{stage:'checker'}]};
    autoPilotApply();
    const after=read();
    undoWorkspace();
    return {before,after,undo:read()};
  })()`);
  assert.equal(autoUndo.after.index, autoUndo.before.index + 1);
  assert.notEqual(autoUndo.after.masks, autoUndo.before.masks);
  assert.deepEqual(autoUndo.undo, autoUndo.before);
  report.checks.push({ name: "automatic-multi-tool-plan-one-undo", ok: true });
  await main.evaluate("applyCopilotSuggestion({id:'invalid',title:'Неверный план',steps:[{op:'option',control:'fps',value:14},{op:'unknownTool'}]})");
  assert.equal(await main.evaluate("$('#fps').value"), before.fps);
  await pause(900); assert.ok(await bubble.evaluate("document.body.innerText.includes('Неизвестный инструмент')"));
  report.checks.push({ name: "invalid-plan-keeps-workspace-and-visible-error", ok: true });
  await bubble.screenshot("copilot-error.png");
  await main.evaluate("copilotState.errorOrigin=null; refreshCopilot(); setCopilotPanel(true)");
  await pause(500);
  assert.ok(await bubble.evaluate("!!document.querySelector('.planner-control select')"));
  const petDrag = await pet.evaluate("(async()=>{ await desktopCompanion.action({action:'drag-start',x:200,y:200}); await desktopCompanion.action({action:'drag-move',x:250,y:240}); await desktopCompanion.action({action:'drag-end'}); return document.querySelector('#pet img').draggable; })()");
  assert.equal(petDrag, false); report.checks.push({ name: "separate-desktop-pet-and-planner-selector", ok: true });
  for (const theme of ["light", "dark"]) {
    await main.evaluate(`document.documentElement.dataset.theme='${theme}'; if(!state.guides) $('#toggleGuides').click(); $('#gridSpacing').value='50'; updateGuideGrid(); drawPlayer();`);
    await pause(300); await main.screenshot(`${theme}-yarn.png`); await bubble.screenshot(`${theme}-copilot.png`);
  }
  await main.evaluate("compareCopilotPlanners()");
  assert.equal(await main.evaluate("document.querySelectorAll('.planner-results article').length"), 3);
  await main.screenshot("planner-comparison.png"); report.checks.push({ name: "real-three-planner-comparison-dialog", ok: true });
  report.runtimeErrors = errors; assert.deepEqual(errors, []);
  report.ok = true;
} finally {
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  clients.forEach(socket => socket.close()); child.kill();
}
console.log(JSON.stringify(report));
