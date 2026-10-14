/* Video <-> frame workflows for the copilot: frame picker (slider), edit in Sprite Lab or in
   an external editor (save is watched and re-imported), bake the frame back into the video,
   a single frame without background as PNG. The copilot hint cloud is the interface; this
   script owns the picker dialog and runs the chosen action. Classic script after copilot.js. */
(() => {
  const api = window.spriteLab ? window.spriteLab.videoFrame : null;
  if (!api) return;
  const q = (s) => document.querySelector(s);
  const vf = { video: null, info: null, frame: null, last: null, editors: [] };
  const emit = () => document.dispatchEvent(new CustomEvent("spriteLab:video-frame", { detail: { video: vf.video, frame: vf.frame, last: vf.last, editors: vf.editors } }));
  const currentVideo = () => (typeof state !== "undefined" && state.source?.kind === "video" ? state.source.paths?.[0] : null) || vf.video;
  const fps = () => vf.info?.fps || 25;
  const fail = (error, hint) => { vf.last = { error: error.message || String(error), hint }; emit(); };

  async function ensureInfo() {
    const video = currentVideo();
    if (!video) throw new Error("Сначала откройте видео.");
    if (vf.video !== video || !vf.info) { vf.video = video; vf.info = await api.info(video); }
    return video;
  }

  // Frame picker: slider + frame number + preview; Enter or «Взять кадр» confirms.
  let previewTimer = null;
  function openPicker() {
    return new Promise(async (resolve) => {
      try { await ensureInfo(); } catch (error) { fail(error); resolve(null); return; }
      const modal = q("#videoFrameModal"); const range = q("#videoFrameRange"); const number = q("#videoFrameNumber");
      const total = Math.max(1, Math.round((vf.info.duration || 1) * fps()));
      range.max = String(total - 1); number.max = String(total);
      const start = vf.frame?.index ?? 0; range.value = String(start); number.value = String(start + 1);
      q("#videoFrameMeta").textContent = `${vf.info.width}×${vf.info.height} · ${fps()} fps · ${total} кадров${vf.info.audio ? " · со звуком" : ""}`;
      const show = () => { clearTimeout(previewTimer); previewTimer = setTimeout(async () => { try { const f = await api.extract({ video: vf.video, index: Number(range.value), fps: fps() }); q("#videoFramePreview").src = `${f.url}?t=${Date.now()}`; q("#videoFrameTime").textContent = `${f.time.toFixed(2)} с`; } catch (error) { q("#videoFrameTime").textContent = error.message; } }, 160); };
      range.oninput = () => { number.value = String(Number(range.value) + 1); show(); };
      number.oninput = () => { range.value = String(Math.max(0, Math.min(total - 1, Number(number.value) - 1))); show(); };
      const close = (value) => { modal.classList.add("hidden"); resolve(value); };
      q("#videoFrameTake").onclick = async () => { try { vf.frame = { ...(await api.extract({ video: vf.video, index: Number(range.value), fps: fps() })), editor: null }; vf.last = null; emit(); close(vf.frame); } catch (error) { fail(error); close(null); } };
      q("#videoFrameCancel").onclick = () => close(null);
      modal.classList.remove("hidden"); show(); range.focus();
    });
  }

  async function needFrame() { return vf.frame || openPicker(); }
  const framePng = () => (typeof state !== "undefined" && vf.frame?.editor === "sprite-lab" && state.frameOverrides?.[0]) || vf.frame?.path;

  async function act(id) {
    const [kind, arg, extra] = String(id).split(":");
    try {
      if (kind === "task") { window.taskChoose?.(arg, "auto"); return; }
      if (kind === "cv") { const video = await ensureInfo(); window.conveyorUI?.setView("conveyor"); await window.conveyorUI?.detect([video]); return; }
      if (kind !== "vf") return;
      if (arg === "pick") { await openPicker(); return; }
      if (arg === "edit") { if (await needFrame()) emit(); return; }
      if (arg === "split" || arg === "as-is") {
        const video = await ensureInfo(); setStatus?.(arg === "split" ? "Раскадровка…" : "Сохраняю как есть…", "busy");
        const result = await window.spriteLab.conveyor.run({ paths: [video], quick: true, presetId: "quick", quickOptions: { background: false, atlas: arg === "as-is" } });
        vf.last = result.ok ? { kind: "exported", index: 0, path: result.outputDir } : { error: result.error }; if (result.ok) vf.last.say = arg; emit(); return;
      }
      if (arg === "edit-internal") {
        const frame = await needFrame(); if (!frame) return;
        const source = await window.spriteLab.conveyor.openInAdvanced([frame.path]);
        vf.frame = { ...frame, editor: "sprite-lab" }; if (source && typeof setSource === "function") setSource(source);
        if (typeof setTab === "function") setTab("process"); emit(); return;
      }
      if (arg === "edit-external") {
        const frame = await needFrame(); if (!frame) return;
        const editor = extra || "system"; const entry = vf.editors.find((e) => e.id === editor);
        if (editor !== "system" && !entry?.configured) { const chosen = await api.chooseEditor(editor); if (!chosen) return; vf.editors = (await api.editors()).editors; }
        const opened = await api.openExternal({ path: frame.path, editor });
        vf.frame = { ...frame, editor, editorLabel: entry?.label || "программы", savedAt: null }; vf.last = opened.note ? { hint: opened.note } : null; emit(); return;
      }
      if (arg === "bake") {
        const frame = await needFrame(); if (!frame) return;
        const result = await api.bake({ video: vf.video, framePng: framePng(), index: frame.index });
        if (result) { vf.last = { kind: "baked", index: frame.index, path: result.path, notes: result.notes }; emit(); }
        return;
      }
      if (arg === "cutout" || arg === "export-frame") {
        const frame = await needFrame(); if (!frame) return;
        const result = await api.saveCutout({ video: vf.video, index: frame.index, fps: fps(), raw: arg === "export-frame" });
        if (result) { vf.last = { kind: arg === "cutout" ? "cutout" : "exported", index: frame.index, path: result.path, empty: result.empty }; emit(); }
        return;
      }
      if (arg === "reveal" && vf.last?.path) { window.spriteLab.revealOutput(vf.last.path); return; }
    } catch (error) { fail(error, "Программа здесь не справилась. Лучше сделать этот шаг вручную во вкладке «Обработка» или во внешнем редакторе."); }
  }

  api.onSaved((saved) => { if (vf.frame && saved.path === vf.frame.path) { vf.frame = { ...vf.frame, savedAt: saved.modifiedAt, url: saved.url }; emit(); } });
  api.editors().then((r) => { vf.editors = r.editors; emit(); }).catch(() => {});
  window.videoFrameUI = { act, openPicker, state: vf };
})();
