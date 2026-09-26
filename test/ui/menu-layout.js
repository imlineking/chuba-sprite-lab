(async()=>{
 await window.userProfileReady;
 if(!$('#userNameModal').classList.contains('hidden')){await spriteLab.saveUserProfile('Тест');setModalOpen($('#userNameModal'),false);}
 clearTimeout(state.sessionTimer);saveSessionSoon=()=>{};savePreferences=()=>{};
 const pause=(ms=40)=>new Promise(r=>setTimeout(r,ms));
 const assert=(value,message)=>{if(!value)throw new Error(message);};
 const results=[];
 function inspect(view){
  const modal=document.querySelector('.modal-backdrop:not(.hidden)');
  const scope=modal||document;
  const nodes=[...scope.querySelectorAll('button,input,select,summary')].filter(e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}));
  const rects=nodes.map(e=>{const r=e.getBoundingClientRect();return[e.id||e.textContent.trim(),r.x,r.y,r.width,r.height];});
  const clipped=nodes.filter(e=>e.tagName==='BUTTON'&&(e.scrollWidth>e.clientWidth+2||e.scrollHeight>e.clientHeight+2)).map(e=>e.id||e.textContent.trim());
  const uncentred=[];
  for(const e of nodes.filter(e=>e.matches('.filmstrip-action,.pixel-color-actions .button,.auto-pilot-actions .button'))){
   if(e.disabled)continue;
   const r=e.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(e);const t=range.getBoundingClientRect();
   if(t.width&&Math.abs((t.x+t.width/2)-(r.x+r.width/2))>2)uncentred.push(e.id);
  }
  const blocked=[];
  for(const id of ['pixelSaveFrame','closePixelEditor','openCommands','taskPrimary','regionEditImage','saveAllImagePng']){
   const e=scope.querySelector('#'+id);if(!e||!e.checkVisibility()||e.disabled)continue;
   const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
   if(x<0||x>innerWidth||y<0||y>innerHeight)continue;
   let clippedByParent=false;
   for(let p=e.parentElement;p;p=p.parentElement){if(/auto|scroll|hidden/.test(getComputedStyle(p).overflowY)){const b=p.getBoundingClientRect();if(y<b.top||y>b.bottom)clippedByParent=true;}}
   if(clippedByParent)continue;
   const hit=document.elementFromPoint(x,y);if(hit!==e&&!e.contains(hit))blocked.push({id,hit:hit?.id||hit?.className});
  }
  assert(!clipped.length,view+' clipped '+clipped.join(','));assert(!uncentred.length,view+' off-centre '+uncentred.join(','));assert(!blocked.length,view+' occluded '+JSON.stringify(blocked));
  assert(document.documentElement.scrollWidth<=innerWidth+1,view+' page overflow');
  results.push({view,theme:document.documentElement.dataset.theme,controls:nodes.length,clipped,uncentred,blocked});return rects;
 }
 async function pair(view){
  await spriteLab.logError("AUDIT_STEP "+view);
  const all=[];
  for(const theme of ['dark','light']){spriteLabAppearance.choose(theme);document.documentElement.dataset.shellMotion='off';spriteLabShellMotion.cancel();await pause();all.push(inspect(view));}
  assert(all[0].length===all[1].length,view+' theme control count');
  assert(all[0].every((r,i)=>r.every((n,j)=>j===0?n===all[1][i][j]:Math.abs(n-all[1][i][j])<=1)),view+' theme geometry mismatch');
 }
 if(window.spriteLabAuditGroup==='menus'){
  for(const tab of ['source','process','export']){setTab(tab);$('.panel.active').scrollTop=0;await pair(tab+'-top');$('.panel.active').scrollTop=99999;await pair(tab+'-bottom');}
  await openAbout();await pair('about');closeAbout();
  openCommandPalette();await pair('commands');closeCommandPalette();
  await window.openUserPreferences();await pair('settings');setModalOpen($('#userNameModal'),false);
  await autoPilotOpenModels();await pair('models');autoPilotCloseModels();
  window.openFeedback('idea');await pair('feedback');setModalOpen($('#feedbackModal'),false);
 }else{
  setSource(await spriteLab.restoreProject({source:{kind:'frames',paths:window.spriteLabAuditPaths}}));window.startImageEditing();await pause();await pair('images');
  await pixelEditorOpen();await pause();
  const wrap=$('#pixelCanvasWrap'),canvas=$('#pixelCanvas');
  assert(canvas.getBoundingClientRect().width<=wrap.clientWidth-22,'Large frame was not fit to visible viewport');
  assert(canvas.getBoundingClientRect().height<=wrap.clientHeight-22,'Large frame vertical fit failed');
  assert(pixelEditor.zoom<1,'Large frame fit must allow zoom below 100%');
  pixelEditorSetZoom(2);await pause();wrap.scrollLeft=0;wrap.scrollTop=0;
  assert(canvas.getBoundingClientRect().left>=wrap.getBoundingClientRect().left,'Enlarged image left edge is unreachable');
  assert(canvas.getBoundingClientRect().top>=wrap.getBoundingClientRect().top,'Enlarged image top edge is unreachable');
  $('#pixelZoomFit').click();await pause();
  await pair('pixel-fit');
  const footer=$('.pixel-editor-foot'),info=$('.pixel-editor-info'),save=$('#pixelSaveFrame');
  const before=$('#pixelEditorStatus').textContent;
  pixelEditorStatus('Предпросмотр замены цвета ещё не применён. Проверьте изображение, затем примените изменение или отмените предпросмотр. Исходный файл остаётся на месте.','ready');await pause();
  for(const theme of ['dark','light']){
   spriteLabAppearance.choose(theme);await pause();const f=footer.getBoundingClientRect(),i=info.getBoundingClientRect(),b=save.getBoundingClientRect();
   assert(i.left-f.left>=14&&f.right-b.right>=14,'Footer lacks inner horizontal insets');
   assert(b.left-i.right>=22,'Footer status touches save button');
   assert(Math.abs((b.top+b.height/2)-(f.top+f.height/2))<=2,'Save button is not centred in footer');
   assert(info.scrollWidth<=info.clientWidth+1,'Long footer status overflows');
  }
  await pair('pixel-long-status');pixelEditorStatus(before,'ready');await pause();
  const originalPalette=pixelEditor.palette;
  pixelEditor.palette=[[0,0,0,255],[200,100,20,255],[10,190,20,255]];pixelPaletteRender();
  assert($('#pixelPalette').clientHeight===30&&!$('#pixelPaletteToggle').checkVisibility(),'Small palette wastes rows');pixelEditor.palette=originalPalette;pixelPaletteRender();
  $('#pixelPaletteToggle').click();assert($('#pixelPalette').clientHeight===132,'Four rows not available');$('#pixelPaletteToggle').click();
  pixelEditorChooseFrameColor(pixelEditor.palette[0]);await pause();assert($('.pixel-editor-side').scrollTop===0,'Colour action must open at top');await pair('pixel-colour-top');
  $('.pixel-editor-side').scrollTop=99999;await pair('pixel-colour-bottom');
  pixelEditorCancelPreview();$('#pixelAdjustDetails').open=true;await pause();$('.pixel-editor-side').scrollTop=0;await pair('pixel-grading');
  await pixelEditorClose();$('#regionEditImage').focus();await openMaskEditor({tool:'select'});assert(!$('#aiMaskModal').classList.contains('hidden'),'Mask editor did not open');await pair('mask-top');$('.mask-tools').scrollTop=99999;await pair('mask-bottom');closeMaskEditor();assert(document.activeElement===$('#regionEditImage'),'Mask editor lost focus on return');
  await openFrameEditor();await pair('external-editor');closeFrameEditor();
  $('#backdropToggle').click();await pair('backdrop');closeBackdropMenu();
 }
 await spriteLab.logError('MENU_AUDIT '+JSON.stringify({ok:true,window:[innerWidth,innerHeight],locale:i18nState.locale,results}));
 const final=window.spriteLabAuditFinal||'source';spriteLabAppearance.choose(window.spriteLabAuditTheme||'light');document.documentElement.dataset.shellMotion='off';
 if(final==='pixel'){await pixelEditorOpen();pixelPaletteExpanded=false;pixelPaletteRender();}
 else if(final==='colour'){await pixelEditorOpen();pixelEditorChooseFrameColor(pixelEditor.palette[0]);await pause();$('#pixelColorHex').value='#437bd9';$('#pixelColorHex').dispatchEvent(new Event('input'));await pause();}
 else {setTab(final);$('.panel.active').scrollTop=0;}
})()
