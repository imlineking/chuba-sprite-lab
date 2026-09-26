(async()=>{
 await window.userProfileReady;
 if(!$('#userNameModal').classList.contains('hidden')){await spriteLab.saveUserProfile('Тест');setModalOpen($('#userNameModal'),false);}
 clearTimeout(state.sessionTimer);saveSessionSoon=()=>{};savePreferences=()=>{};
 const assert=(v,m)=>{if(!v)throw new Error(m);},pause=(ms=50)=>new Promise(r=>setTimeout(r,ms));
 const paths=window.spriteLabAuditPaths;
 setSource(await spriteLab.restoreProject({source:{kind:'frames',paths}}));window.startImageEditing();
 const info=await spriteLab.getAppInfo();assert($('#versionBadge').textContent===info.version&&$('#aboutVersion').textContent===info.version,'Visible version differs from runtime');if(window.spriteLabWorkflowVersion)assert(info.version===window.spriteLabWorkflowVersion,'Runtime version not updated');
 const checks=[];setLocale(window.spriteLabWorkflowLocale||'ru',{persist:false});spriteLabAppearance.choose(window.spriteLabWorkflowTheme||'dark');document.documentElement.dataset.shellMotion='off';
 await pixelEditorOpen();await pause();
 const original=pixelEditor.composite.slice(),source=pixelEditor.palette.find(c=>c[0]>c[1]*1.3&&c[1]>c[2]*1.3&&c[0]>50);
 const offset=window.SpriteLabPixelColors.matches(original,source).find(i=>original[i+3]===255);assert(offset!==undefined,'No opaque fixture colour');
 pixelEditorChooseFrameColor(source);$('#pixelColorHex').value='#1464e6';$('#pixelColorHex').dispatchEvent(new Event('input'));await pause();
 const h=state.history.length;
 assert(await pixelEditorSave(),'One-click preview apply failed');
 assert(pixelEditor.composite[offset]===20&&pixelEditor.composite[offset+1]===100&&pixelEditor.composite[offset+2]===230,'Preview was not committed');
 assert(state.history.length===h+1,'Apply should add one workspace operation');assert(!pixelEditorHasPendingEdits(),'Applied state marked dirty');
 assert(!state.resultDirty,'Independent image demands animation rebuild');
 assert([...$('#filmstrip').querySelectorAll('button')].every(b=>!b.draggable&&!b.title.includes('FPS')),'Independent images reverted to animation UI');
 assert(!$('#filmstripNote').textContent.includes('перетаскивайте'),'Wrong image filmstrip guidance');
 assert($('#filmstrip img').src.includes(encodeURIComponent(state.frameOverrides[0].split(/[\\/]/).at(-1))),'Thumbnail does not show applied override');checks.push('live preview → one-click apply → image workspace');
 const keepClose=window.spriteLabPrepareEditorClose;
 await pixelEditorSend({op:'undo'});assert(pixelEditorHasPendingEdits(),'Undo after apply must be dirty');
 let closing=keepClose();await pause();assert(!$('#pixelClosePrompt').classList.contains('hidden'),'Unapplied edit close guard missing');
 const foot=$('.pixel-editor-foot').getBoundingClientRect(),save=$('#pixelSaveFrame').getBoundingClientRect(),status=$('.pixel-editor-info').getBoundingClientRect();
 assert(save.top<$('#pixelClosePrompt').getBoundingClientRect().top&&save.left>status.right,'Close guard displaced footer action');
 assert(save.right<=foot.right-12,'Footer button lost inset');
 $('#pixelCloseKeep').click();assert(await closing===false&&pixelEditorIsOpen(),'Keep editing did not preserve session');
 await pixelEditorSend({op:'redo'});assert(!pixelEditorHasPendingEdits(),'Redo to applied state falsely dirty');assert(await pixelEditorClose(),'Clean close failed');checks.push('close guard / keep / undo / redo');
 await pixelEditorOpen();assert(pixelEditor.composite[offset]===20,'Applied frame not restored');
 pixelEditorChooseFrameColor([20,100,230,255]);$('#pixelColorHex').value='#ee44bb';$('#pixelColorHex').dispatchEvent(new Event('input'));await pause();
 const before=state.frameOverrides[0];$('#pixelColorHex').value='#zz';$('#pixelColorHex').dispatchEvent(new Event('input'));assert(await pixelEditorSave()===false&&state.frameOverrides[0]===before,'Invalid colour was applied');
 $('#pixelColorHex').value='#ee44bb';$('#pixelColorHex').dispatchEvent(new Event('input'));await pause();closing=pixelEditorClose();await pause();$('#pixelCloseDiscard').click();assert(await closing&&!pixelEditorIsOpen(),'Discard did not close');
 await pixelEditorOpen();assert(pixelEditor.composite[offset]===20,'Discard replaced applied image');checks.push('invalid colour / discard / restore');
 const wrap=$('#pixelCanvasWrap'),canvas=$('#pixelCanvas'),card=$('.pixel-editor-card');
 card.style.height='500px';await pause(120);assert(canvas.getBoundingClientRect().height<=wrap.clientHeight-22,'Fit does not track resized editor');
 pixelEditorSetZoom(2);card.style.height='640px';await pause(120);assert(pixelEditor.zoom===2,'Resize overwrote manual zoom');card.style.height='';$('#pixelZoomFit').click();await pause();checks.push('responsive fit / manual zoom');
 pixelEditorChooseFrameColor([20,100,230,255]);$('#pixelColorHex').value='#445566';$('#pixelColorHex').dispatchEvent(new Event('input'));await pause();closing=pixelEditorClose();await pause();$('#pixelCloseApply').click();assert(await closing&&!pixelEditorIsOpen(),'Apply and close failed');
 await pixelEditorOpen();assert(pixelEditor.composite[offset]===68&&pixelEditor.composite[offset+1]===85&&pixelEditor.composite[offset+2]===102,'Close did not apply preview');checks.push('apply and close / restore');
 $('#pixelAdjustDetails').open=true;await pause();$('#pixelAdjust-brightness').value='10';$('#pixelAdjust-brightness').dispatchEvent(new Event('input'));await pause();
 const graded=pixelEditor.preview[offset],realProjectSave=saveProjectFile;let wrongSave=0;saveProjectFile=async()=>{wrongSave++;return false;};
 try {
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'s',code:'KeyS',ctrlKey:true,bubbles:true,cancelable:true}));
  for(let i=0;i<80&&(pixelEditorApplying||pixelColorBusy);i++)await pause();
  assert(wrongSave===0,'Ctrl+S leaked into global project save');assert(pixelEditor.composite[offset]===graded&&!pixelEditorHasPendingEdits(),'Ctrl+S did not apply grading');
 }finally{saveProjectFile=realProjectSave;}
 document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',code:'KeyK',ctrlKey:true,bubbles:true,cancelable:true}));assert($('#commandModal').classList.contains('hidden'),'Global commands opened over editor');checks.push('modal Ctrl+S / grading apply / shortcut scope');
 if(window.spriteLabWorkflowOutput){
  await pixelEditorClose();state.outputFolder=window.spriteLabWorkflowOutput;
  const saved=await window.saveIndependentImages();assert(saved?.completed===1&&!saved.failed,'Edited PNG export failed');checks.push('independent PNG export');
 }
 await spriteLab.logError('EDITOR_WORKFLOW '+JSON.stringify({ok:true,version:info.version,checks}));
 await pixelEditorOpen();pixelEditorChooseFrameColor(pixelEditor.palette[0]);$('#pixelColorHex').value='#5599bb';$('#pixelColorHex').dispatchEvent(new Event('input'));await pause();void pixelEditorClose();await pause();
})()
