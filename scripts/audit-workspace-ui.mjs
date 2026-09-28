// Inspect the source UI in isolated profiles, without packaging an EXE.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import net from "node:net";
import sharp from "sharp";
const root = path.resolve(import.meta.dirname, "..");
const output = path.resolve(process.argv[2]);
const game = path.resolve(process.argv[3] || path.join(root, "../.."));
await fs.mkdir(output, { recursive: true });
const profileDirectory=path.join(output, `profile-${Date.now()}`);
const freePort=()=>new Promise((resolve,reject)=>{const server=net.createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value));});});
let port=await freePort();
const start=()=>{
  const launched=spawn(path.join(root, "node_modules/electron/dist/electron.exe"), [".", "--ui-regression", `--remote-debugging-port=${port}`, "--self-test-user-data", profileDirectory], { cwd: root, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  for(const stream of [launched.stdout,launched.stderr])stream.on('data',chunk=>fs.appendFile(path.join(output,'audit-process.log'),chunk).catch(()=>{}));
  launched.on('exit',(code,signal)=>{void fs.appendFile(path.join(output,'audit-process.log'),`\nExit ${code} ${signal||''}\n`);});
  return launched;
};
let child = start();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function stopAuditApp() {
  if(child.exitCode!==null)return;
  if(process.platform==='win32') await new Promise(resolve=>execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true},()=>resolve()));
  else child.kill();
  await pause(500);
}
const report = { views: [], runtimeErrors: [] };
let socket;
try {
  let target;
  for (let i = 0; i < 80; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.url.includes("index.html")); if (target) break; } catch { /* starting */ }
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
    if (await evaluate("typeof setTab==='function' && typeof window.taskChoose==='function' && !!window.userProfileReady")) break;
    await pause(200);
  }
  assert.ok(await evaluate("typeof window.taskChoose==='function' && !!window.userProfileReady"), "UI scripts did not finish loading");
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
      return {cssViewport:document.documentElement.clientWidth,media:matchMedia("(max-width: 1240px)").matches,header:rect(document.querySelector(".preview-header")),headerWrap:getComputedStyle(document.querySelector(".preview-header")).flexWrap,size:[innerWidth,innerHeight],clipped,unnamed,modals,inactivePanelsVisible,imageActions,intent:document.body.dataset.intent,overflowing: [...document.querySelectorAll("body > *, .titlebar > *, .preview-header > *, .preview-group")].filter(visible).filter(n => n.getBoundingClientRect().right > innerWidth + 2).map(n => ({className:n.className, id:n.id,rect:rect(n)})),bodyOverflow:document.body.scrollWidth>innerWidth+2};
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
  for (const width of [1000,1360]) for (const theme of ["light","dark"]) {
    await call("Emulation.setDeviceMetricsOverride", { width, height: width===1000?720:900, deviceScaleFactor:1, mobile:false });
    await evaluate(`document.documentElement.dataset.theme='${theme}'; setTab('process'); $('#pixelatePanel').open=true; $('#pixelatePalette').value='custom'; syncCustomPaletteField(); $('#pixelatePanel').scrollIntoView()`);
    assert.ok(await evaluate("!$('#pixelateCustomPaletteField').classList.contains('hidden')"));
    assert.equal(await evaluate("$('#pixelateCustomPalettePreview').children.length"),2);
    assert.equal(await evaluate("$('#pixelateColors').disabled"),true);
    await inspect(`custom-palette-${theme}-${width}`);
    await evaluate("$('#pixelateCustomColors').value='#abc'; $('#pixelateCustomColors').dispatchEvent(new Event('input'))");
    assert.equal(await evaluate("$('#pixelateCustomColors').validity.valid"),false);
    await evaluate("$('#pixelateCustomColors').value='#1a1c2c, #f4f4f4'; $('#pixelatePalette').value='auto'; syncCustomPaletteField()");
    assert.equal(await evaluate("$('#pixelateColors').disabled"),false);
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
      await evaluate("pixelEditorOpen()"); await inspect(`pixel-palette-${theme}-${width}`);
      assert.ok(await evaluate("pixelEditor.palette.some(color=>color[0]!==color[1]||color[1]!==color[2])"),"Palette lost the asset's colors");
      await evaluate("pixelEditorChooseFrameColor([255,255,255,255]); $('#pixelColorHex').value='#437bd9'; $('#pixelColorHex').dispatchEvent(new Event('input',{bubbles:true}))");
      await inspect(`pixel-color-${theme}-${width}`);
      assert.ok(await evaluate("pixelEditor.preview && pixelEditor.preview.some((value,index)=>value!==pixelEditor.composite[index])"),"Color picker did not preview the replacement");
      await evaluate("pixelEditorCancelPreview(); $('#pixelAdjustDetails').open=true"); await inspect(`pixel-adjust-${theme}-${width}`);
      await evaluate("pixelEditorCancelPreview(); pixelEditorClose()");
      await evaluate("openFeedback()"); await inspect(`feedback-${theme}-${width}`); await evaluate("closeFeedback()");
      await evaluate("openCommandPalette()"); await inspect(`commands-${theme}-${width}`); await evaluate("closeCommandPalette()");
      await evaluate(`openAttachmentEditor({path:${JSON.stringify(paths[1])},url:${JSON.stringify('file:///'+paths[1].replaceAll('\\','/').split('/').map(encodeURIComponent).join('/'))},title:'Белые цветы · длинное название для проверки окна'})`);
      await inspect(`attachment-${theme}-${width}`); await evaluate("closeAttachmentEditor()");
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
  // DPI/zoom transitions on an already open dialog, in both approved themes.
  for (const theme of ["light", "dark"]) for (const scale of [1, 1.25, 1.5, 2]) {
    await call("Emulation.setDeviceMetricsOverride", { width: Math.max(960,Math.round(1920/scale)), height: Math.max(640,Math.round(1080/scale)), deviceScaleFactor: scale, mobile:false });
    await evaluate(`(async()=>{document.documentElement.dataset.theme='${theme}';await pixelEditorOpen();pixelEditorChooseFrameColor([255,255,255,255]);})()`);
    await inspect(`dpi-${theme}-${scale*100}`);
    await evaluate("pixelEditorCancelPreview();pixelEditorClose()");
  }
  await call("Emulation.setDeviceMetricsOverride", { width: 1000, height: 720, deviceScaleFactor:1, mobile:false });
  await evaluate(`(async()=>{setSource(await spriteLab.restoreProject({source:{kind:'frames',paths:${JSON.stringify(paths)}}})); window.taskRestore('edit'); initializeHistory('Batch audit'); window.openImageBatchPreview();})()`);
  await inspect("batch-before-processing");
  assert.equal(await evaluate("Object.keys(state.frameOverrides).length"),0);
  await evaluate("$('#imageBatchScope').value='current'; renderImageBatchDraft(); prepareImageBatch()");
  assert.equal(await evaluate("Object.keys(state.frameOverrides).length"),0,"Preview changed the workspace before Apply");
  await inspect("batch-ready-current");
  assert.ok(await evaluate("imageBatchDraft.results[0].matteReview?.width > 0"), "Batch result lacks real RGBA review");
  await evaluate("$('#imageBatchReviewScale').value='64-2';$('#imageBatchReviewScale').dispatchEvent(new Event('change'));$('#imageBatchReviewBackdrop').value='black';$('#imageBatchReviewBackdrop').dispatchEvent(new Event('change'))");
  for (let attempt=0; attempt<20; attempt++) { if (await evaluate("$('#imageBatchGamePreview').width===64")) break; await pause(100); }
  assert.equal(await evaluate("$('#imageBatchGamePreview').width"),64);
  assert.equal(await evaluate("$('#imageBatchBeforeGamePreview').width"),64);
  assert.equal(await evaluate("$('#imageBatchBeforeGamePreview').classList.contains('hidden')"),false);
  assert.equal(await evaluate("$('#imageBatchGamePreview').style.width"),"128px");
  assert.equal(await evaluate("$('#imageBatchComparison').dataset.reviewBackground"),"black");
  await inspect("batch-matte-game-size");
  await evaluate("$('#imageBatchReviewScale').value='original';$('#imageBatchReviewScale').dispatchEvent(new Event('change'));$('#imageBatchReviewBackdrop').value='magenta-gray';$('#imageBatchReviewBackdrop').dispatchEvent(new Event('change'))");
  assert.ok(await evaluate("$('#imageBatchGamePreview').classList.contains('hidden')"));
  assert.ok(await evaluate("$('#imageBatchBeforeGamePreview').classList.contains('hidden')"));
  await inspect("batch-matte-original");
  await evaluate("document.documentElement.dataset.theme='light'");
  await inspect("batch-matte-light");
  await evaluate("document.documentElement.dataset.theme='dark'");
  assert.equal(await evaluate("$('#applyImageBatch').disabled"),false);
  await evaluate("$('#applyImageBatch').click()"); await pause(500);
  assert.equal(await evaluate("Object.keys(state.frameOverrides).length"),1);
  await evaluate("undoWorkspace()");
  assert.equal(await evaluate("Object.keys(state.frameOverrides).length"),0,"One undo did not restore the batch");
  await evaluate("redoWorkspace()");
  assert.equal(await evaluate("Object.keys(state.frameOverrides).length"),1);
  report.batchPreviewAndSingleUndo=true;
  await evaluate("openImageBatchPreview()");
  await call("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
  await call("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
  assert.equal(await evaluate("$('#imageBatchModal').classList.contains('hidden')"),true);
  const fixtures = path.join(output, 'batch-fixtures'); await fs.mkdir(fixtures,{recursive:true});
  const fixturePaths = [];
  const sprite = await sharp({create:{width:80,height:60,channels:4,background:'white'}}).composite([{input:Buffer.from('<svg width="80" height="60"><rect x="15" y="10" width="40" height="40" fill="#396c41"/></svg>')}]).png().toBuffer();
  for (let i=0;i<20;i++) { const file=path.join(fixtures, `asset-${String(i).padStart(2,'0')}.png`); await fs.writeFile(file,sprite); fixturePaths.push(file); }
  await evaluate(`(async()=>{setSource(await spriteLab.restoreProject({source:{kind:'frames',paths:${JSON.stringify(fixturePaths)}}}));window.taskRestore('edit');setKeyMode('white');initializeHistory('Batch failures');openImageBatchPreview();})()`);
  await fs.writeFile(fixturePaths[1],'deliberately damaged fixture');
  await evaluate("imageBatchDraft.selected=[0,1,2];$('#imageBatchScope').value='selected';renderImageBatchDraft();prepareImageBatch()");
  assert.equal(await evaluate("Object.keys(imageBatchDraft.results).length"),2);
  assert.equal(await evaluate("Object.keys(imageBatchDraft.failures).length"),1);
  assert.ok(await evaluate("$('#applyImageBatch').disabled"));
  await inspect('batch-file-failure');
  const successfulPath=await evaluate("imageBatchDraft.results[0].imagePath");
  await fs.writeFile(fixturePaths[1],sprite);
  await evaluate("prepareImageBatch('failed')");
  assert.equal(await evaluate("Object.keys(imageBatchDraft.failures).length"),0);
  assert.equal(await evaluate("imageBatchDraft.results[0].imagePath"),successfulPath,'Retry reprocessed a successful file');
  await evaluate("closeImageBatchPreview();imageBatchDraft=null;openImageBatchPreview()");
  assert.equal(await evaluate("Object.keys(imageBatchDraft.results).length"),3,'Saved draft did not recover');
  await evaluate("$('#imageBatchScope').value='all';renderImageBatchDraft();window.p0StopSubscription=spriteLab.onProgress(p=>{if(p.value>0){$('#cancelImageBatchJob').click();window.p0StopSubscription();}});prepareImageBatch('remaining')");
  const stopped=await evaluate("Object.keys(imageBatchDraft.results).length");
  assert.ok(stopped>=3 && stopped<20,'Cancel did not keep a partial resumable batch');
  assert.equal(await evaluate("Object.keys(state.frameOverrides).length"),0,'Cancel changed the workspace');
  await evaluate("prepareImageBatch('remaining')");
  assert.equal(await evaluate("Object.keys(imageBatchDraft.results).length"),20);
  assert.equal(await evaluate("imageBatchDraft.results[0].imagePath"),successfulPath);
  await evaluate("$('#applyImageBatch').click()");await pause(400);
  assert.equal(await evaluate("Object.keys(state.frameOverrides).length"),20);
  await evaluate("undoWorkspace()");assert.equal(await evaluate("Object.keys(state.frameOverrides).length"),0);
  report.batchFailureRetryCancelResumeRecovery=true;
  // The PNG + JSON route must also review cleanup before writing exports.
  const batchExports=path.join(output,'reviewed-atlases');
  await evaluate(`window.taskChoose('batch','manual');$('#batchImageProfile').value='color';$('#batchKeyColor').value='#ffffff';$('#batchKeyScope').value='exterior';$('#batchTolerance').value='1';state.outputFolder=${JSON.stringify(batchExports)};$('#taskPrimary').click()`);
  assert.equal(await evaluate("imageBatchDraft.configuration.exportAtlases"),true);
  await evaluate("imageBatchDraft.selected=[0,1,2];$('#imageBatchScope').value='selected';renderImageBatchDraft();prepareImageBatch()");
  assert.equal(await fs.stat(batchExports).then(()=>true,()=>false),false,'Atlases were written before approval');
  await inspect('batch-atlas-before-save');
  const damagedPreview=await evaluate("imageBatchDraft.results[1].imagePath");
  const previewBytes=await fs.readFile(damagedPreview);await fs.unlink(damagedPreview);
  await evaluate("exportReviewedImageAtlases(imageBatchIndexes())");
  assert.equal(await evaluate("Object.keys(imageBatchDraft.exported).length"),2);
  assert.equal(await evaluate("Object.keys(imageBatchDraft.exportFailures).length"),1);
  const exportedFirst=await evaluate("imageBatchDraft.exported[0].sheetPath");
  await inspect('batch-atlas-save-failure');
  await fs.writeFile(damagedPreview,previewBytes);
  await evaluate("exportReviewedImageAtlases(imageBatchIndexes())");
  assert.equal(await evaluate("imageBatchDraft.exported[0].sheetPath"),exportedFirst,'Save retry exported a successful file twice');
  assert.equal(await evaluate("Object.keys(imageBatchDraft.exported).length"),3);
  const atlasResults=await evaluate("Object.values(imageBatchDraft.exported)");
  for(const item of atlasResults) {
    const manifest=JSON.parse(await fs.readFile(item.manifestPath));
    const metadata=await sharp(item.sheetPath).metadata();
    assert.equal(manifest.image,path.basename(item.sheetPath));
    assert.equal(manifest.frames.length,item.frameCount);
    assert.ok(manifest.frames.every(frame=>frame.x+frame.width<=metadata.width && frame.y+frame.height<=metadata.height));
  }
  assert.equal(await evaluate("Object.keys(state.frameOverrides).length"),0,'Export changed original workspace files');
  report.atlasBatchPreviewAndSaveRetry=true;
  const oldProjectDir=path.join(output,'project-drive-a'),newProjectDir=path.join(output,'project-drive-b');
  await fs.mkdir(oldProjectDir,{recursive:true});
  const oldProject=path.join(oldProjectDir,'portable.cslab');
  await evaluate(`spriteLab.saveProject({projectPath:${JSON.stringify(oldProject)},project:buildProjectDocument()})`);
  const savedDisk=JSON.parse(await fs.readFile(oldProject));assert.ok(savedDisk.source.paths.every(file=>!path.isAbsolute(file)));
  await fs.rename(oldProjectDir,newProjectDir);await fs.rename(fixtures,fixtures+'-originals-unavailable');
  const movedProject=path.join(newProjectDir,'portable.cslab');
  await evaluate(`(async()=>{window.p0Loaded=await spriteLab.loadProjectPath(${JSON.stringify(movedProject)});setSource(window.p0Loaded.source);})()`);
  assert.equal(await evaluate("state.source.paths.length"),20);
  const external={...JSON.parse(await fs.readFile(movedProject)),note:'external update'};
  await fs.writeFile(movedProject,JSON.stringify(external));
  const conflict=await evaluate(`spriteLab.saveProject({projectPath:${JSON.stringify(movedProject)},project:window.p0Loaded.project}).then(()=>'',error=>error.message)`);
  assert.match(conflict,/другом окне/);assert.deepEqual(JSON.parse(await fs.readFile(movedProject)),external);
  report.portableProjectMovedAndConflictProtected=true;
  const editedSource=await evaluate(`(()=>{const original=autoPilotSourcePaths()[0];state.frameOverrides[0]=${JSON.stringify(paths[1])};const edited=autoPilotSourcePaths()[0];delete state.frameOverrides[0];return {original,edited};})()`);
  assert.equal(editedSource.edited,paths[1]); assert.notEqual(editedSource.original,editedSource.edited);
  report.editedSourceAnalyzed=true;
  assert.ok(report.views.every(view=>view.inactivePanelsVisible.length===0),"An inactive tab's panel remains visible");
  assert.ok(report.views.filter(view=>view.intent!=="images").every(view=>view.imageActions.length===0),"Image-only buttons leaked into animation mode");
  assert.deepEqual(report.runtimeErrors,[]);
  assert.ok(report.views.every(view=>view.clipped.length===0 && view.unnamed.length===0 && !view.bodyOverflow),"Clipped controls, unnamed buttons or horizontal overflow found");
  assert.ok(report.views.every(view=>view.modals.every(item=>item.rect.x>=-2 && item.rect.y>=-2 && item.rect.right<=view.size[0]+2 && item.rect.bottom<=view.size[1]+2)),"Dialog outside viewport");
  socket.close();await stopAuditApp();
  port=await freePort();
  child=start();let restarted;
  for(let i=0;i<150;i++) {
    try {restarted=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item=>item.url.includes("index.html")&&item.id!==target.id);if(restarted)break;}catch{/* restarting */}
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
  socket?.close(); await stopAuditApp();
}
console.log(JSON.stringify({ok:report.ok,views:report.views.length,issues:report.views.filter(view=>view.clipped.length||view.unnamed.length||view.bodyOverflow),runtimeErrors:report.runtimeErrors}));
