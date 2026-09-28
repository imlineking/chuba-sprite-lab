// Colour correction for independent PNGs. Alpha is preserved exactly.
export function adjustImageRgba(input, options = {}) {
  const brightness = Math.max(-100, Math.min(100, Number(options.brightness) || 0)) / 100;
  const contrast = 2 ** (Math.max(-100, Math.min(100, Number(options.contrast) || 0)) / 100 * 2);
  const warmth = Math.max(-100, Math.min(100, Number(options.warmth) || 0)) / 100;
  const output = Buffer.from(input);
  if (!brightness && contrast === 1 && !warmth) return output;
  for (let index = 0; index < output.length; index += 4) {
    if (!output[index + 3]) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      const temperature = channel === 0 ? warmth * 0.18 : channel === 1 ? warmth * 0.025 : -warmth * 0.18;
      const value = ((input[index + channel] / 255 - .5) * contrast + .5 + brightness + temperature) * 255;
      output[index + channel] = Math.max(0, Math.min(255, Math.round(value)));
    }
  }
  return output;
}
