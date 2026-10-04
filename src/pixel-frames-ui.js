(() => {
  let playback = false, timer = null;
  const stop = () => { playback=false;clearTimeout(timer);$('#pixelFramePlay').textContent='▶ Просмотр'; };
  async function next(delta) {
    if (pixelEditor.preview) { pixelEditorStatus('Примените или отмените предпросмотр перед сменой кадра.','warn');stop();return; }
    const indices=pixelEditor.frameIndices||[pixelEditor.frameIndex],at=indices.indexOf(pixelEditor.frameIndex),index=indices[(at+delta+indices.length)%indices.length];
    await pixelEditorSend({op:'switchFrame',frameIndex:index});
  }
  async function tick(){if(!playback||!pixelEditorIsOpen()){stop();return;}await next(1);if(playback)timer=setTimeout(tick,pixelEditor.durationMs||100);}
  function sync(answer){pixelEditor.frameIndices=answer.frameIndices;pixelEditor.durationMs=answer.durationMs;pixelEditor.seriesDirty=answer.dirty;pixelEditor.onion=answer.onion;const indices=answer.frameIndices||[answer.frameIndex];$('#pixelFrameBar').hidden=indices.length<2;const select=$('#pixelFrameSelect');select.replaceChildren(...indices.map(i=>new Option('Кадр '+(i+1),String(i))));select.value=String(answer.frameIndex);$('#pixelFrameDuration').value=String(answer.durationMs||100);}
  window.spriteLabFramesUI={sync,stop};
  $('#pixelFramePrev').addEventListener('click',()=>{stop();void next(-1);});$('#pixelFrameNext').addEventListener('click',()=>{stop();void next(1);});
  $('#pixelFrameSelect').addEventListener('change',()=>{stop();if(pixelEditor.preview){pixelEditorStatus('Примените или отмените предпросмотр.','warn');$('#pixelFrameSelect').value=String(pixelEditor.frameIndex);return;}void pixelEditorSend({op:'switchFrame',frameIndex:Number($('#pixelFrameSelect').value)});});
  $('#pixelFrameDuration').addEventListener('change',()=>{stop();void pixelEditorSend({op:'switchFrame',durationMs:Number($('#pixelFrameDuration').value)});});
  $('#pixelFrameOnion').addEventListener('change',()=>pixelEditorSend({op:'switchFrame',onion:$('#pixelFrameOnion').checked}));
  $('#pixelFramePlay').addEventListener('click',()=>{if(playback){stop();return;}if(pixelEditor.preview){pixelEditorStatus('Примените или отмените предпросмотр.','warn');return;}playback=true;$('#pixelFramePlay').textContent='■ Остановить';timer=setTimeout(tick,pixelEditor.durationMs||100);});
  $('#pixelTextAcrossFrames').addEventListener('click',()=>{stop();if(window.spriteLabTextUI.hasDraft()){pixelEditorStatus('Сначала примените текст.','warn');return;}void pixelEditorSend({op:'textAcrossFrames'});});
})();
