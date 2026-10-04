(() => {
  let token = 0;
  $('#pixelFontStop').addEventListener('click', () => { token++; });
  $('#pixelFontFind').addEventListener('click', async () => {
    const generation = ++token, sessionId = pixelEditor.sessionId, text = $('#pixelFontSample').value.trim();
    const status = $('#pixelFontMatchStatus'), list = $('#pixelFontCandidates');
    if (!text || !pixelEditor.selection?.some(Boolean)) { status.textContent = 'Выделите строку и введите её текст.'; return; }
    $('#pixelFontFind').disabled = true; $('#pixelFontStop').disabled = false; list.replaceChildren();
    try {
      await pixelEditorFlush();
      const w = pixelEditor.width, h = pixelEditor.height, selection = pixelEditor.selection;
      let left = w, top = h, right = -1, bottom = -1;
      for (let i = 0; i < selection.length; i++) if (selection[i]) { left = Math.min(left, i % w); right = Math.max(right, i % w); top = Math.min(top, Math.floor(i / w)); bottom = Math.max(bottom, Math.floor(i / w)); }
      const width = right - left + 1, height = bottom - top + 1, rgba = new Uint8ClampedArray(width * height * 4), mask = new Uint8Array(width * height);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const i = (top + y) * w + left + x, o = y * width + x; rgba.set(pixelEditor.composite.slice(i * 4, i * 4 + 4), o * 4); mask[o] = selection[i]; }
      const target = window.SpriteLabFontMatch.signature(rgba, width, height, mask), families = (await window.spriteLab.installedFonts()).families;
      const canvas = document.createElement('canvas'); canvas.width = 4096; canvas.height = 110; const context = canvas.getContext('2d', { willReadFrequently: true });
      const probe = document.createElement('canvas'); probe.width = 96; probe.height = 80; const probeContext = probe.getContext('2d', { willReadFrequently: true });
      const glyphs = [...new Set(text)].filter(c => !/\s/.test(c)), ranked = [];
      for (let i = 0; i < families.length; i++) {
        if (generation !== token || sessionId !== pixelEditor.sessionId) { status.textContent = 'Подбор остановлен.'; return; }
        const font = families[i]; await document.fonts.load(`48px ${JSON.stringify(font)}`, text);
        if (!glyphs.every(glyph => window.SpriteLabFontMatch.supportsGlyph(probeContext, font, glyph))) continue;
        for (const bold of [false, true]) {
          context.clearRect(0, 0, 4096, 110); context.font = `${bold ? 'bold ' : ''}48px ${JSON.stringify(font)}`; context.fillStyle = '#fff'; context.textBaseline = 'top'; context.fillText(text, 5, 5);
          const drawnWidth = Math.min(4096, Math.max(12, Math.ceil(context.measureText(text).width + 12)));
          let sample;
          try { sample = window.SpriteLabFontMatch.signature(context.getImageData(0, 0, drawnWidth, 110).data, drawnWidth, 110); } catch { continue; }
          ranked.push({ font, bold, score: window.SpriteLabFontMatch.score(target, sample), size: Math.round(48 * target.height / sample.height) });
        }
        if (i % 12 === 0) { status.textContent = `Сравниваю шрифты: ${i + 1}/${families.length}`; await new Promise(resolve => setTimeout(resolve, 0)); }
      }
      ranked.sort((a, b) => a.score - b.score); const unique = [...new Map(ranked.map(item => [item.font, ranked.find(best => best.font === item.font)])).values()].sort((a, b) => a.score - b.score).slice(0, 5);
      for (const item of unique) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'pixel-font-candidate';
        const label = document.createElement('span'); label.textContent = `${item.font}${item.bold ? ' · жирный' : ''}`;
        const sample = document.createElement('span'); sample.textContent = text; sample.style.fontFamily = JSON.stringify(item.font); sample.style.fontWeight = item.bold ? '700' : '400';
        button.append(label, sample); button.addEventListener('click', () => {
          const select = $('#pixelTextFont'); if (![...select.options].some(o => o.value === item.font)) select.add(new Option(item.font)); select.value = item.font;
          $('#pixelTextBold').checked = item.bold; $('#pixelTextSize').value = Math.max(1, Math.min(512, item.size)); select.dispatchEvent(new Event('input'));
        }); list.append(button);
      }
      status.textContent = unique.length ? `${unique.length} кандидатов с нужными буквами. Нажмите вариант и сравните предпросмотр.` : 'Подходящие шрифты с нужными буквами не найдены.';
    } catch (error) { status.textContent = error.message; }
    finally { $('#pixelFontFind').disabled = false; $('#pixelFontStop').disabled = true; }
  });
})();
