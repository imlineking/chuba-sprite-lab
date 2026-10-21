// «Приёмка»: verdict badge, issues with one-click fixes, and an explicit override.
// Algorithmic checks and an explicit human assessment.
(() => {
  const labels = { accepted: 'Принято', needs_fix: 'Нужны правки', rejected: 'Отклонено' };
  const severityLabels = { error: 'Ошибка', warning: 'Внимание', info: 'Заметка' };
  let current = null;

  function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
  function targetText(target = {}) {
    if (typeof target === 'string') return target;
    if (target.frame) return `кадр ${target.frame}`;
    if (target.animation) return `анимация ${target.animation}${target.frames ? ` · ${target.frames.join(', ')}` : ''}`;
    return 'атлас';
  }
  function fixText(fix) { return Object.entries(fix).filter(([key]) => key !== 'order').map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`).join(' · '); }

  function render(dialog, state) {
    const body = dialog.querySelector('.review-body');
    body.replaceChildren();
    if (state.busy) { body.append(el('p', 'review-muted', state.busy)); return; }
    if (state.error) { body.append(el('p', 'review-error', state.error)); return; }
    const { review, preview, output } = state.result;
    dialog.querySelector('h2').textContent = review.kind === 'png' ? 'Проверка PNG' : 'Приёмка';
    const head = el('div', 'review-head');
    const badge = el('span', `review-badge review-${review.verdict}`, review.kind === 'png' ? review.verdictLabel : labels[review.verdict] || review.verdict);
    const score = el('strong', 'review-score', review.kind === 'png' ? `Файлов: ${review.metrics.length}` : `${review.score}/100`);
    const mode = el('span', 'review-mode');
    mode.append(el('span', null, t('Только алгоритмы')), document.createTextNode(` · ${review.elapsedMs} `), el('span', null, t('мс')));
    head.append(badge, score, mode);
    body.append(head);
    if (review.kind !== 'png') body.append(el('p', 'review-note', t('Результат проверки не заменяет просмотр изображения перед использованием в игре.')));
    if (review.summary) body.append(el('p', 'review-note', review.summary));
    for (const m of Array.isArray(review.metrics) ? review.metrics : []) body.append(el('p', 'review-muted', `${m.file.split(/[\\/]/).pop()} · ${m.width}×${m.height} · прозрачных: ${m.clear} · полупрозрачных: ${m.partial}`));
    if (review.fallbackReason) body.append(el('p', 'review-note', review.fallbackReason));
    if (review.overriddenBy) body.append(el('p', 'review-note', `Принято вручную (было: ${labels[review.overriddenFrom]}).`));
    const grid = el('div', 'review-grid');
    if (preview) { const img = el('img', 'review-preview'); img.src = preview; img.alt = 'Страница атласа: рамки кадров и опоры'; grid.append(img); }
    const list = el('ol', 'review-issues');
    if (!review.issues.length) list.append(el('li', 'review-empty', 'Замечаний нет.'));
    for (const issue of review.issues) {
      const item = el('li', `review-issue review-${issue.severity}`);
      const top = el('div', 'review-issue-top');
      top.append(el('span', 'review-sev', severityLabels[issue.severity] || issue.severity), el('span', 'review-target', targetText(issue.target)), el('span', 'review-source', 'алгоритм'));
      item.append(top, el('p', 'review-reason', issue.reason));
      if (Number.isInteger(issue.target?.frameIndex) && state.result.onInspect) {
        const inspect = el('button', 'review-secondary', 'Показать кадр и участки'); inspect.type = 'button';
        inspect.onclick = () => { dialog.close(); state.result.onInspect(issue); }; item.append(inspect);
        if (state.result.onEdit) { const edit = el('button', 'review-secondary', 'Править маску этого кадра'); edit.type = 'button'; edit.onclick = () => { dialog.close(); state.result.onEdit(issue); }; item.append(edit); }
      }
      if (review.kind !== 'png' && issue.fix && Object.keys(issue.fix).some((key) => key !== 'sortBy' && key !== 'anchor' && key !== 'order')) {
        const fix = el('button', 'review-fix', `Исправить и пересобрать · ${fixText(issue.fix)}`);
        fix.type = 'button';
        fix.onclick = () => run(dialog, () => window.spriteLab.criticApplyFix({ config: state.result.config, fix: issue.fix }), 'Применяю правку и пересобираю…');
        item.append(fix);
      } else if (issue.fix?.order) item.append(el('p', 'review-muted', `Предлагаемый порядок: ${issue.fix.order.join(', ')}`));
      list.append(item);
    }
    grid.append(list);
    body.append(grid);
    if (review.kind !== 'png' && review.artifactId && output) {
      const feedback = el('details', 'review-feedback'); feedback.append(el('summary', null, t('Добавить свою оценку в проверочный набор')));
      feedback.append(el('p', 'review-muted', t('Сохраняются только оценка, причина и отпечаток результата. Изображения не копируются и не отправляются в интернет.')));
      const verdictLabel = el('label', null, t('Ваша оценка')), verdict = el('select'); verdict.setAttribute('aria-label', t('Ваша оценка'));
      for (const [value, text] of [['', 'Выберите оценку'], ['accepted', 'Пригодно для игры'], ['rejected', 'Нужны правки']]) { const option = el('option', null, t(text)); option.value = value; verdict.append(option); }
      verdictLabel.append(verdict);
      const categoryLabel = el('label', null, t('Категория замечания')), category = el('select');
      for (const [value, text] of [['other', 'Другое'], ['background', 'Фон'], ['halo', 'Кайма'], ['grid', 'Сетка'], ['missing_detail', 'Потерянные детали'], ['shape', 'Форма']]) { const option = el('option', null, t(text)); option.value = value; category.append(option); }
      categoryLabel.append(category);
      const reasonLabel = el('label', null, t('Почему вы так оценили')), reason = el('textarea'); reason.maxLength = 400; reason.rows = 2; reasonLabel.append(reason);
      const save = el('button', 'review-secondary', t('Сохранить мою оценку')); save.type = 'button'; const notice = el('p', 'review-muted'); notice.setAttribute('role', 'status');
      save.onclick = async () => {
        save.disabled = true;
        try { await window.spriteLab.criticFeedback({ output, token: review.feedbackToken, verdict: verdict.value, reason: reason.value, category: category.value }); notice.textContent = t('Оценка сохранена в проверочный набор.'); }
        catch (error) { notice.textContent = error.message; }
        finally { save.disabled = false; }
      };
      feedback.append(verdictLabel, categoryLabel, reasonLabel, save, notice); body.append(feedback);
    }
    const footer = dialog.querySelector('.review-actions');
    footer.replaceChildren();
    const again = el('button', 'review-secondary', 'Проверить снова'); again.type = 'button';
    again.onclick = () => run(dialog, () => window.spriteLab.criticReview({ config: state.result.config }), 'Проверяю…');
    if (review.kind !== 'png') footer.append(again);
    if (review.kind !== 'png' && review.verdict !== 'accepted' && output && !review.issues.some((i) => i.code === 'build_failed')) {
      const accept = el('button', 'review-secondary', 'Принять всё равно'); accept.type = 'button';
      accept.onclick = async () => { try { current.result = { ...current.result, review: await window.spriteLab.criticAcceptAnyway({ output, review }) }; render(dialog, current); } catch (error) { current.error = error.message; render(dialog, current); } };
      footer.append(accept);
    }
    const close = el('button', 'review-primary', 'Закрыть'); close.type = 'button'; close.onclick = () => dialog.close();
    footer.append(close);
  }

  async function run(dialog, call, busy) {
    current = { ...current, busy, error: null }; render(dialog, current);
    try { current = { result: await call(), busy: null, error: null }; } catch (error) { current = { ...current, busy: null, error: error.message }; }
    render(dialog, current);
  }

  window.renderReviewPanel = (result) => {
    const dialog = el('dialog', 'review-panel');
    dialog.append(el('h2', null, 'Приёмка'), el('div', 'review-body'), el('div', 'review-actions'));
    dialog.onclose = () => dialog.remove();
    document.body.append(dialog);
    current = { result, busy: null, error: null };
    render(dialog, current);
    return dialog;
  };

  window.openReviewPanel = async () => {
    const folder = await window.spriteLab.criticPickFolder();
    if (!folder) return;
    const dialog = el('dialog', 'review-panel');
    dialog.append(el('h2', null, 'Приёмка'), el('div', 'review-body'), el('div', 'review-actions'));
    dialog.onclose = () => dialog.remove();
    document.body.append(dialog); dialog.showModal();
    current = { result: null };
    await run(dialog, () => window.spriteLab.criticReview({ input: folder }), 'Собираю атлас и проверяю…');
  };
})();
