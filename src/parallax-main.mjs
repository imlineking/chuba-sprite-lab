import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { normalizeParallaxScene, drawParallaxScene } from './parallax-core.mjs';

export async function inspectParallaxImages(paths) {
  if (!Array.isArray(paths) || paths.length > 32) throw new Error('Выберите до 32 изображений.');
  let pixels = 0;
  return Promise.all(paths.map(async file => {
    if (!['.png', '.webp', '.jpg', '.jpeg'].includes(path.extname(file).toLowerCase())) throw new Error('Нужны PNG, WebP или JPEG.');
    const metadata = await sharp(file, { limitInputPixels: 64000000 }).metadata();
    if (metadata.pages > 1) throw new Error('Слой должен быть статичным изображением.');
    pixels += metadata.width * metadata.height;
    if (pixels > 128000000) throw new Error('Слишком много пикселей в сцене: лимит 128 Мп.');
    return { path: path.resolve(file), url: pathToFileURL(path.resolve(file)).href, name: path.basename(file), width: metadata.width, height: metadata.height, extension: path.extname(file).toLowerCase() };
  }));
}

export async function openParallaxScene(file) {
  if ((await fs.stat(file)).size > 1024 * 1024) throw new Error('Слишком большой JSON сцены.');
  const scene = normalizeParallaxScene(JSON.parse(await fs.readFile(file, 'utf8')));
  const base = await fs.realpath(path.dirname(file));
  const assets = {};
  for (const layer of scene.layers) {
    if (assets[layer.asset]) continue;
    const full = await fs.realpath(path.resolve(base, layer.asset));
    if (!full.toLowerCase().startsWith((base + path.sep).toLowerCase())) throw new Error('Ресурс вне папки сцены.');
    assets[layer.asset] = (await inspectParallaxImages([full]))[0];
  }
  for (const layer of scene.layers) {
    const actual = assets[layer.asset];
    if (actual.width !== layer.width || actual.height !== layer.height) throw new Error(`Размер ресурса изменился: ${layer.name}`);
  }
  await inspectParallaxImages(Object.values(assets).map(asset => asset.path));
  return { scene, assets };
}

export async function exportParallaxScene({ scene: value, assets, outputDir }) {
  const scene = normalizeParallaxScene(value);
  const required = [...new Set(scene.layers.map(layer => layer.asset))];
  const originals = required.map(asset => assets?.[asset]?.path);
  if (originals.some(file => !file)) throw new Error('Не найден исходник слоя.');
  const inspected = await inspectParallaxImages(originals);
  for (const layer of scene.layers) {
    const actual = inspected[required.indexOf(layer.asset)];
    if (actual.width !== layer.width || actual.height !== layer.height || !layer.asset.toLowerCase().endsWith(actual.extension)) throw new Error('Ресурс слоя изменился или имеет неверный формат.');
  }
  await fs.mkdir(outputDir, { recursive: true });
  const directory = await fs.mkdtemp(path.join(outputDir, 'parallax-'));
  await fs.mkdir(path.join(directory, 'assets'));
  for (const [index, asset] of required.entries()) await fs.copyFile(inspected[index].path, path.join(directory, asset), 1);
  const core = (await fs.readFile(new URL('./parallax-core.mjs', import.meta.url), 'utf8')).replace(/^export /gm, '');
  // Classic script works from file:// without a web server or module CORS flags.
  await fs.writeFile(path.join(directory, 'runtime.js'), `${core}\n(${standaloneParallax.toString()})();\n`);
  const json = JSON.stringify(scene).replace(/</g, '\\u003c');
  await fs.writeFile(path.join(directory, 'preview.html'), `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Sprite Lab · Parallax</title><style>body{margin:0;background:#161b22;color:#eee;font:15px system-ui;display:grid;place-items:center;min-height:100vh}main{width:min(100%,1200px)}canvas{width:100%;touch-action:none;display:block}button{padding:10px 18px;margin:10px}p{margin:10px}</style><main><canvas aria-label="Параллакс-сцена"></canvas><button id="play" type="button">Воспроизвести</button><button id="reset" type="button">Сброс камеры</button><p id="status">Перетащите сцену для движения камеры. Изображения не изменяются.</p></main><script id="scene" type="application/json">${json}</script><script src="runtime.js"></script></html>`);
  await fs.writeFile(path.join(directory, 'scene.parallax.json'), JSON.stringify(scene, null, 2));
  await fs.writeFile(path.join(directory, 'README.txt'), 'Sprite Lab Parallax\nОткройте preview.html без сети. Перетащите сцену или включите воспроизведение.\nscene.parallax.json открывается в Sprite Lab. assets содержит неизменённые исходники.\nСлои идут от заднего к переднему. Положение: anchor*scene + offset - camera*parallax.\nfloat задаёт колебание в px с периодом 4 секунды; repeatX повторяет слой по горизонтали.\nЭто 2D-композиция готовых слоёв, не автоматическое выделение глубины.\n');
  return { directory, scenePath: path.join(directory, 'scene.parallax.json'), previewPath: path.join(directory, 'preview.html'), layers: scene.layers.length };
}

