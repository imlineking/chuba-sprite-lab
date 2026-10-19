// An isolated scene draft: it never replaces the source, timeline or studio edits.
(() => {
  const modal = document.querySelector('#parallaxModal');
  const canvas = document.querySelector('#parallaxCanvas'), ctx = canvas.getContext('2d');
  const el = id => document.getElementById('parallax' + id);
  const draft = { scene: null, assets: {}, images: new Map(), selected: null, past: [], future: [], playing: false, raf: 0, seconds: 0, camera: { x: 0, y: 0 }, epoch: 0, busy: false, drag: null, draws: 0, dirty: false };
  let core;
  const studioHasUnsaved = window.spriteLabHasUnsavedChanges;
  window.spriteLabHasUnsavedChanges = () => draft.dirty || draft.busy || Boolean(studioHasUnsaved?.());
  const ready = import('./parallax-core.mjs').then(module => { core = module; return module; });
  const message = text => { el('Status').textContent = text; };
  const snapshot = () => JSON.stringify({ scene: draft.scene, assets: draft.assets, selected: draft.selected });
  function remember() { draft.past.push(snapshot()); if (draft.past.length > 60) draft.past.shift(); draft.future.length = 0; draft.dirty = true; }
  function draw() {
    if (!draft.scene) return;
    if (canvas.width !== draft.scene.width) canvas.width = draft.scene.width;
    if (canvas.height !== draft.scene.height) canvas.height = draft.scene.height;
    const scale = Math.min((canvas.parentElement.clientWidth - 36) / draft.scene.width, window.innerHeight * .52 / draft.scene.height);
    canvas.style.width = `${Math.max(1, draft.scene.width * scale)}px`; canvas.style.height = `${Math.max(1, draft.scene.height * scale)}px`;
    canvas.style.alignSelf = 'center';
    draft.draws = core.drawParallaxScene(ctx, draft.scene, draft.images, draft.camera, draft.seconds);
    el('Camera').textContent = `Камера X ${Math.round(draft.camera.x)} · Y ${Math.round(draft.camera.y)} px`;
  }
  function stop() { draft.playing = false; cancelAnimationFrame(draft.raf); draft.raf = 0; el('Play').textContent = 'Воспроизвести'; }
  function tick(now) {
    draft.raf = 0; if (!draft.playing || !modal.open || document.hidden) return;
    draft.seconds = (now - draft.start) / 1000; draft.camera.x = Math.sin(draft.seconds * .6) * draft.scene.width * .2;
    draw(); draft.raf = requestAnimationFrame(tick);
  }
  function controls() {
    const layer = draft.scene?.layers.find(l => l.id === draft.selected);
    for (const input of modal.querySelectorAll('[data-layer]')) {
      input.disabled = !layer || draft.busy;
      if (layer) { const value = layer[input.dataset.layer]; if (input.type === 'checkbox') input.checked = value; else input.value = value; }
    }
    for (const [key, suffix] of [['width', 'Width'], ['height', 'Height'], ['background', 'Background'], ['pixelated', 'Pixelated']]) {
      const input = el(suffix); if (input.type === 'checkbox') input.checked = draft.scene[key]; else input.value = draft.scene[key];
    }
    for (const id of ['Delete', 'Duplicate', 'Back', 'Front', 'ResetLayer']) el(id).disabled = !layer || draft.busy;
    el('Undo').disabled = !draft.past.length || draft.busy; el('Redo').disabled = !draft.future.length || draft.busy;
    el('Export').disabled = !draft.scene.layers.length || draft.busy;
    for (const id of ['Add', 'UseSource', 'Open', 'New']) el(id).disabled = draft.busy;
  }
  function render() {
    const used = new Set(draft.scene.layers.map(layer => layer.asset));
    for (const key of Object.keys(draft.assets)) if (!used.has(key)) delete draft.assets[key];
    for (const key of draft.images.keys()) if (!used.has(key)) draft.images.delete(key);
    const list = el('Layers'); list.replaceChildren();
    for (const [index, layer] of [...draft.scene.layers].entries()) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'parallax-layer';
      button.setAttribute('aria-pressed', String(layer.id === draft.selected));
      const name = document.createElement('strong'); name.textContent = `${index + 1} · ${layer.name}`;
      const detail = document.createElement('small'); detail.textContent = `${layer.visible ? 'Виден' : 'Скрыт'} · X ${layer.parallaxX} · Y ${layer.parallaxY}`;
      button.append(name, detail); button.onclick = () => { draft.selected = layer.id; render(); }; list.append(button);
    }
    el('Empty').hidden = draft.scene.layers.length > 0;
    controls(); draw();
  }
  async function loadImages() {
    const token = ++draft.epoch, images = new Map();
    await Promise.all([...new Set(draft.scene.layers.map(l => l.asset))].map(asset => new Promise((resolve, reject) => {
      const img = new Image(); img.onload = () => { images.set(asset, img); resolve(); }; img.onerror = () => reject(new Error('Не удалось загрузить слой: ' + asset)); img.src = draft.assets[asset].url;
    })));
    if (token !== draft.epoch) return;
    draft.images = images; render();
  }
  async function restore(value) { Object.assign(draft, JSON.parse(value)); stop(); await loadImages(); draft.dirty = true; }
  async function guard(operation) {
    if (draft.busy) return;
    draft.busy = true; controls();
    try { await operation(); } catch (error) { message(error.message || 'Не удалось выполнить действие.'); }
    finally { draft.busy = false; controls(); }
  }
  async function add(paths) {
    const assets = await window.spriteLab.parallax.images(paths); if (!assets?.length) return;
    if (draft.scene.layers.length + assets.length > 32) throw new Error('В сцене может быть до 32 слоёв.');
    core.assertParallaxPixelBudget(Object.values(draft.assets), assets);
    // Decode the complete incoming set before changing the current draft.
    const incoming = await Promise.all(assets.map(asset => new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('Не удалось прочитать ' + asset.name)); image.src = asset.url; })));
    remember(); stop();
    assets.forEach((asset, index) => {
      const id = crypto.randomUUID(), ref = `assets/${id}${asset.extension}`;
      draft.assets[ref] = asset; draft.images.set(ref, incoming[index]);
      draft.scene.layers.push({ id, asset: ref, name: asset.name, width: asset.width, height: asset.height, visible: true,
        x: 0, y: 0, anchorX: .5, anchorY: 1, scale: Math.min(1, draft.scene.width / asset.width, draft.scene.height / asset.height),
        parallaxX: Math.min(1, .15 + draft.scene.layers.length * .2), parallaxY: 0, rotation: 0, opacity: 1, repeatX: false, float: 0 }); draft.selected = id;
    });
    render(); message('Слои добавлены без очистки. В списке: от заднего к переднему. Перетащите сцену или включите воспроизведение.');
  }
  function blank() {
    stop(); draft.scene = core.normalizeParallaxScene({ kind: 'sprite-lab-parallax', version: 1, width: 960, height: 540, layers: [] });
    draft.assets = {}; draft.images.clear(); draft.selected = null; draft.camera = { x: 0, y: 0 }; draft.seconds = 0; draft.epoch++;
  }
  window.openParallaxSceneUI = async () => {
    await ready; if (!draft.scene) blank();
    if (!modal.open) modal.showModal(); render();
  };
  function close() { if (draft.busy) { message('Дождитесь окончания операции.'); return; } stop(); modal.close(); }
  el('Close').onclick = close; el('Done').onclick = close;
  modal.addEventListener('cancel', event => { event.preventDefault(); close(); });
  modal.addEventListener('close', stop);
  document.querySelectorAll('[data-open-parallax]').forEach(button => button.addEventListener('click', () => { void window.openParallaxSceneUI(); }));
  el('Add').onclick = () => { void guard(() => add()); };
  el('UseSource').onclick = () => { void guard(async () => {
    const paths = state.result?.framePaths?.length ? state.result.framePaths : state.source?.kind === 'frames' ? state.source.paths : [];
    if (!paths.length) throw new Error('Загрузите PNG в студию или нажмите «Добавить слои».');
    await add(paths);
  }); };
  el('New').onclick = () => { if (draft.busy) return; remember(); blank(); render(); message('Новая сцена. Предыдущую можно вернуть кнопкой «Отменить».'); };
  el('Open').onclick = () => { void guard(async () => {
    const answer = await window.spriteLab.parallax.open(); if (!answer) return;
    const incoming = new Map();
    await Promise.all(Object.entries(answer.assets).map(([asset, data]) => new Promise((resolve, reject) => { const image = new Image(); image.onload = () => { incoming.set(asset, image); resolve(); }; image.onerror = () => reject(new Error('Не удалось открыть слой.')); image.src = data.url; })));
    remember(); stop(); draft.epoch++; draft.scene = answer.scene; draft.assets = answer.assets; draft.images = incoming; draft.selected = answer.scene.layers[0]?.id; draft.camera = { x: 0, y: 0 }; draft.seconds = 0;
    render(); message('Сцена открыта. Исходный проект студии сохранён без изменений.');
  }); };
  el('Export').onclick = () => { void guard(async () => {
    const result = await window.spriteLab.parallax.export({ scene: draft.scene, assets: draft.assets });
    if (result) { draft.dirty = false; message(`Сохранено: ${result.directory} · PNG/ресурсы + JSON + автономный HTML. Для продолжения откройте scene.parallax.json.`); }
  }); };
  el('Undo').onclick = () => { void guard(async () => { if (!draft.past.length) return; draft.future.push(snapshot()); await restore(draft.past.pop()); }); };
  el('Redo').onclick = () => { void guard(async () => { if (!draft.future.length) return; draft.past.push(snapshot()); await restore(draft.future.pop()); }); };
  function editLayer(fn) { if (draft.busy) return; const layer = draft.scene.layers.find(l => l.id === draft.selected); if (!layer) return; remember(); fn(layer); draft.scene = core.normalizeParallaxScene(draft.scene); render(); }
  for (const input of modal.querySelectorAll('[data-layer]')) input.addEventListener('change', () => editLayer(layer => { layer[input.dataset.layer] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value; }));
  for (const [id, key] of [['Width', 'width'], ['Height', 'height'], ['Background', 'background'], ['Pixelated', 'pixelated']]) el(id).onchange = () => { if (draft.busy) return; remember(); draft.scene[key] = el(id).type === 'checkbox' ? el(id).checked : el(id).type === 'number' ? Number(el(id).value) : el(id).value; draft.scene = core.normalizeParallaxScene(draft.scene); render(); };
  el('Delete').onclick = () => editLayer(layer => { draft.scene.layers = draft.scene.layers.filter(l => l.id !== layer.id); draft.selected = draft.scene.layers[0]?.id; });
  el('Duplicate').onclick = () => editLayer(layer => { if (draft.scene.layers.length >= 32) return; const copy = { ...layer, id: crypto.randomUUID(), name: layer.name + ' · копия', x: layer.x + 16 }; draft.scene.layers.push(copy); draft.selected = copy.id; });
  for (const [id, delta] of [['Back', -1], ['Front', 1]]) el(id).onclick = () => editLayer(layer => { const i = draft.scene.layers.indexOf(layer), j = i + delta; if (j >= 0 && j < draft.scene.layers.length) [draft.scene.layers[i], draft.scene.layers[j]] = [draft.scene.layers[j], draft.scene.layers[i]]; });
  el('ResetLayer').onclick = () => editLayer(layer => Object.assign(layer, { x: 0, y: 0, anchorX: .5, anchorY: 1, scale: 1, rotation: 0, opacity: 1, parallaxX: .5, parallaxY: 0, float: 0, repeatX: false }));
  el('Play').onclick = () => { if (draft.playing) return stop(); draft.playing = true; draft.start = performance.now() - draft.seconds * 1000; el('Play').textContent = 'Пауза'; draft.raf = requestAnimationFrame(tick); };
  el('ResetCamera').onclick = () => { stop(); draft.camera.x = draft.camera.y = draft.seconds = 0; draw(); };
  canvas.addEventListener('pointerdown', event => { stop(); draft.drag = { x: event.clientX, y: event.clientY, cx: draft.camera.x, cy: draft.camera.y }; canvas.setPointerCapture(event.pointerId); });
  canvas.addEventListener('pointermove', event => { if (!draft.drag) return; const r = canvas.getBoundingClientRect(); draft.camera.x = draft.drag.cx - (event.clientX - draft.drag.x) * draft.scene.width / r.width; draft.camera.y = draft.drag.cy - (event.clientY - draft.drag.y) * draft.scene.height / r.height; draw(); });
  for (const name of ['pointerup', 'pointercancel']) canvas.addEventListener(name, () => { draft.drag = null; });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  new ResizeObserver(() => { if (modal.open && core) draw(); }).observe(canvas.parentElement);
  modal.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && ['KeyZ', 'KeyY'].includes(event.code) && !event.target.matches('input')) { event.preventDefault(); event.stopPropagation(); el(event.shiftKey || event.code === 'KeyY' ? 'Redo' : 'Undo').click(); }
  });
  window.spriteLabParallax = { open: window.openParallaxSceneUI, add: paths => guard(() => add(paths)), snapshot: () => ({ scene: structuredClone(draft.scene), selected: draft.selected, camera: { ...draft.camera }, playing: draft.playing, raf: draft.raf, draws: draft.draws, assets: structuredClone(draft.assets), liveImages: draft.images.size }) };
})();
