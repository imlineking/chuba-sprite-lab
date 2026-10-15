(async () => {
  await window.userProfileReady;
  if (!document.querySelector('#userNameModal').classList.contains('hidden')) document.querySelector('#skipUserName').click();
  await window.conveyorUI.ready;
  const api = window.spriteLab.conveyor, ui = window.conveyorUI;
  const file = 'C:/Users/User/Documents/ChatGPT/lab/chuba-sprite-lab/docs/audits/2026-10-15/timing-shaped.gif';
  ui.setView('conveyor'); await ui.detect([file]); await ui.act('preset:pixel-art');
  let directCancelled = false;
  const unsubscribe = api.onProgress((progress) => {
    if (!directCancelled && progress.id === 'clean' && progress.status === 'running') {
      directCancelled = true;
      if (!ui.snapshot().busy || document.querySelector('#cvCancel').classList.contains('hidden')) throw new Error('Отмена недоступна');
      void ui.act('cancel');
    }
  });
  await ui.act('run'); unsubscribe();
  if (!directCancelled || ui.snapshot().busy || ui.snapshot().result?.ok) throw new Error('Прямой запуск не остановлен');
  let queueCancelled = false;
  const done = new Promise((resolve, reject) => {
    const off = api.onQueue((queue) => {
      if (queue.running && !queueCancelled) {
        queueCancelled = true;
        if (!ui.snapshot().busy) { off(); reject(new Error('Занятость очереди не видна')); return; }
        void ui.act('cancel');
      }
      if (queueCancelled && !queue.running && queue.items.some((item) => item.status === 'cancelled')) { off(); resolve(); }
    });
  });
  await api.queueAdd({ paths: [file], presetId: 'pixel-art' }); await done;
  if (!queueCancelled || ui.snapshot().busy) throw new Error('Отмена очереди не завершилась');
  ui.setView('quick');
  let quickCancelled = false;
  const offQuick = api.onProgress((progress) => {
    if (!quickCancelled && progress.id === 'clean' && progress.status === 'running') {
      quickCancelled = true;
      if (document.querySelector('#cvQuickCancel').classList.contains('hidden')) throw new Error('Нет кнопки отмены быстрого режима');
      document.querySelector('#cvQuickCancel').click();
    }
  });
  await ui.quickRun([file]); offQuick();
  if (!quickCancelled || ui.snapshot().busy || !ui.snapshot().quick?.error) throw new Error('Быстрый режим не остановился');
  ui.setView('queue');
  document.documentElement.dataset.shellMotion = 'off';
})();
