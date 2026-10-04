// Preview buffers never leave the renderer. Apply records one operation in document history.
let pixelColorDraft=null;
let pixelPaletteExpanded=true;
let pixelColorBusy=false;
let pixelColorPreviewTask=0;
let pixelAdjustDraft=null;
const pixelAdjustDefaults={brightness:0,saturation:0,contrast:0,warmth:0,shadows:0,highlights:0,tintStrength:0,tint:'#ffffff',style:'none',styleStrength:100};

function pixelEditorCancelPreview() {
  const hadPreview = Boolean(pixelEditor.preview);
  cancelAnimationFrame(pixelColorPreviewTask);
  pixelColorDraft=null;pixelAdjustDraft=null;pixelEditor.preview=null;
  window.spriteLabTextUI?.cancel();
  window.spriteLabTextRepairUI?.cancel();
  window.spriteLabPaletteUI?.cancel();
  $('#pixelColorForm').classList.add('hidden');$('#pixelAdjustDetails').open=false;
  pixelEditorRenderCanvas();
  if (pixelEditor.sessionId && hadPreview) pixelEditorStatus(t('Предпросмотр отменён · применённые изменения остаются'), 'ready');
}
function pixelEditorChooseFrameColor(color) {
  if(pixelColorBusy)return;
  pixelEditorCancelPreview();
  pixelColorDraft={source:color.slice(0,3),replacement:color.slice(0,3),tolerance:0,hsv:window.SpriteLabPixelColors.rgbToHsv(color)};
  $('#pixelColorSource').textContent=t("Цвет {color} · весь кадр",{color:pixelEditorHex(color)});
  $('#pixelColorTolerance').value='0';$('#pixelColorHex').setCustomValidity('');
  $('#pixelColorForm').classList.remove('hidden');
  pixelColorSyncFields();pixelColorPreview();$('.pixel-editor-side').scrollTop=0;
}
function pixelColorSyncFields() {
  if(!pixelColorDraft)return;
  const {replacement,hsv}=pixelColorDraft;
  $('#pixelColorHex').value=pixelEditorHex(replacement);
  ['R','G','B'].forEach((name,i)=>$('#pixelColor'+name).value=String(replacement[i]));
  $('#pixelColorHue').value=String(Math.round(hsv[0]));
  $('#pixelColorField').style.backgroundColor=pixelEditorHex(window.SpriteLabPixelColors.hsvToRgb(hsv[0],1,1));
  $('#pixelColorPoint').style.left=`${hsv[1]*100}%`;$('#pixelColorPoint').style.top=`${(1-hsv[2])*100}%`;
  $('#pixelColorField').setAttribute('aria-valuetext',`Насыщенность ${Math.round(hsv[1]*100)}%, яркость ${Math.round(hsv[2]*100)}%`);
}
function pixelColorPreview() {
  cancelAnimationFrame(pixelColorPreviewTask);
  pixelColorPreviewTask=requestAnimationFrame(()=>{
    if(!pixelColorDraft||!pixelEditor.composite)return;
    const offsets=window.SpriteLabPixelColors.matches(pixelEditor.composite,pixelColorDraft.source,pixelColorDraft.tolerance);
    pixelEditor.preview=window.SpriteLabPixelColors.preview(pixelEditor.composite,offsets,pixelColorDraft.replacement);
    $('#pixelColorCount').textContent=t("{count} пикселей · предпросмотр, ещё не применено",{count:offsets.length.toLocaleString()});
    $('#pixelColorToleranceValue').textContent=pixelColorDraft.tolerance?String(pixelColorDraft.tolerance):t('0 · точно');pixelEditorRenderCanvas();pixelEditorStatus(t('Замена цвета · предпросмотр, ещё не применено'),'ready');
  });
}
function pixelColorSetBusy(busy) {
  for(const id of ['pixelColorApply','pixelColorDelete','pixelAdjustApply','pixelSaveFrame'])$('#'+id).disabled=busy;
}
async function pixelColorCommit(erase=false) {
  if(!pixelColorDraft||pixelColorBusy||!$('#pixelColorHex').checkValidity()||['R','G','B'].some(name=>$('#pixelColor'+name).value===''||!$('#pixelColor'+name).checkValidity()))return null;
  const draft=pixelColorDraft;pixelColorBusy=true;pixelColorSetBusy(true);
  try { return await pixelEditorSend({op:'frameColor',source:draft.source,replacement:draft.replacement,tolerance:draft.tolerance,erase}); }
  finally { pixelColorBusy=false;pixelColorSetBusy(false); }
}
function pixelPaletteRender() {
  const viewport=$('#pixelPalette');
  viewport.classList.toggle('collapsed',!pixelPaletteExpanded);
  $('#pixelPaletteToggle').textContent=t(pixelPaletteExpanded?'4 ряда ↑':'Развернуть ↓');
  $('#pixelPaletteToggle').setAttribute('aria-expanded',String(pixelPaletteExpanded));
  $('#pixelPaletteCount').textContent=String(pixelEditor.palette.length);
  const rows=Math.ceil(pixelEditor.palette.length/8);
  viewport.style.height=`${Math.max(30,Math.min(pixelPaletteExpanded?300:132,rows*34-4))}px`;
  $('#pixelPaletteToggle').hidden=rows<=4;
  const inner=document.createElement('div');inner.className='pixel-palette-inner';
  inner.style.height=`${Math.ceil(pixelEditor.palette.length/8)*34}px`;
  const first=Math.max(0,Math.floor(viewport.scrollTop/34)-1)*8;
  const last=Math.min(pixelEditor.palette.length,first+(Math.ceil((viewport.clientHeight||300)/34)+3)*8);
  for(let i=first;i<last;i++) {
    const color=pixelEditor.palette[i],swatch=document.createElement('button');
    swatch.type='button';swatch.className='pixel-swatch';swatch.dataset.color=pixelEditorHex(color);
    swatch.style.backgroundColor=pixelEditorHex(color);swatch.style.left=`calc(${i%8*12.5}% + 2px)`;swatch.style.top=`${Math.floor(i/8)*34}px`;
    swatch.title=t("{color} · заменить, удалить или взять для кисти",{color:pixelEditorHex(color)});swatch.setAttribute('aria-label',swatch.title);
    swatch.addEventListener('click',()=>{pixelEditorSetColor(color);pixelEditorChooseFrameColor(color);});inner.append(swatch);
  }
  const scrollTop=viewport.scrollTop;
  viewport.replaceChildren(inner);
  viewport.scrollTop=scrollTop;
}
$('#pixelPalette').addEventListener('scroll',pixelPaletteRender);
$('#pixelPaletteToggle').addEventListener('click',()=>{pixelPaletteExpanded=!pixelPaletteExpanded;pixelPaletteRender();});
new ResizeObserver(pixelPaletteRender).observe($('#pixelPalette'));
window.spriteLabPixelUI=Object.freeze({renderPalette:pixelPaletteRender});