// Kept self-contained for the exported classic runtime.
function standaloneParallax() {
  const scene = normalizeParallaxScene(JSON.parse(document.querySelector('#scene').textContent));
  const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d'), images = new Map(), camera = { x: 0, y: 0 };
  canvas.width = scene.width; canvas.height = scene.height;
  let playing = false, raf = 0, seconds = 0, start = 0, drag = null;
  const draw = () => drawParallaxScene(ctx, scene, images, camera, seconds);
  const tick = now => { raf = 0; if (!playing || document.hidden) return; seconds = (now - start) / 1000; camera.x = Math.sin(seconds * .6) * scene.width * .2; draw(); raf = requestAnimationFrame(tick); };
  const stop = () => { playing = false; cancelAnimationFrame(raf); raf = 0; document.querySelector('#play').textContent = 'Воспроизвести'; };
  document.querySelector('#play').onclick = () => { if (playing) return stop(); playing = true; start = performance.now() - seconds * 1000; document.querySelector('#play').textContent = 'Пауза'; raf = requestAnimationFrame(tick); };
  document.querySelector('#reset').onclick = () => { stop(); camera.x = camera.y = seconds = 0; draw(); };
  canvas.onpointerdown = e => { stop(); drag = { x: e.clientX, y: e.clientY, cx: camera.x, cy: camera.y }; canvas.setPointerCapture(e.pointerId); };
  canvas.onpointermove = e => { if (!drag) return; const r = canvas.getBoundingClientRect(); camera.x = drag.cx - (e.clientX - drag.x) * scene.width / r.width; camera.y = drag.cy - (e.clientY - drag.y) * scene.height / r.height; draw(); };
  canvas.onpointerup = canvas.onpointercancel = () => { drag = null; };
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  Promise.all([...new Set(scene.layers.map(l => l.asset))].map(asset => new Promise((resolve, reject) => { const img = new Image(); img.onload = () => { images.set(asset, img); resolve(); }; img.onerror = reject; img.src = asset; }))).then(draw).catch(() => { document.querySelector('#status').textContent = 'Не удалось загрузить слой. Сохраните папку assets рядом с HTML.'; });
}

export function registerParallaxIpc({ ipcMain, dialog, mainWindow }) {
  ipcMain.handle('parallax:images', async (_event, paths) => {
    if (!paths) { const result = await dialog.showOpenDialog(mainWindow(), { title: 'Добавить слои сцены', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Изображения', extensions: ['png', 'webp', 'jpg', 'jpeg'] }] }); if (result.canceled) return []; paths = result.filePaths; }
    return inspectParallaxImages(paths);
  });
  ipcMain.handle('parallax:open', async () => { const result = await dialog.showOpenDialog(mainWindow(), { title: 'Открыть параллакс-сцену', properties: ['openFile'], filters: [{ name: 'Sprite Lab Parallax', extensions: ['json'] }] }); return result.canceled ? null : openParallaxScene(result.filePaths[0]); });
  ipcMain.handle('parallax:export', async (_event, request) => { const result = await dialog.showOpenDialog(mainWindow(), { title: 'Папка для сцены и исходников', properties: ['openDirectory', 'createDirectory'] }); return result.canceled ? null : exportParallaxScene({ ...request, outputDir: result.filePaths[0] }); });
}
