const cleanupFields = ["keyMode", "keyScope", "tolerance", "keyColor", "blackOutline", "blackFeather", "aiCutoff", "aiSoftness", "aiModel", "aiForceModel", "aiQuality", "fringeCleanup", "fringeStrength", "edgeDecontaminate", "edgeRefine"];
export function cleanupSignature(options) {
  return JSON.stringify(cleanupFields.map(name => [name, options[name] ?? null]));
}
export function preparedCleanupRecord(options, imagePath) {
  return { imagePath, signature: cleanupSignature(options), edits: (options.aiEdits || []).map(edit => JSON.stringify(edit)) };
}
// Cleanup is baked into the accepted PNG; global drawing/colour/transform
// controls remain live. New mask edits and changed cleanup settings still work.
export function resolvePreparedCleanup(options, index, inputPath) {
  const record = options.preparedCleanup?.[index];
  if (!record || record.imagePath !== inputPath) return options;
  const result = { ...options, aiEdits: (options.aiEdits || []).filter(edit => !record.edits.includes(JSON.stringify(edit))) };
  if (record.signature === cleanupSignature(options)) Object.assign(result, { keyMode: "alpha", fringeCleanup: false, edgeDecontaminate: false, edgeRefine: { mode: "none" } });
  return result;
}
