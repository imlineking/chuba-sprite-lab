// Inspect the source UI in isolated profiles, without packaging an EXE.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
const root = path.resolve(import.meta.dirname, "..");
const output = path.resolve(process.argv[2]);
const game = path.resolve(process.argv[3] || path.join(root, "../.."));
await fs.mkdir(output, { recursive: true });
const profileDirectory=path.join(output, `profile-${Date.now()}`);
const start=()=>spawn(path.join(root, "node_modules/electron/dist/electron.exe"), [".", "--ui-regression", "--remote-debugging-port=19396", "--self-test-user-data", profileDirectory], { cwd: root, windowsHide: true, stdio: "ignore" });
let child = start();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { views: [], runtimeErrors: [] };
let socket;
try {
  let target;
  for (let i = 0; i < 80; i++) {
    try { target = (await (await fetch("http://127.0.0.1:19396/json/list")).json()).find(item => item.url.includes("index.html")); if (target) break; } catch { /* starting */ }
    await pause(200);
  }
  assert.ok(target, "Missing source window");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
  const pending = new Map(); let next = 0;
  const handleMessage = event => {
    const item = JSON.parse(event.data);
    if (item.method === "Runtime.exceptionThrown") report.runtimeErrors.push(item.params.exceptionDetails.exception?.description || item.params.exceptionDetails.text);
    if (pending.has(item.id)) { pending.get(item.id)(item); pending.delete(item.id); }
  };
  socket.addEventListener("message",handleMessage);
  const call = (method, params = {}) => new Promise(resolve => { const id = ++next; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); });
  await call("Runtime.enable");
  const evaluate = async expression => {
    const response = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.exception?.description);
    return response.result.result?.value;
  };
  for (let i = 0; i < 80; i++) {
    if (await evaluate("typeof setTab==='function' && typeof window.taskChoose==='function'")) break;
    await pause(200);
  }
  assert.ok(await evaluate("typeof window.taskChoose==='function'"), "UI scripts did not finish loading");
  await evaluate("window.userProfileReady");
  assert.ok(await evaluate("!$('#userNameModal').classList.contains('hidden')"),"First launch did not introduce the copilot");
  report.firstRunShown=true;
  // Keep the first-run dialog in evidence, then complete it in this disposable profile.
  const onboarding=await call("Page.captureScreenshot",{format:"png"});
  await fs.writeFile(path.join(output,"first-run.png"),Buffer.from(onboarding.result.data,"base64"));
  await evaluate("$('#closeUserName').click()");
  for(let i=0;i<40;i++){if(await evaluate("$('#userNameModal').classList.contains('hidden')"))break;await pause(100);}
  const skipped=await evaluate("spriteLab.getUserProfile()");
  assert.ok(skipped.onboardingCompleted);assert.equal(skipped.name,"");assert.equal(skipped.effectiveName,skipped.accountName);
  await evaluate("openUserPreferences();");
  for(let i=0;i<40;i++){if(await evaluate("!$('#userNameModal').classList.contains('hidden')"))break;await pause(100);}
  await evaluate("$('#userNameInput').value='Дмитрий'; $('#userNameForm').requestSubmit()");
  for(let i=0;i<40;i++){if(await evaluate("$('#userNameModal').classList.contains('hidden')"))break;await pause(100);}
  const named=await evaluate("spriteLab.getUserProfile()");assert.equal(named.effectiveName,"Дмитрий");
  await evaluate("openUserPreferences()");assert.equal(await evaluate("$('#userNameInput').value"),"Дмитрий");
  await evaluate("$('#userNameInput').value='Несохранённое'; $('#closeUserName').click()");
  assert.equal((await evaluate("spriteLab.getUserProfile()")).name,"Дмитрий");
  report.nameSettingsSavedAndCancelPreserves=true;
  const inspect = async name => {
    await pause(260);
    const layout = await evaluate(`(() => {
      const visible = node => node.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
      const rect = node => { const r=node.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right}; };
      const buttons=[...document.querySelectorAll('button')].filter(visible);
      const clipped=buttons.filter(b=>b.scrollWidth>b.clientWidth+2 || b.scrollHeight>b.clientHeight+2).map(b=>({id:b.id,text:b.innerText,rect:rect(b),scroll:[b.scrollWidth,b.scrollHeight],client:[b.clientWidth,b.clientHeight]}));
      const unnamed=buttons.filter(b=>!b.innerText.trim()&&!b.getAttribute('aria-label')&&!b.title).map(b=>b.id||b.className);
      const modals=[...document.querySelectorAll('.modal-backdrop:not(.hidden)>article,dialog[open]')].filter(visible).map(b=>({id:b.id||b.parentElement.id,rect:rect(b)}));
      const inactivePanelsVisible=[...document.querySelectorAll('.panel:not(.active)')].filter(visible).map(b=>b.dataset.panel);
      const imageActions=[...document.querySelectorAll('.image-only')].filter(visible).map(b=>b.id);
      return {size:[innerWidth,innerHeight],clipped,unnamed,modals,inactivePanelsVisible,imageActions,intent:document.body.dataset.intent,bodyOverflow:document.body.scrollWidth>innerWidth+2};
    })()`);
    const image = await call("Page.captureScreenshot", { format: "png" });
    await fs.writeFile(path.join(output, `${name}.png`), Buffer.from(image.result.data, "base64"));
    report.views.push({ name, ...layout });
  };
  for (const width of [1000,1360]) {
    await call("Emulation.setDeviceMetricsOverride", { width, height: width===1000?720:900, deviceScaleFactor:1, mobile:false });
    for (const theme of ["light","dark"]) {
      await evaluate(`document.documentElement.dataset.theme='${theme}'`);
      for (const tab of ["source","process","export"]) { await evaluate(`setTab('${tab}')`); await inspect(`empty-${theme}-${width}-${tab}`); }
    }
  }
  const paths = ["new assets/branch_leaves_hanging_01.png","new assets/flower_white.png","new assets/branch_leaves_hanging_09.png"].map(file=>path.join(game,file));
  await evaluate(`(async()=>{ setSource(await spriteLab.restoreProject({source:{kind:'frames',paths:${JSON.stringify(paths)}}})); window.taskRestore('edit'); initializeHistory('UI audit'); })()`);
  for (const width of [1000,1360]) {
    await call("Emulation.setDeviceMetricsOverride", { width, height: width===1000?720:900, deviceScaleFactor:1, mobile:false });
    for (const theme of ["light","dark"]) {
      await evaluate(`document.documentElement.dataset.theme='${theme}'; setTab('source')`);
      await inspect(`images-${theme}-${width}`);
      await evaluate("openMaskEditor({tool:'select'})"); await inspect(`mask-${theme}-${width}`); await evaluate("$('#cancelMaskEditor').click()");
      await evaluate("openAbout()"); await inspect(`about-${theme}-${width}`); await evaluate("closeAbout()");
      await evaluate("autoPilotOpenModels()"); await inspect(`models-${theme}-${width}`); await evaluate("autoPilotCloseModels()");
      await evaluate("openFrameEditor()"); await inspect(`frame-editor-${theme}-${width}`); await evaluate("closeFrameEditor()");
      await evaluate("openUserPreferences()");await inspect(`settings-${theme}-${width}`);await evaluate("$('#closeUserName').click()");
    }
  }
  const yarn = path.join(game, "public/images/monya-dream/props/yarn-ball-roll-and-guide-6-frame-review.png");
  await evaluate(`(async()=>{setSource(await spriteLab.resliceSheet({sheetPath:${JSON.stringify(yarn)},options:{mode:'objects'}})); window.taskChoose('animation','manual'); setAnchor('body'); $('#autoSize').checked=true; $('#pixelPerfect').checked=true; await runBuild(true);})()`);
  for (const width of [1000,1360]) {
    await call("Emulation.setDeviceMetricsOverride", { width, height:width===1000?720:900, deviceScaleFactor:1, mobile:false });
    for (const theme of ["light","dark"]) {
      await evaluate(`document.documentElement.dataset.theme='${theme}'; setTab('process'); if(!state.guides) $('#toggleGuides').click(); $('#gridSpacing').value='50'; updateGuideGrid(); drawPlayer()`);
      await inspect(`yarn-${theme}-${width}`);
    }
  }
  const editedSource=await evaluate(`(()=>{const original=autoPilotSourcePaths()[0];state.frameOverrides[0]=${JSON.stringify(paths[1])};const edited=autoPilotSourcePaths()[0];delete state.frameOverrides[0];return {original,edited};})()`);
  assert.equal(editedSource.edited,paths[1]); assert.notEqual(editedSource.original,editedSource.edited);
  report.editedSourceAnalyzed=true;
  assert.ok(report.views.every(view=>view.inactivePanelsVisible.length===0),"An inactive tab's panel remains visible");
  assert.ok(report.views.filter(view=>view.intent!=="images").every(view=>view.imageActions.length===0),"Image-only buttons leaked into animation mode");
  assert.deepEqual(report.runtimeErrors,[]);
  socket.close();child.kill();await pause(1000);
  child=start();let restarted;
  for(let i=0;i<80;i++) {
    try {restarted=(await(await fetch("http://127.0.0.1:19396/json/list")).json()).find(item=>item.url.includes("index.html")&&item.id!==target.id);if(restarted)break;}catch{/* restarting */}
    await pause(200);
  }
  assert.ok(restarted,"Source app did not restart");
  socket=new WebSocket(restarted.webSocketDebuggerUrl);
  await new Promise(resolve=>socket.addEventListener("open",resolve,{once:true}));socket.addEventListener("message",handleMessage);await call("Runtime.enable");
  for(let i=0;i<80;i++){if(await evaluate("!!window.userProfileReady"))break;await pause(200);}
  await evaluate("window.userProfileReady");
  assert.equal((await evaluate("spriteLab.getUserProfile()")).name,"Дмитрий");
  assert.ok(await evaluate("$('#userNameModal').classList.contains('hidden')"),"Onboarding appeared again after restart");
  report.nameSurvivesAppRestart=true;
  await evaluate("openUserPreferences()");await inspect("name-saved-after-restart");
  report.ok = true;
} finally {
  await fs.writeFile(path.join(output,"report.json"),JSON.stringify(report,null,2));
  socket?.close(); child.kill();
}
console.log(JSON.stringify({ok:report.ok,views:report.views.length,issues:report.views.filter(view=>view.clipped.length||view.unnamed.length||view.bodyOverflow),runtimeErrors:report.runtimeErrors}));
