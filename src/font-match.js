// Compare local rendered glyph shapes; this is similarity ranking, not font identification.
(() => {
  function signature(rgba, width, height, mask = null) {
    let transparentPixels = 0; for (let i = 0; i < width * height; i++) if (rgba[i * 4 + 3] < 32) transparentPixels++;
    const transparent = transparentPixels > width * height * .02;
    const border = [0, width - 1, (height - 1) * width, width * height - 1].map(i => Array.from(rgba.slice(i * 4, i * 4 + 3)));
    const background = [0, 1, 2].map(k => border.reduce((sum, c) => sum + c[k], 0) / 4);
    const ink = new Float32Array(width * height);
    let left = width, top = height, right = -1, bottom = -1;
    for (let i = 0; i < ink.length; i++) {
      if (mask && !mask[i]) continue;
      const value = transparent ? rgba[i * 4 + 3] / 255 : Math.min(1, Math.hypot(...background.map((c, k) => c - rgba[i * 4 + k])) / 160);
      ink[i] = value;
      if (value > .3) { const x = i % width, y = Math.floor(i / width); left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
    }
    if (right < left) throw new Error('В образце не найден контрастный текст. Выделите только строку на ровном фоне.');
    const w = right - left + 1, h = bottom - top + 1, values = new Float32Array(128 * 48);
    for (let y = 0; y < 48; y++) for (let x = 0; x < 128; x++) {
      const sx = left + Math.min(w - 1, Math.floor((x + .5) * w / 128)), sy = top + Math.min(h - 1, Math.floor((y + .5) * h / 48)); values[y * 128 + x] = ink[sy * width + sx];
    }
    return { values, aspect: w / h, height: h };
  }
  function score(a, b) {
    let difference = 0; for (let i = 0; i < a.values.length; i++) difference += Math.abs(a.values[i] - b.values[i]);
    return difference / a.values.length + .2 * Math.min(3, Math.abs(Math.log(a.aspect / b.aspect)));
  }
  function supportsGlyph(context, font, glyph) {
    if (/\s/.test(glyph)) return true;
    const draw = family => {
      context.clearRect(0, 0, 96, 80); context.font = `48px ${family}`; context.fillStyle = '#fff'; context.textBaseline = 'top'; context.fillText(glyph, 0, 0); return context.getImageData(0, 0, 96, 80).data;
    };
    // Different fallback families expose substitution. A supported glyph is identical with both.
    const a = draw(`${JSON.stringify(font)}, monospace`), b = draw(`${JSON.stringify(font)}, serif`);
    return a.some((value, i) => i % 4 === 3 && value > 0) && a.every((value, i) => value === b[i]);
  }
  globalThis.SpriteLabFontMatch = { signature, score, supportsGlyph };
})();
