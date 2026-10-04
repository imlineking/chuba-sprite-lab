(() => {
  let draft = null, token = 0;
  const cancel = () => { token++; draft = null; $('#pixelTextRepairApply').disabled = true; };
  async function commit() { if (!draft) return null; const result = draft; return pixelEditorSend({ op: 'replacePixels', pixels: result.pixels, layerId: result.layerId }); }
  window.spriteLabTextRepairUI = { cancel, commit, hasDraft: () => Boolean(draft) };
  $('#pixelTextRepairCancel').addEventListener('click', pixelEditorCancelPreview);
  $('#pixelTextRepairApply').addEventListener('click', () => { void commit(); });
  $('#pixelTextRepairRun').addEventListener('click', async () => {
    if (!pixelEditor.selection?.some(Boolean)) { $('#pixelTextRepairStatus').textContent = 'Выделите только старые буквы.'; return; }
    pixelEditorCancelPreview(); const generation = ++token, sessionId = pixelEditor.sessionId;
    $('#pixelTextRepairRun').disabled = true; $('#pixelTextRepairStatus').textContent = 'Восстанавливаю фон под буквами…';
    try {
      await pixelEditorFlush();
      const result = await window.spriteLab.repairLettering({ sessionId, method: $('#pixelTextRepairMethod').value });
      if (generation !== token || sessionId !== pixelEditor.sessionId) return;
      draft = result; pixelEditor.preview = new Uint8ClampedArray(result.composite); pixelEditorRenderCanvas(); $('#pixelTextRepairApply').disabled = false;
      $('#pixelTextRepairStatus').textContent = 'Предпросмотр. Примените и добавьте новый текст; Ctrl+Z вернёт старые буквы.';
    } catch (error) { $('#pixelTextRepairStatus').textContent = error.message; }
    finally { $('#pixelTextRepairRun').disabled = false; }
  });
})();
