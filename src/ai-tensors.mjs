// Contracts of the bundled segmentation exports. Sources: rembg sessions/base,
// dis_general_use, dis_anime and birefnet_general. ToonOut's local export already
// includes sigmoid and uses torchvision's fixed /255 input normalisation.
const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];
export function segmentationContract(model) {
  const isnet = model?.id === "isnet-general";
  const anime = model?.id === "isnet-anime";
  return {
    mean: isnet ? [0.5, 0.5, 0.5] : IMAGENET_MEAN,
    std: isnet || anime ? [1, 1, 1] : IMAGENET_STD,
    scaleByImageMaximum: model?.id !== "toonout",
    outputLogits: model?.family === "birefnet" && !model?.probabilityOutput,
    probabilityOutput: Boolean(model?.probabilityOutput),
  };
}
export function segmentationInput(rgb, model) {
  const contract = segmentationContract(model), plane = rgb.length / 3;
  if (!Number.isInteger(plane)) throw new Error("Вход ИИ должен содержать RGB-пиксели.");
  let divisor = 255;
  if (contract.scaleByImageMaximum) {
    divisor = 1e-6;
    for (const value of rgb) divisor = Math.max(divisor, value);
  }
  const data = new Float32Array(rgb.length);
  for (let i = 0; i < plane; i++) for (let c = 0; c < 3; c++) {
    data[c * plane + i] = (rgb[i * 3 + c] / divisor - contract.mean[c]) / contract.std[c];
  }
  return data;
}
function sigmoid(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exponential = Math.exp(value); return exponential / (1 + exponential);
}
export function segmentationProbabilities(passes, model) {
  if (!passes.length || !passes[0].length || passes.some(pass => pass.length !== passes[0].length)) throw new Error("ИИ вернул карты разного размера.");
  const contract = segmentationContract(model);
  const transformed = passes.map(pass => Float32Array.from(pass, value => {
    if (!Number.isFinite(value)) throw new Error("ИИ вернул нечисловую вероятность.");
    return contract.outputLogits ? sigmoid(value) : value;
  }));
  let minimum = Infinity, maximum = -Infinity;
  for (const pass of transformed) for (const value of pass) { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); }
  // An export with calibrated probabilities must never get a second sigmoid or
  // image-dependent min/max. Other rembg exports use one shared range after sigmoid.
  if (contract.probabilityOutput) { minimum = 0; maximum = 1; }
  const range = Math.max(1e-6, maximum - minimum), bytes = Buffer.alloc(passes[0].length);
  for (let i = 0; i < bytes.length; i++) {
    let total = 0;
    for (const pass of transformed) total += Math.max(0, Math.min(1, (pass[i] - minimum) / range));
    bytes[i] = Math.round(total / transformed.length * 255);
  }
  return bytes;
}
