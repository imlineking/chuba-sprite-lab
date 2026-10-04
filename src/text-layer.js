// Shared settings and Canvas layout. The exact raster is stored with editable layers.
(function (root) {
  const number = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback;
  const color = (value, fallback) => /^#[0-9a-f]{6}$/i.test(value || '') ? value.toLowerCase() : fallback;
  function normalize(value = {}) {
    return {
      text: String(value.text ?? 'Текст').replace(/\r\n?/g, '\n').slice(0, 2000),
      font: String(value.font || 'Arial').replace(/[\x00-\x1f]/g, '').slice(0, 128),
      size: number(value.size, 24, 1, 512), bold: Boolean(value.bold), italic: Boolean(value.italic),
      color: color(value.color, '#ffffff'), strokeColor: color(value.strokeColor, '#000000'),
      stroke: number(value.stroke, 0, 0, 32), spacing: number(value.spacing, 0, -32, 128),
      lineGap: number(value.lineGap, 4, -256, 512), x: Math.round(number(value.x, 4, -32768, 32768)),
      y: Math.round(number(value.y, 4, -32768, 32768)),
      align: ['left', 'center', 'right'].includes(value.align) ? value.align : 'left',
    };
  }
  function render(canvas, value) {
    const settings = normalize(value), ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = `${settings.italic ? 'italic ' : ''}${settings.bold ? 'bold ' : ''}${settings.size}px ${JSON.stringify(settings.font)}`;
    ctx.textBaseline = 'alphabetic'; ctx.fontKerning = 'none';
    ctx.fillStyle = settings.color; ctx.strokeStyle = settings.strokeColor;
    ctx.lineWidth = settings.stroke * 2; ctx.lineJoin = 'round';
    const lines = settings.text.split('\n').slice(0, 100);
    const runs = lines.map(line => {
      const glyphs = Array.from(line), widths = glyphs.map(glyph => ctx.measureText(glyph).width);
      return { glyphs, widths, width: widths.reduce((sum, width) => sum + width, 0) + Math.max(0, glyphs.length - 1) * settings.spacing };
    });
    const step = Math.max(1, settings.size + settings.lineGap);
    // Stroke the entire text first, then fill: thick strokes cannot cover neighbouring glyphs.
    for (const stroke of settings.stroke ? [true, false] : [false]) runs.forEach((run, index) => {
      let x = settings.x - (settings.align === 'center' ? run.width / 2 : settings.align === 'right' ? run.width : 0);
      const y = settings.y + settings.size + index * step;
      run.glyphs.forEach((glyph, i) => { if (stroke) ctx.strokeText(glyph, x, y); else ctx.fillText(glyph, x, y); x += run.widths[i] + settings.spacing; });
    });
    return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  }
  const api = { normalize, render };
  root.SpriteLabText = Object.freeze(api);
})(typeof window === 'undefined' ? globalThis : window);
