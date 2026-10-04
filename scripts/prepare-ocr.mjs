import fs from 'node:fs/promises';
import crypto from 'node:crypto';
const directory = new URL('../vendor/ocr/', import.meta.url);
const manifest = JSON.parse(await fs.readFile(new URL('manifest.json', directory), 'utf8'));
await fs.mkdir(directory, { recursive: true });
for (const [language, expected] of Object.entries(manifest.sha256)) {
  const response = await fetch(`https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/${language}.traineddata`);
  if (!response.ok) throw new Error(`OCR ${language}: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (crypto.createHash('sha256').update(data).digest('hex') !== expected) throw new Error(`OCR ${language}: source changed; review the data before updating its checksum.`);
  await fs.writeFile(new URL(language + '.traineddata', directory), data);
}
console.log('Local English and Russian OCR data verified.');
