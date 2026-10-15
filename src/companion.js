import { companionActionAllowed } from "./conveyor-tools.mjs";
(() => {
  const api = window.desktopCompanion;
  const pet = document.querySelector('#pet'); const message = document.querySelector('#message'); const choices = document.querySelector('#choices');
  document.body.dataset.surface = new URLSearchParams(location.search).get('surface');
  let state = { loading:true }; let dots = 1; let dotPhase = 0; let drag = null; let suppressClick = false;
  let moreOpen = false, settingsOpen = false;
  const action = (request) => api.action(request).catch(() => {});
  const command = (kind, id, approach) => action({ action:'command', command:{kind,id,approach} });
  function render() {
    setLocale(state.locale || "ru", {persist:false});
    document.documentElement.dataset.theme = state.theme || 'dark';
    document.querySelector('#badge').textContent = state.suggestions?.length ? String(state.suggestions.length) : '';
    message.textContent = state.loading ? 'Загрузка' + '.'.repeat(dots) : state.busy ? (state.workLabel || 'Выполняю задачу') + '.'.repeat(dots) : state.guide?.say || state.greeting;
    choices.replaceChildren();
    if (state.loading) return;
    let choiceTarget = choices;
    const button = (title, detail, callback, id = null, parent = choiceTarget) => {
      const element = document.createElement('button'); element.className='choice'; element.textContent=title; element.disabled=!companionActionAllowed(state.busy, id);
      if (detail) { const small=document.createElement('small'); small.textContent=detail; element.append(small); }
      element.addEventListener('click',callback); parent.append(element); return element;
    };
    if (state.error) { const error = document.createElement('p'); error.className = 'assistant-error'; error.textContent = state.error; choices.append(error); button('Повторить анализ', 'Операция не выполнена', () => command('refresh', 'refresh')); }
    if (state.undoAdvice) button('Отменить совет', state.undoAdvice + ' · Ctrl+Z', () => command('undo-advice', 'undo'));
    if (state.guide) {
      // Conveyor / quick / queue: what to press next, offered as chips in the same cloud.
      if (state.guide.honest) { const note = document.createElement('p'); note.className = 'assistant-honest'; note.textContent = state.guide.honest; choices.append(note); }
      const main = state.guide.chips || [], more = state.guide.moreChips || [];
      let extras = null;
      [...main, ...more].forEach((chip, index) => {
        if (index === 3) { extras = document.createElement('details'); extras.className = 'assistant-more'; extras.open = moreOpen; extras.addEventListener('toggle', () => { moreOpen = extras.open; }); const summary = document.createElement('summary'); summary.textContent = 'Ещё действия'; extras.append(summary); choices.append(extras); }
        const control = button(chip.title, chip.detail, () => command('conveyor', chip.id), chip.id, extras || choices);
        if (index === 0) control.classList.add('choice-primary');
        if (chip.secondary) { const link = document.createElement('span'); link.className = 'choice-link'; link.setAttribute('role', 'button'); link.tabIndex = state.busy ? -1 : 0; link.textContent = chip.secondary.title; link.addEventListener('click', event => { event.stopPropagation(); if (!state.busy) command('conveyor', chip.secondary.id); }); link.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); link.click(); } }); control.append(link); }
      });
    } else (state.scenarios || []).slice(0,3).forEach(item => {
      const row = document.createElement('div'); row.className = 'scenario';
      const title = document.createElement('strong'); title.textContent = item.title;
      const why = document.createElement('small'); why.textContent = item.why || item.reason; row.append(title, why);
      const actions = document.createElement('div'); actions.className = 'group';
      for (const approach of ['auto', 'manual']) {
        const control = document.createElement('button'); control.textContent = approach === 'auto' ? 'Сделать автоматически' : 'Открыть инструмент';
        control.disabled = Boolean(state.busy); control.onclick = () => command('task', item.task, approach); actions.append(control);
      }
      row.append(actions); choices.append(row);
    });
    if (!state.guide) (state.suggestions || []).slice(0,2).forEach(item => button(item.title,item.why,() => command('suggestion',item.id)));
    if (state.panelOpen && !state.guide) {
      const settings = document.createElement('details'); settings.className = 'assistant-more'; settings.open = settingsOpen;
      settings.addEventListener('toggle', () => { settingsOpen = settings.open; });
      const heading = document.createElement('summary'); heading.textContent = 'Инструменты и локальные настройки'; settings.append(heading); choices.append(settings);
      choiceTarget = settings;
      const models = document.createElement('label'); models.className = 'planner-control'; models.textContent = 'Планировщик · эксперимент';
      const select = document.createElement('select'); select.setAttribute('aria-label', 'Планировщик копилота');
      const qwenLabel = state.plannerStatus?.models?.find(model => model.id === 'qwen')?.label || 'Qwen · встроенная';
      for (const [id, title] of [['rules', 'Лёгкий · без модели'], ['qwen', qwenLabel]]) {
        const option = document.createElement('option'); option.value = id; option.textContent = title;
        if (id !== 'rules' && state.plannerStatus && !state.plannerStatus.models?.find(model => model.id === id)?.installed) { option.textContent += ' · не установлена'; option.disabled = true; }
        select.append(option);
      }
      select.value = state.planner || 'rules'; select.disabled = Boolean(state.busy); select.onchange = () => command('planner', select.value);
      const info = document.createElement('small'); info.textContent = `${state.plannerInfo || ''} · Qwen встроена в программу (llama.cpp, локально); Ollama и интернет не нужны.`;
      models.append(select, info); settings.append(models);
      button('Сравнить два плана', 'Текущие файлы · без применения правок', () => command('compare-planners', 'compare'));
      [['clipping','Исправить обрезание'],['cutout','Вырезать объект'],['atlas','Собрать атлас']].forEach(([id,title])=>button(title,'Перейти к нужному сценарию',()=>command('quick',id)));
      const guideIds = new Set((state.guide?.chips || []).map(chip => chip.id));
      if (!guideIds.has('cv:run') && !guideIds.has('run')) button('Конвейер · Сделать всё', 'Нарезка, фон, атлас, Приёмка и экспорт за один запуск', () => command('conveyor', 'view:conveyor'));
      if (!guideIds.has('view:quick')) button('Быстрый режим', 'Один файл, результат рядом с ним', () => command('conveyor', 'view:quick'));
      if (!guideIds.has('view:queue')) button('Очередь и наблюдение', 'Много файлов или папка, которая пополняется', () => command('conveyor', 'view:queue'));
      if (!guideIds.has('review')) button('Приёмка атласа', 'Алгоритмы + встроенная Qwen · вердикт и правки', () => command('review', 'open'));
      for (const task of state.tasks || []) {
        const row=document.createElement('div'); row.className='group'; const title=document.createElement('span'); title.textContent=task.title; row.append(title);
        for (const approach of ['auto','manual']) { const control=document.createElement('button'); control.textContent=approach==='auto'?'Авто':'Вручную'; control.disabled=Boolean(state.busy); control.onclick=()=>command('task',task.id,approach); row.append(control); }
        settings.append(row);
      }
      button('Локальные функции','Встроенные движки и проверка запуска',()=>command('models','models'));
      button('Обновить подсказки','Проанализировать текущее состояние',()=>command('refresh','refresh'));
    } else if (!state.guide) button('Выбрать задачу','Автоматический или ручной сценарий',()=>action({action:'toggle'}));
  }
  api.onState(next=>{ if (next.sourceKey !== state.sourceKey) { moreOpen = false; settingsOpen = false; } state=next; render(); });
  setInterval(()=>{ dotPhase=(dotPhase+1)%4; dots=[1,2,3,2][dotPhase]; if(state.loading || state.busy) message.textContent=t(state.loading?'Загрузка':state.workLabel || 'Выполняю задачу')+'.'.repeat(dots); },450);
  document.querySelector('#close').onclick=()=>action({action:'dismiss'});
  document.querySelector('#hide').onclick=()=>action({action:'hide'});
  for(const name of ['dragstart','drop','dragover']) document.addEventListener(name,event=>{event.preventDefault();event.stopPropagation();});
  for (const handle of [pet, document.querySelector('#speech header')]) {
    handle.addEventListener('pointerdown',event=>{
      if(event.button!==0 || (handle!==pet && event.target.closest('button,select,input,a')))return;
      event.preventDefault(); handle.setPointerCapture(event.pointerId);
      drag={handle,pointerId:event.pointerId,x:event.screenX,y:event.screenY,moved:false}; suppressClick=false;
      void action({action:'drag-start',x:event.screenX,y:event.screenY});
    });
    handle.addEventListener('pointermove',event=>{
      if(!drag || drag.handle!==handle || drag.pointerId!==event.pointerId)return;
      if(!drag.moved && Math.hypot(event.screenX-drag.x,event.screenY-drag.y)<5)return;
      drag.moved=true; handle.classList.add('dragging');
      void action({action:'drag-move',x:event.screenX,y:event.screenY});
    });
    const end=event=>{
      if(!drag || drag.handle!==handle || drag.pointerId!==event.pointerId)return;
      suppressClick=handle===pet && drag.moved; drag=null; handle.classList.remove('dragging');
      if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);
      void action({action:'drag-end'});
    };
    for(const name of ['pointerup','pointercancel','lostpointercapture'])handle.addEventListener(name,end);
  }
  pet.addEventListener('click',()=>{if(suppressClick){suppressClick=false;return;} void action({action:'toggle'});});
  new ResizeObserver(()=>{ if(document.body.dataset.surface==='bubble') void action({action:'resize',height:document.querySelector('#speech').offsetHeight+14}); }).observe(document.querySelector('#speech'));
  render();
})();
