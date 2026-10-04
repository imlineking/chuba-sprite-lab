import './color-styles.js';
import './pixel-colors.js';

// One implementation for independent PNGs, series, editor preview and export.
export function adjustImageRgba(input, options = {}) {
  return Buffer.from(globalThis.SpriteLabPixelColors.adjust(input, options));
}
export function hasColorAdjust(options = {}) {
  return globalThis.SpriteLabColorStyles.active(options) ||
    ['brightness','saturation','contrast','warmth','shadows','highlights','tintStrength'].some(key=>Number(options[key]));
}
