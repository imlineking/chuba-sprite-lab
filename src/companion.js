(() => {
  const api = window.desktopCompanion;
  const pet = document.querySelector('#pet'); const message = document.querySelector('#message'); const choices = document.querySelector('#choices');
  document.body.dataset.surface = new URLSearchParams(location.search).get('surface');
  let state = { loading:true }; let dots = 1; let dotPhase = 0; let drag = null; let suppressClick = false;
  const action = (request) => api.action(request).catch(() => {});
  const command = (kind, id, approach) => action({ action:'command', command:{kind,id,approach} });
  function render() {
    document.documentElement.dataset.theme = state.theme || 'dark';
    document.querySelector('#badge').textContent = state.suggestions?.length ? String(state.suggestions.length) : '';
    message.textContent = state.loading ? 'Подождите, идёт загрузка' + '.'.repeat(dots) : state.busy ? 'Обрабатываю кадры' + '.'.repeat(dots) : state.greeting;
    choices.replaceChildren();
    if (state.loading) return;
    const button = (title, detail, callback) => {
      const element = document.createElement('button'); element.className='choice'; element.textContent=title; element.disabled=Boolean(state.busy);
      if (detail) { const small=document.createElement('small'); small.textContent=detail; element.append(small); }
      element.addEventListener('click',callback); choices.append(element);
    };
    (state.scenarios || []).slice(0,2).forEach(item => button(item.title, item.why || item.reason, () => command('task',item.task,'manual')));
    (state.suggestions || []).slice(0,2).forEach(item => button(item.title,item.why,() => command('suggestion',item.id)));
    if (state.panelOpen) {
      [['clipping','Исправить обрезание'],['cutout','Вырезать объект'],['atlas','Собрать атлас']].forEach(([id,title])=>button(title,'Перейти к нужному сценарию',()=>command('quick',id)));
      for (const task of state.tasks || []) {
        const row=document.createElement('div'); row.className='group'; const title=document.createElement('span'); title.textContent=task.title; row.append(title);
        for (const approach of ['auto','manual']) { const control=document.createElement('button'); control.textContent=approach==='auto'?'Авто':'Вручную'; control.disabled=Boolean(state.busy); control.onclick=()=>command('task',task.id,approach); row.append(control); }
        choices.append(row);
      }
      button('Модели ИИ','Встроенные модели и проверка запуска',()=>command('models','models'));
      button('Обновить подсказки','Проанализировать текущее состояние',()=>command('refresh','refresh'));
    } else button('Выбрать задачу','Автоматический или ручной сценарий',()=>action({action:'toggle'}));
  }
  api.onState(next=>{ state=next; render(); });
  setInterval(()=>{ dotPhase=(dotPhase+1)%4; dots=[1,2,3,2][dotPhase]; if(state.loading || state.busy) message.textContent=(state.loading?'Подождите, идёт загрузка':'Обрабатываю кадры')+'.'.repeat(dots); },450);
  document.querySelector('#close').onclick=()=>action({action:'dismiss'});
  document.querySelector('#hide').onclick=()=>action({action:'hide'});
  for(const name of ['dragstart','drop','dragover']) document.addEventListener(name,event=>{event.preventDefault();event.stopPropagation();});
  pet.addEventListener('pointerdown',event=>{ if(event.button!==0)return; event.preventDefault(); pet.setPointerCapture(event.pointerId); drag={x:event.screenX,y:event.screenY,moved:false}; suppressClick=false; void action({action:'drag-start',x:event.screenX,y:event.screenY}); });
  pet.addEventListener('pointermove',event=>{ if(!drag)return; if(!drag.moved && Math.hypot(event.screenX-drag.x,event.screenY-drag.y)<5)return; drag.moved=true; pet.classList.add('dragging'); void action({action:'drag-move',x:event.screenX,y:event.screenY}); });
  const end=()=>{if(!drag)return; suppressClick=drag.moved; drag=null; pet.classList.remove('dragging'); void action({action:'drag-end'});};
  pet.addEventListener('pointerup',end); pet.addEventListener('pointercancel',end);
  pet.addEventListener('click',()=>{if(suppressClick){suppressClick=false;return;} void action({action:'toggle'});});
  new ResizeObserver(()=>{ if(document.body.dataset.surface==='bubble') void action({action:'resize',height:document.querySelector('#speech').offsetHeight+14}); }).observe(document.querySelector('#speech'));
  render();
})();
