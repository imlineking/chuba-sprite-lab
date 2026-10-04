(() => {
  let draft=null,token=0;
  const status=message=>$('#pixelDocumentPaletteStatus').textContent=message;
  function cancel(){draft=null;token++;$('#pixelDocumentPaletteApply').disabled=true;}
  function sync(){
    $('#pixelDocumentPaletteMode').textContent=pixelEditor.colorMode==='indexed'?'Индексированный · '+(pixelEditor.documentPalette?.length||0)+' цветов':'RGBA · свободные цвета';
    const list=$('#pixelDocumentPaletteColors');list.replaceChildren();
    (pixelEditor.documentPalette||[]).forEach((color,index)=>{const button=document.createElement('button');button.type='button';button.className='pixel-tool-button';button.style.backgroundColor=`rgba(${color.slice(0,3).join(',')},${color[3]/255})`;button.style.width='24px';button.style.height='24px';button.title=`${index}: ${pixelEditorHex(color)} · A ${color[3]}`;button.textContent=color[3]?'':'×';button.addEventListener('click',()=>{pixelEditorSetColor(color);$('#pixelDocumentPaletteIndex').value=String(index);$('#pixelDocumentPaletteColor').value=pixelEditorHex(color);$('#pixelDocumentPaletteAlpha').value=String(color[3]);});list.append(button);});
    $('#pixelDocumentPaletteReplace').disabled=pixelEditor.colorMode!=='indexed';
    if(!draft)status(pixelEditor.colorMode==='indexed'?'Палитра действует на пиксели слоёв. PNG содержит готовую RGBA; индексы сохраняются в проекте.':'Выберите число цветов и подготовьте просмотр.');
    repeat();
  }
  function repeat(){const target=$('#pixelTilePreview');target.hidden=!$('#pixelTileWrap').checked;if(target.hidden||!pixelEditor.composite)return;const source=document.createElement('canvas');source.width=pixelEditor.width;source.height=pixelEditor.height;const x=source.getContext('2d');x.putImageData(new ImageData(new Uint8ClampedArray(pixelEditor.preview||pixelEditor.composite),source.width,source.height),0,0);target.width=Math.min(512,source.width*3);target.height=Math.min(512,source.height*3);const c=target.getContext('2d');c.imageSmoothingEnabled=false;for(let y=0;y<3;y++)for(let z=0;z<3;z++)c.drawImage(source,z*target.width/3,y*target.height/3,target.width/3,target.height/3);}
  async function preview(options){
    if(!pixelEditor.sessionId)return;pixelEditorCancelPreview();const id=++token,sessionId=pixelEditor.sessionId;
    try{const result=await window.spriteLab.pixelEditorOp({op:'paletteDocument',sessionId,preview:true,...options});if(id!==token||sessionId!==pixelEditor.sessionId)return;draft=options;pixelEditor.preview=new Uint8ClampedArray(result.composite);$('#pixelDocumentPaletteApply').disabled=false;status(result.changed+' пикселей изменится · '+result.palette.length+' цветов · только просмотр');pixelEditorRenderCanvas();}
    catch(error){status(error.message);}
  }
  async function commit(){if(!draft)return null;const options=draft;draft=null;return pixelEditorSend({op:'paletteDocument',...options});}
  window.spriteLabPaletteUI={sync,repeat,cancel,commit,hasDraft:()=>Boolean(draft)};
  $('#pixelDocumentPalettePrepare').addEventListener('click',()=>preview({limit:Number($('#pixelDocumentPaletteLimit').value)}));
  $('#pixelDocumentPaletteApply').addEventListener('click',()=>{void commit();});$('#pixelDocumentPaletteCancel').addEventListener('click',pixelEditorCancelPreview);
  $('#pixelDocumentPaletteRGBA').addEventListener('click',()=>preview({mode:'rgba'}));
  $('#pixelDocumentPaletteReplace').addEventListener('click',()=>preview({replaceIndex:Number($('#pixelDocumentPaletteIndex').value),color:[...pixelEditorColorFromHex($('#pixelDocumentPaletteColor').value).slice(0,3),Number($('#pixelDocumentPaletteAlpha').value)]}));
  $('#pixelTileWrap').addEventListener('change',()=>{repeat();pixelEditorRenderCanvas();});
})();
