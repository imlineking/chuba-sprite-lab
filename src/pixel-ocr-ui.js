(() => {
  let running = false, bounds = null, token = 0;
  $('#pixelOCRRun').addEventListener('click', async () => {
    if (running) return;
    if (!pixelEditor.selection?.some(Boolean)) { $('#pixelOCRStatus').textContent = 'Сначала выделите надпись.'; return; }
    if (pixelEditor.preview) { $('#pixelOCRStatus').textContent = 'Примените или отмените предпросмотр перед распознаванием.'; return; }
    const sessionId = pixelEditor.sessionId, generation = ++token;
    running = true; $('#pixelOCRRun').disabled = true; $('#pixelOCRStop').disabled = false; $('#pixelOCRUse').disabled = true;
    $('#pixelOCRStatus').textContent = 'Распознаю локально…';
    try {
      await pixelEditorFlush();
      const result = await window.spriteLab.recognizeText({ sessionId, language: $('#pixelOCRLanguage').value });
      if (generation !== token || sessionId !== pixelEditor.sessionId) return;
      bounds = result.bounds; $('#pixelOCRResult').value = result.text;
      $('#pixelOCRStatus').textContent = result.text ? `Уверенность OCR: ${Math.round(result.confidence)}%. Проверьте буквы и знаки.` : 'Текст не найден. Уточните выделение или введите его вручную.';
      $('#pixelOCRUse').disabled = !result.text;
    } catch (error) { if (generation === token) $('#pixelOCRStatus').textContent = error.name === 'AbortError' ? 'Распознавание остановлено.' : error.message; }
    finally { if (generation === token) { running = false; $('#pixelOCRRun').disabled = false; $('#pixelOCRStop').disabled = true; } }
  });
  $('#pixelOCRStop').addEventListener('click', () => { void window.spriteLab.recognizeText({ sessionId: pixelEditor.sessionId, cancel: true }); });
  $('#pixelOCRResult').addEventListener('input', () => { $('#pixelOCRUse').disabled = !$('#pixelOCRResult').value.trim(); });
  $('#pixelOCRUse').addEventListener('click', () => {
    const text = $('#pixelOCRResult').value.trim(); if (!text) return;
    window.spriteLabTextUI.fromRecognition({ text, x: bounds?.left || 0, y: bounds?.top || 0, size: Math.min(512, Math.max(8, Math.round((bounds?.height || 24) / Math.max(1, text.split('\n').length) * .8))), color: '#ffffff' });
  });
})();