$('#pixelColorHex').addEventListener('input',event=>{
  const valid=/^#?[0-9a-f]{6}$/i.test(event.target.value);event.target.setCustomValidity(valid?'':'Введите HEX: #RRGGBB');
  $('#pixelColorApply').disabled=!valid||pixelColorBusy;if(!valid||!pixelColorDraft)return;
  pixelColorDraft.replacement=pixelEditorColorFromHex(event.target.value).slice(0,3);
  pixelColorDraft.hsv=window.SpriteLabPixelColors.rgbToHsv(pixelColorDraft.replacement);pixelColorSyncFields();pixelColorPreview();
});
for(const channel of ['R','G','B'])$('#pixelColor'+channel).addEventListener('input',()=>{
  const fields=['R','G','B'].map(name=>$('#pixelColor'+name));
  const valid=fields.every(input=>input.value!==''&&input.checkValidity());$('#pixelColorApply').disabled=!valid||pixelColorBusy;if(!pixelColorDraft||!valid)return;
  pixelColorDraft.replacement=fields.map(input=>Number(input.value));pixelColorDraft.hsv=window.SpriteLabPixelColors.rgbToHsv(pixelColorDraft.replacement);pixelColorSyncFields();pixelColorPreview();
});
function pixelColorFromHsv() {
  if(!pixelColorDraft)return;
  pixelColorDraft.replacement=window.SpriteLabPixelColors.hsvToRgb(...pixelColorDraft.hsv).slice(0,3);pixelColorSyncFields();pixelColorPreview();
}
$('#pixelColorHue').addEventListener('input',event=>{if(pixelColorDraft){pixelColorDraft.hsv[0]=Number(event.target.value);pixelColorFromHsv();}});
$('#pixelColorTolerance').addEventListener('input',event=>{if(pixelColorDraft){pixelColorDraft.tolerance=Number(event.target.value);pixelColorPreview();}});
const pixelField=$('#pixelColorField');
function pixelFieldPoint(event) {
  if(!pixelColorDraft)return;
  const rect=pixelField.getBoundingClientRect();
  pixelColorDraft.hsv[1]=Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width));pixelColorDraft.hsv[2]=1-Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height));pixelColorFromHsv();
}
pixelField.addEventListener('pointerdown',event=>{if(event.button!==0)return;pixelField.setPointerCapture(event.pointerId);pixelFieldPoint(event);});
pixelField.addEventListener('pointermove',event=>{if(pixelField.hasPointerCapture(event.pointerId))pixelFieldPoint(event);});
pixelField.addEventListener('pointerup',event=>{if(pixelField.hasPointerCapture(event.pointerId))pixelField.releasePointerCapture(event.pointerId);});
pixelField.addEventListener('keydown',event=>{
  if(!pixelColorDraft||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;
  event.preventDefault();const axis=['ArrowLeft','ArrowRight'].includes(event.key)?1:2,step=['ArrowLeft','ArrowDown'].includes(event.key)?-0.01:0.01;
  pixelColorDraft.hsv[axis]=Math.max(0,Math.min(1,pixelColorDraft.hsv[axis]+step));pixelColorFromHsv();
});
$('#pixelColorApply').addEventListener('click',()=>{void pixelColorCommit();});
$('#pixelColorDelete').addEventListener('click',()=>{void pixelColorCommit(true);});
$('#pixelColorCancel').addEventListener('click',pixelEditorCancelPreview);
$('#pixelColorBrush').addEventListener('click',()=>{const color=pixelColorDraft?.replacement;pixelEditorCancelPreview();if(color)pixelEditorSetColor(color);pixelEditorSetTool('pencil');});

const pixelAdjustLabels={brightness:'Яркость',saturation:'Насыщенность',contrast:'Контраст',warmth:'Тепло',shadows:'Тени',highlights:'Светлые участки',tintStrength:'Сила фильтра'};
for(const [key,label] of Object.entries(pixelAdjustLabels)) {
  const row=document.createElement('label');row.className='pixel-color-label';
  const title=document.createElement('span');title.textContent=label;
  const value=document.createElement('output');value.id='pixelAdjustValue-'+key;value.textContent='0';
  const input=document.createElement('input');input.type='range';input.id='pixelAdjust-'+key;input.min=key==='tintStrength'?'0':'-100';input.max='100';input.value='0';
  input.addEventListener('input',()=>{if(!pixelAdjustDraft)return;pixelAdjustDraft[key]=Number(input.value);value.textContent=input.value;pixelAdjustmentPreview();});
  row.append(title,value,input);$('#pixelAdjustSliders').append(row);
}
function pixelAdjustmentPreview() {
  cancelAnimationFrame(pixelColorPreviewTask);
  const active=pixelAdjustDraft&&(window.SpriteLabColorStyles.active(pixelAdjustDraft)||Object.keys(pixelAdjustLabels).some(key=>Number(pixelAdjustDraft[key])));
  if(!active){pixelEditor.preview=null;pixelEditorRenderCanvas();$('#pixelAdjustApply').disabled=true;return;}
  $('#pixelAdjustApply').disabled=false;
  pixelColorPreviewTask=requestAnimationFrame(()=>{
    if(!pixelAdjustDraft||!pixelEditor.composite)return;
    pixelEditor.preview=window.SpriteLabPixelColors.adjust(pixelEditor.composite,pixelAdjustDraft);pixelEditorRenderCanvas();pixelEditorStatus(t('Свет и цвет · предпросмотр, ещё не применено'),'ready');
  });
}
$('#pixelAdjustDetails').addEventListener('toggle',()=>{
  const details=$('#pixelAdjustDetails');
  if(!details.open){if(pixelAdjustDraft)pixelEditorCancelPreview();return;}
  window.spriteLabTextUI?.cancel();
  cancelAnimationFrame(pixelColorPreviewTask);pixelColorDraft=null;$('#pixelColorForm').classList.add('hidden');pixelAdjustDraft={...pixelAdjustDefaults,tintHsv:[0,0,1]};
  for(const key of Object.keys(pixelAdjustLabels)){$('#pixelAdjust-'+key).value='0';$('#pixelAdjustValue-'+key).textContent='0';}
  $('#pixelAdjustTint').value='#ffffff';$('#pixelAdjustTint').setCustomValidity('');
  $('#pixelAdjustStyle').value='none';$('#pixelAdjustStyleStrength').value='100';$('#pixelAdjustStyleValue').textContent='100%';
  pixelTintSync();pixelAdjustmentPreview();
});
for (const id of ['pixelAdjustStyle','pixelAdjustStyleStrength']) $('#'+id).addEventListener(id.endsWith('Strength')?'input':'change',()=>{
  if(!pixelAdjustDraft)return;
  pixelAdjustDraft.style=$('#pixelAdjustStyle').value;pixelAdjustDraft.styleStrength=Number($('#pixelAdjustStyleStrength').value);
  $('#pixelAdjustStyleValue').textContent=pixelAdjustDraft.styleStrength+'%';pixelAdjustmentPreview();
});
function pixelTintSync() {
  if(!pixelAdjustDraft)return;
  const hsv=pixelAdjustDraft.tintHsv||window.SpriteLabPixelColors.rgbToHsv(pixelEditorColorFromHex(pixelAdjustDraft.tint));
  $('#pixelAdjustTintHue').value=String(Math.round(hsv[0]));
  $('#pixelAdjustTintField').style.backgroundColor=pixelEditorHex(window.SpriteLabPixelColors.hsvToRgb(hsv[0],1,1));
  $('#pixelAdjustTintPoint').style.left=`${hsv[1]*100}%`;$('#pixelAdjustTintPoint').style.top=`${(1-hsv[2])*100}%`;
  $('#pixelAdjustTintField').setAttribute('aria-valuetext',`Насыщенность ${Math.round(hsv[1]*100)}%, яркость ${Math.round(hsv[2]*100)}%`);
}
$('#pixelAdjustTint').addEventListener('input',event=>{
  const valid=/^#?[0-9a-f]{6}$/i.test(event.target.value);event.target.setCustomValidity(valid?'':'Введите HEX: #RRGGBB');
  $('#pixelAdjustApply').disabled=!valid||pixelColorBusy;if(pixelAdjustDraft&&valid){pixelAdjustDraft.tint=pixelEditorHex(pixelEditorColorFromHex(event.target.value));pixelAdjustDraft.tintHsv=window.SpriteLabPixelColors.rgbToHsv(pixelEditorColorFromHex(pixelAdjustDraft.tint));pixelTintSync();pixelAdjustmentPreview();}
});
function pixelTintSet(hsv) {
  if(!pixelAdjustDraft)return;
  pixelAdjustDraft.tintHsv=hsv;pixelAdjustDraft.tint=pixelEditorHex(window.SpriteLabPixelColors.hsvToRgb(...hsv));$('#pixelAdjustTint').value=pixelAdjustDraft.tint;
  pixelTintSync();pixelAdjustmentPreview();
}
$('#pixelAdjustTintHue').addEventListener('input',event=>{
  if(!pixelAdjustDraft)return;
  const hsv=pixelAdjustDraft.tintHsv||window.SpriteLabPixelColors.rgbToHsv(pixelEditorColorFromHex(pixelAdjustDraft.tint));hsv[0]=Number(event.target.value);pixelTintSet(hsv);
});
const pixelTintField=$('#pixelAdjustTintField');
function pixelTintPoint(event) {
  if(!pixelAdjustDraft)return;
  const rect=pixelTintField.getBoundingClientRect(),hsv=[...(pixelAdjustDraft.tintHsv||[0,0,1])];
  hsv[0]=Number($('#pixelAdjustTintHue').value);
  hsv[1]=Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width));hsv[2]=1-Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height));pixelTintSet(hsv);
}
pixelTintField.addEventListener('pointerdown',event=>{if(event.button!==0)return;pixelTintField.setPointerCapture(event.pointerId);pixelTintPoint(event);});
pixelTintField.addEventListener('pointermove',event=>{if(pixelTintField.hasPointerCapture(event.pointerId))pixelTintPoint(event);});
pixelTintField.addEventListener('pointerup',event=>{if(pixelTintField.hasPointerCapture(event.pointerId))pixelTintField.releasePointerCapture(event.pointerId);});
pixelTintField.addEventListener('keydown',event=>{
  if(!pixelAdjustDraft||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;
  event.preventDefault();const hsv=[...(pixelAdjustDraft.tintHsv||[0,0,1])],axis=['ArrowLeft','ArrowRight'].includes(event.key)?1:2,step=['ArrowLeft','ArrowDown'].includes(event.key)?-0.01:0.01;
  hsv[axis]=Math.max(0,Math.min(1,hsv[axis]+step));pixelTintSet(hsv);
});
$('#pixelAdjustCancel').addEventListener('click',pixelEditorCancelPreview);
async function pixelAdjustmentCommit() {
  if(!pixelAdjustDraft||pixelColorBusy||!$('#pixelAdjustTint').checkValidity())return null;
  pixelColorBusy=true;pixelColorSetBusy(true);
  try { return await pixelEditorSend({op:'frameAdjust',adjustments:{...pixelAdjustDraft}}); }
  finally { pixelColorBusy=false;pixelColorSetBusy(false); }
}
$('#pixelAdjustApply').addEventListener('click',()=>{void pixelAdjustmentCommit();});
