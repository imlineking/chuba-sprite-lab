// Text is rasterized by Chromium using installed Windows fonts; the main document keeps both
// the settings and that exact RGBA layer. Saving never rerenders with another font engine.
(() => {
  const fields = { text: 'Content', font: 'Font', size: 'Size', bold: 'Bold', italic: 'Italic', color: 'Color', strokeColor: 'StrokeColor', stroke: 'Stroke', spacing: 'Spacing', lineGap: 'LineGap', x: 'X', y: 'Y', align: 'Align' };
  let draft = null, editingId = null, generation = 0, timer, fontNames = null, committing = false, newText = false;
  const active = () => pixelEditor.layers.find(layer => layer.id === pixelEditor.activeLayerId);
  function write(settings) {
    settings = window.SpriteLabText.normalize(settings);
    for (const [key, suffix] of Object.entries(fields)) {
      const field = $('#pixelText' + suffix);
      if (field.type === 'checkbox') field.checked = settings[key];
      else {
        if (key === 'font' && !Array.from(field.options).some(item => item.value === settings.font)) field.add(new Option(settings.font, settings.font));
        field.value = String(settings[key]);
      }
    }
    reportFonts();
  }
  function read() {
    return window.SpriteLabText.normalize(Object.fromEntries(Object.entries(fields).map(([key, suffix]) => {
      const field = $('#pixelText' + suffix); return [key, field.type === 'checkbox' ? field.checked : field.value];
    })));
  }
  function valid() { return Object.values(fields).every(suffix => { const field = $('#pixelText' + suffix); return field.checkValidity() && (field.type !== 'number' || field.value !== ''); }); }
  function cancel() {
    clearTimeout(timer); generation++; draft = null; newText = false;
    $('#pixelTextApply').disabled = true;
    sync();
  }
  function sync() {
    const layer = active();
    $('#pixelTextRasterize').disabled = layer?.kind !== 'text' || layer.locked || Boolean(draft) || newText;
    if (!draft && !newText && $('#pixelTextDetails').open) {
      editingId = layer?.kind === 'text' ? layer.id : null;
      if (editingId) write(layer.text);
    }
  }
  function reportFonts() {
    if (!fontNames) return;
    const selected = $('#pixelTextFont').value;
    $('#pixelTextFontStatus').textContent = `${fontNames.length} шрифтов · ${fontNames.includes(selected) ? 'кириллица зависит от выбранного шрифта' : 'выбранный шрифт отсутствует; при правке возможна замена'}`;
  }
  async function fonts() {
    $('#pixelTextRefresh').disabled = true; $('#pixelTextFontStatus').textContent = 'Читаю шрифты Windows…';
    try {
      const result = await window.spriteLab.installedFonts(); fontNames = result.families;
      const selected = $('#pixelTextFont').value, select = $('#pixelTextFont');
      select.replaceChildren(...fontNames.map(name => new Option(name, name)));
      if (!fontNames.includes(selected)) select.add(new Option(selected + ' · отсутствует', selected));
      select.value = selected;
      reportFonts();
    } catch (error) { $('#pixelTextFontStatus').textContent = error.message || 'Не удалось прочитать шрифты. Повторите обновление.'; }
    finally { $('#pixelTextRefresh').disabled = false; }
  }
  function open(forceNew = false) {
    pixelEditorCancelPreview();
    const layer = active(); editingId = !forceNew && layer?.kind === 'text' ? layer.id : null;
    newText = !editingId;
    write(editingId ? layer.text : { text: 'Текст', size: Math.min(24, Math.max(6, Math.round(pixelEditor.height / 8))), x: 4, y: 4 });
    $('#pixelTextDetails').open = true; pixelEditorSetTool('text');
    $('.pixel-editor-side').scrollTop = 0; sync();
    if (!fontNames) void fonts();
    $('#pixelTextContent').focus();
  }
  async function render(token) {
    const sessionId = pixelEditor.sessionId;
    if (!valid() || !sessionId) { $('#pixelTextApply').disabled = true; return null; }
    const settings = read(), layerId = editingId;
    const canvas = document.createElement('canvas'); canvas.width = pixelEditor.width; canvas.height = pixelEditor.height;
    await document.fonts.load(`${settings.italic ? 'italic ' : ''}${settings.bold ? 'bold ' : ''}${settings.size}px ${JSON.stringify(settings.font)}`, settings.text.slice(0, 100));
    if (token !== generation || sessionId !== pixelEditor.sessionId || !draft) return null;
    const pixels = window.SpriteLabText.render(canvas, settings);
    await pixelEditorFlush();
    if (token !== generation || sessionId !== pixelEditor.sessionId || !draft) return null;
    const preview = await window.spriteLab.pixelEditorOp({ op: 'textPreview', sessionId, layerId, pixels });
    if (token !== generation || sessionId !== pixelEditor.sessionId || !draft) return null;
    draft = { layerId, text: settings, pixels };
    pixelEditor.preview = new Uint8ClampedArray(preview); pixelEditorRenderCanvas();
    $('#pixelTextApply').disabled = Boolean(active()?.id === layerId && active()?.locked);
    pixelEditorStatus(active()?.id === layerId && !active()?.visible ? 'Текстовый слой скрыт. Включите его видимость в списке слоёв.' : 'Текст · предпросмотр, ещё не применено', 'ready');
    return draft;
  }
  function preview() {
    if (pixelColorDraft || pixelAdjustDraft) pixelEditorCancelPreview();
    if (editingId && !pixelEditor.layers.some(layer => layer.id === editingId && layer.kind === 'text')) editingId = null;
    draft = { layerId: editingId }; const token = ++generation;
    reportFonts();
    clearTimeout(timer); $('#pixelTextApply').disabled = true;
    timer = setTimeout(() => { void render(token).catch(error => { pixelEditorStatus(error.message || 'Не удалось нарисовать текст', 'error'); }); }, 100);
  }
  async function commit() {
    if (!draft || committing) return null;
    if (!valid()) { pixelEditorStatus('Проверьте параметры текста: размер, интервалы и координаты должны быть в указанном диапазоне.', 'warn'); return null; }
    committing = true; $('#pixelTextApply').disabled = true;
    try {
      clearTimeout(timer); const token = ++generation;
      const rendered = await render(token);
      if (!rendered || !valid()) return null;
      newText = false;
      return await pixelEditorSend({ op: 'text', ...rendered });
    } finally { committing = false; $('#pixelTextApply').disabled = !draft || !valid() || Boolean(active()?.id === draft?.layerId && active()?.locked); }
  }
  function reset() { cancel(); editingId = null; $('#pixelTextDetails').open = false; sync(); }
  window.spriteLabTextUI = { open, cancel, sync, reset, commit, hasDraft: () => Boolean(draft),
    edit: layerId => { if (active()?.id === layerId) open(); },
    position: point => { if (!$('#pixelTextDetails').open) open(); $('#pixelTextX').value = point.x; $('#pixelTextY').value = point.y; preview(); },
  };
  $('#pixelToolText').addEventListener('click', () => open());
  $('#pixelAddText').addEventListener('click', () => open(true));
  $('#pixelTextRefresh').addEventListener('click', fonts);
  for (const suffix of Object.values(fields)) $('#pixelText' + suffix).addEventListener('input', preview);
  $('#pixelTextApply').addEventListener('click', () => { void commit().catch(error => pixelEditorStatus(error.message, 'error')); });
  $('#pixelTextCancel').addEventListener('click', pixelEditorCancelPreview);
  $('#pixelTextDetails').addEventListener('toggle', () => {
    if (!$('#pixelTextDetails').open) { if (draft) pixelEditorCancelPreview(); return; }
    sync(); if (!fontNames) void fonts();
  });
  $('#pixelTextRasterize').addEventListener('click', () => pixelEditorSend({ op: 'rasterizeText' }));
})();
