(async()=>{
 await window.userProfileReady;
 if(!$('#userNameModal').classList.contains('hidden')){await spriteLab.saveUserProfile('Тест');setModalOpen($('#userNameModal'),false);}
 clearTimeout(state.sessionTimer);saveSessionSoon=()=>{};savePreferences=()=>{};
 spriteLabAppearance.choose('light');document.documentElement.dataset.shellMotion='off';
 const pause=()=>new Promise(resolve=>setTimeout(resolve,50));
 const assert=(condition,message)=>{if(!condition)throw new Error(message);};
 const same=(a,b)=>a.length===b.length&&a.every((n,i)=>n===b[i]);
 const paths=window.spriteLabColourTestPaths;
 if(!Array.isArray(paths)||!paths.length)throw new Error('Provide window.spriteLabColourTestPaths with a colourful PNG fixture.');
 setSource(await spriteLab.restoreProject({source:{kind:'frames',paths}}));window.startImageEditing();await pixelEditorOpen();await pause();
 const original=pixelEditor.composite.slice(),source=pixelEditor.palette.find(c=>c[0]>c[1]*1.3&&c[1]>c[2]*1.3&&c[0]>50);
 assert(source,'Brown colour absent in palette');assert(pixelEditor.palette.some(c=>c[1]>c[0]&&c[1]>c[2]),'Green absent in palette');
 const count=pixelEditor.palette.length;assert(count>32,'Palette did not include full image colours');
 assert($('#pixelPalette').clientHeight===300,'Expanded palette height');$('#pixelPaletteToggle').click();assert($('#pixelPalette').clientHeight===132,'Four-row palette height');
 $('#pixelPalette').scrollTop=340;await pause();await spriteLab.logError('PALETTE_SCROLL '+JSON.stringify({scroll:$('#pixelPalette').scrollTop,buttons:$('#pixelPalette').querySelectorAll('button').length,scrollHeight:$('#pixelPalette').scrollHeight,client:$('#pixelPalette').clientHeight,colors:count}));assert($('#pixelPalette').scrollTop>0&&$('#pixelPalette').querySelectorAll('button').length<160,'Palette scrolling/virtualization');
 $('#pixelPalette').scrollTop=0;await pause();$('#pixelPaletteToggle').click();
 pixelEditorChooseFrameColor(source);await pause();
 $('#pixelColorHex').value='#ff0055';$('#pixelColorHex').dispatchEvent(new Event('input',{bubbles:true}));await pause();
 const live=window.SpriteLabPixelColors.preview(original,window.SpriteLabPixelColors.matches(original,source),[255,0,85]);
 assert(same(pixelEditor.preview,live),'Live RGB preview mismatch');
 const canvas=$('#pixelCanvas').getContext('2d').getImageData(0,0,pixelEditor.width,pixelEditor.height).data;
 const offset=window.SpriteLabPixelColors.matches(original,source).find(i=>original[i+3]===255);
 assert(canvas[offset]===255&&canvas[offset+1]===0&&canvas[offset+2]===85,'Canvas did not change live');
 assert(same((await spriteLab.pixelEditorOp({op:'state',sessionId:pixelEditor.sessionId})).composite,original),'Preview mutated document');
 $('#pixelColorCancel').click();assert(same(pixelEditor.composite,original)&&pixelEditor.preview===null,'Cancel failed');
 pixelEditorChooseFrameColor(source);$('#pixelColorR').value='30';$('#pixelColorR').dispatchEvent(new Event('input'));await pause();
 assert(pixelEditor.preview[offset]===30,'RGB input preview failed');await pixelColorCommit();assert(pixelEditor.composite[offset]===30,'Apply replacement failed');
 document.dispatchEvent(new KeyboardEvent('keydown',{key:'z',code:'KeyZ',ctrlKey:true,bubbles:true}));await pixelEditorFlush();assert(same(pixelEditor.composite,original),'Ctrl+Z must undo replacement in one step');
 await pixelEditorSend({op:'redo'});assert(pixelEditor.composite[offset]===30,'Redo replacement failed');await pixelEditorSend({op:'undo'});
 pixelEditorChooseFrameColor(source);await pixelColorCommit(true);assert(pixelEditor.composite[offset+3]===0,'Delete colour failed');await pixelEditorSend({op:'undo'});assert(same(pixelEditor.composite,original),'Undo removal failed');
 $('#pixelAdjustDetails').open=true;await pause();
 for(const [key,value] of Object.entries({brightness:12,saturation:25,contrast:10,shadows:20,highlights:-15,tintStrength:25})){$('#pixelAdjust-'+key).value=String(value);$('#pixelAdjust-'+key).dispatchEvent(new Event('input'));}
 $('#pixelAdjustTint').value='#ffddbb';$('#pixelAdjustTint').dispatchEvent(new Event('input'));await pause();
 const grading=pixelEditor.preview.slice();assert(!same(grading,original),'Grading did not preview');assert(grading.every((n,i)=>i%4!==3||n===original[i]),'Grading changed alpha');
 assert(same((await spriteLab.pixelEditorOp({op:'state',sessionId:pixelEditor.sessionId})).composite,original),'Grading preview mutated document');
 $('#pixelAdjustApply').click();await pixelEditorFlush();assert(same(pixelEditor.composite,grading),'Grading apply mismatch');
 await pixelEditorSend({op:'undo'});assert(same(pixelEditor.composite,original),'Grading undo not atomic');
 $('#pixelAdjustDetails').open=true;await pause();$('#pixelAdjust-brightness').value='30';$('#pixelAdjust-brightness').dispatchEvent(new Event('input'));await pause();$('#pixelAdjustCancel').click();assert(pixelEditor.preview===null&&same(pixelEditor.composite,original),'Grading cancel failed');
 const results=[];
 for(const view of ['palette','replacement','grading']) {
  if(view==='replacement'){pixelEditorChooseFrameColor(source);await pause();}
  if(view==='grading'){pixelEditorCancelPreview();$('#pixelAdjustDetails').open=true;await pause();}
  const geometry=[];
  for(const theme of ['dark','light']) {
   spriteLabAppearance.choose(theme);await pause();
   const nodes=[...$('#pixelEditorModal').querySelectorAll('button,input,summary')].filter(e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}));
   const rects=nodes.map(e=>{const r=e.getBoundingClientRect();return [e.id,r.x,r.y,r.width,r.height];});geometry.push(rects);
   const clipped=nodes.filter(e=>e.tagName==='BUTTON'&&(e.scrollWidth>e.clientWidth+2||e.scrollHeight>e.clientHeight+2)).map(e=>e.id);
   assert(!clipped.length,'Clipped controls '+clipped.join(','));assert(document.documentElement.scrollWidth<=innerWidth+2,'Page overflows');
   const form=$('#pixelColorForm');if(view==='replacement')assert(form.scrollWidth<=form.clientWidth+1,'Colour form overflow');
  }
  assert(geometry[0].length===geometry[1].length,'Theme control mismatch');assert(geometry[0].every((r,i)=>r.every((n,j)=>j===0?n===geometry[1][i][j]:Math.abs(n-geometry[1][i][j])<=1)),'Theme geometry differs '+view);results.push(view);
 }
 await spriteLab.logError('COLOUR_QA '+JSON.stringify({ok:true,paletteColors:count,checks:['live HEX/RGB','cancel','atomic replacement/undo/redo','deletion','grading preview/apply/undo/cancel','transparency','virtual scroll','4 rows','geometry'],views:results}));
 pixelEditorCancelPreview();$('#pixelPalette').scrollTop=0;pixelPaletteExpanded=false;pixelPaletteRender();spriteLabAppearance.choose('light');
 $('#pixelAdjustDetails').open=true;await pause();$('#pixelAdjust-saturation').value='20';$('#pixelAdjust-saturation').dispatchEvent(new Event('input'));await pause();
})()
