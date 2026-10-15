import fs from 'node:fs/promises';
import sharp from 'sharp';
import { planConveyorGuide } from '../../../src/copilot-conveyor.mjs';
import { capabilitiesFor } from '../../../src/capabilities.mjs';
import { builtinPresets, processorOptions } from '../../../src/conveyor.mjs';

const here = new URL('./', import.meta.url);
await sharp({create: {width: 64, height: 64, channels: 4, background: {r: 255, g: 255, b: 255, alpha: 1}}})
  .composite([{input: Buffer.from('<svg width="64" height="64"><rect x="16" y="12" width="32" height="40" fill="#ab4c75"/><rect x="22" y="20" width="8" height="8" fill="white"/></svg>')}])
  .png().toFile(new URL('fixture.png', here).pathname.replace(/^\/([A-Z]:)/i, '$1'));
const probes = {};
for (const type of ['image', 'video', 'image-set', 'sprite-sheet']) {
  const guide = planConveyorGuide({capabilities: capabilitiesFor(type), preset: builtinPresets[0], presets: builtinPresets});
  probes[type] = {text: guide.say, actionCount: guide.chips.length, actions: guide.chips.map(c => c.id)};
}
probes.busy = planConveyorGuide({busy: true});
probes.pixelPreset = processorOptions(builtinPresets.find(p => p.id === 'pixel-art'));
probes.failed = planConveyorGuide({capabilities: capabilitiesFor('video'), result: {ok: false, failedStage: 'export', error: 'Fixture only; export permission denied'}});
await fs.writeFile(new URL('baseline-probes.json', here), JSON.stringify(probes, null, 2));
console.log(JSON.stringify({actions: Object.fromEntries(Object.entries(probes).filter(([,v])=>v.actionCount).map(([k,v])=>[k,v.actionCount])), pixelPresetChangesPixels: Boolean(probes.pixelPreset.pixelate), busyActions: probes.busy.chips.map(c=>c.id)}));
