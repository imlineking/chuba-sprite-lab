// Colour grading preserves the original value structure and transparency. It does not
// infer surface normals or move painted highlights and shadows.
export function toneRgba(input, info, { color = "#ffffff", strength = 0 } = {}) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(color));
  const amount = Math.max(0, Math.min(1, Number(strength) / 100 || 0));
  if (!match || !amount) return Buffer.from(input);
  const target = [0, 2, 4].map((offset) => parseInt(match[1].slice(offset, offset + 2), 16));
  const average = (target[0] + target[1] + target[2]) / 3 || 1;
  const channels = info.channels || 4;
  const output = Buffer.from(input);
  for (let offset = 0; offset < output.length; offset += channels) {
    if (channels === 4 && output[offset + 3] === 0) continue;
    const value = (output[offset] + output[offset + 1] + output[offset + 2]) / 3;
    for (let channel = 0; channel < 3; channel += 1) {
      const graded = Math.max(0, Math.min(255, value * target[channel] / average));
      output[offset + channel] = Math.round(output[offset + channel] * (1 - amount) + graded * amount);
    }
  }
  return output;
}
