import sharp from "sharp";
import { medianCutPalette } from "./pixelate.mjs";

export async function buildSeriesPalette(inputs, colors = 32) {
  const samples = [], perFrame = Math.max(1, Math.floor(32768 / Math.max(1, inputs.length)));
  for (const input of inputs) {
    const { data } = await sharp(input).ensureAlpha().resize({ width: 64, height: 64, fit: "inside", kernel: "nearest" }).raw().toBuffer({ resolveWithObject: true });
    const step = Math.max(1, Math.ceil(data.length / 4 / perFrame));
    for (let i = 0; i < data.length / 4; i += step) if (data[i * 4 + 3] >= 32) samples.push([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]);
  }
  return medianCutPalette(samples, Math.max(2, Math.min(256, Math.round(colors))));
}
