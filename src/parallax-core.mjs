// Shared, deterministic geometry for the editor and the standalone export.
export function assertParallaxPixelBudget(existing, incoming = []) {
  const pixels = [...existing, ...incoming].reduce((sum, asset) => sum + Number(asset.width) * Number(asset.height), 0);
  if (!Number.isFinite(pixels) || pixels > 128000000) throw new Error('Слишком много пикселей в сцене: лимит 128 Мп.');
  return pixels;
}

export function normalizeParallaxScene(value) {
  const number = (v, fallback, min, max) => Number.isFinite(Number(v)) ? Math.max(min, Math.min(max, Number(v))) : fallback;
  if (!value || value.kind !== 'sprite-lab-parallax' || value.version !== 1 || !Array.isArray(value.layers) || value.layers.length > 32) throw new Error('Некорректная сцена параллакса: версия 1, до 32 слоёв.');
  const width = Math.round(number(value.width, 960, 32, 4096)), height = Math.round(number(value.height, 540, 32, 4096));
  const ids = new Set();
  const layers = value.layers.map((layer, index) => {
    const id = String(layer.id || `layer-${index + 1}`).slice(0, 80);
    if (ids.has(id)) throw new Error('Идентификаторы слоёв повторяются.');
    ids.add(id);
    const asset = String(layer.asset || '');
    if (!/^assets\/[a-zA-Z0-9_-]+\.(png|webp|jpg|jpeg)$/i.test(asset)) throw new Error('Ресурс сцены должен находиться в папке assets.');
    return { id, asset, name: String(layer.name || `Слой ${index + 1}`).slice(0, 120), visible: layer.visible !== false,
      width: Math.round(number(layer.width, 1, 1, 16384)), height: Math.round(number(layer.height, 1, 1, 16384)),
      x: number(layer.x, 0, -16384, 16384), y: number(layer.y, 0, -16384, 16384),
      anchorX: number(layer.anchorX, .5, 0, 1), anchorY: number(layer.anchorY, 1, 0, 1),
      scale: number(layer.scale, 1, .01, 16), rotation: number(layer.rotation, 0, -180, 180), opacity: number(layer.opacity, 1, 0, 1),
      parallaxX: number(layer.parallaxX, .5, -2, 2), parallaxY: number(layer.parallaxY, 0, -2, 2),
      repeatX: Boolean(layer.repeatX), float: number(layer.float, 0, 0, 128) };
  });
  return { kind: 'sprite-lab-parallax', version: 1, name: String(value.name || 'Параллакс-сцена').slice(0, 120), width, height,
    background: /^#[0-9a-f]{6}$/i.test(value.background) ? value.background : '#19212a', pixelated: value.pixelated !== false, layers };
}

export function parallaxPose(scene, layer, camera = { x: 0, y: 0 }, seconds = 0) {
  return { x: scene.width * layer.anchorX + layer.x - (Number(camera.x) || 0) * layer.parallaxX,
    y: scene.height * layer.anchorY + layer.y - (Number(camera.y) || 0) * layer.parallaxY + Math.sin(seconds * Math.PI / 2) * layer.float,
    width: layer.width * layer.scale, height: layer.height * layer.scale, rotation: layer.rotation * Math.PI / 180 };
}

export function drawParallaxScene(ctx, scene, images, camera, seconds = 0) {
  ctx.clearRect(0, 0, scene.width, scene.height);
  ctx.fillStyle = scene.background; ctx.fillRect(0, 0, scene.width, scene.height);
  ctx.imageSmoothingEnabled = !scene.pixelated;
  let draws = 0;
  for (const layer of scene.layers) {
    const image = images.get(layer.asset); if (!layer.visible || !image || !layer.opacity) continue;
    const p = parallaxPose(scene, layer, camera, seconds);
    const offsets = [0];
    if (layer.repeatX) {
      const centre = Math.round((scene.width / 2 - p.x) / p.width), count = Math.min(256, Math.ceil(scene.width / p.width) + 2);
      // Bound pathological repeats rather than freezing the editor on a tiny image.
      offsets.length = 0;
      for (let n = centre - count; n <= centre + count; n++) offsets.push(n * p.width);
    }
    ctx.save(); ctx.globalAlpha = layer.opacity;
    for (const offset of offsets) {
      ctx.save(); ctx.translate(p.x + offset, p.y); ctx.rotate(p.rotation);
      ctx.drawImage(image, -p.width * layer.anchorX, -p.height * layer.anchorY, p.width, p.height); ctx.restore(); draws++;
    }
    ctx.restore();
  }
  return draws;
}
