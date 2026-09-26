/* Chuba Sprite Lab — помощник-питомец.
 *
 * Классический скрипт после studio.js: использует общие глобалы ($, state, setStatus,
 * setTab, setKeyMode, setAnchor, setLoopMode, runBuild) и window.spriteLab.
 *
 * Подсказки считает src/copilot-rules.mjs в основном процессе (IPC copilot:suggest).
 * Так правила остаются чистой тестируемой функцией, а здесь только отрисовка и
 * применение шагов. Шаг, которого нет в словаре правил, молча игнорируется.
 */

// The mascot is a movable companion, independent of the workbench layout.
document.querySelector(".window-actions").insertBefore($("#copilotRestore"), $("#aboutApp"));
document.querySelectorAll('#copilotRestore img, #copilotPet img, #copilotPanel img').forEach(image => {
  image.draggable = false;
  image.addEventListener('dragstart', event => { event.preventDefault(); event.stopPropagation(); });
});
$("#copilotRestore").title = "Открыть помощника на рабочем столе";

const copilotState = { hidden: false, petPosition: null, panelPosition: null, scenarios: [], bubbleDismissed: true, bubbleSignature: "", bubbleTimer: null, suggestions: [], dismissed: new Set(), timer: null, planKey: null, aiPlan: null, error: null, errorOrigin: null, applying: false, lastAdvice: null, planner: "rules", semanticKey: null, semanticPlan: null, comparing: false, refreshing: false, plannerStatus: null };

const copilotPreferenceKey = "spriteLab.copilot";

function loadCopilotPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(copilotPreferenceKey) || "null");
    copilotState.hidden = saved?.hidden === true;
    if (["rules", "qwen", "gemma"].includes(saved?.planner)) copilotState.planner = saved.planner;
    if (Number.isFinite(saved?.petPosition?.x) && Number.isFinite(saved?.petPosition?.y)) copilotState.petPosition = saved.petPosition;
    if (Number.isFinite(saved?.panelPosition?.x) && Number.isFinite(saved?.panelPosition?.y)) copilotState.panelPosition = saved.panelPosition;
  } catch { /* preferences are optional */ }
}

function saveCopilotPreferences() {
  try { localStorage.setItem(copilotPreferenceKey, JSON.stringify({ hidden: copilotState.hidden, petPosition: copilotState.petPosition, panelPosition: copilotState.panelPosition, planner: copilotState.planner })); } catch { /* optional */ }
}

function buildCopilotSnapshot() {
  const source = state.source;
  const result = state.result;
  let options = {};
  try { options = collectOptions(); } catch { options = {}; }
  return {
    source: source ? {
      kind: source.kind,
      estimatedFrames: Number(source.estimatedFrames) || 0,
      opaqueImages: Number(source.opaqueImages) || 0,
      mixedSizes: Boolean(source.mixedSizes),
      suggestedKeyMode: source.suggestedKeyMode || "auto",
      maskPrepared: Boolean(source.maskPrepared),
      frameCount: source.paths?.length || 0,
    } : null,
    built: result ? {
      frameCount: result.frameCount,
      cellWidth: result.cellWidth,
      cellHeight: result.cellHeight,
      columns: result.columns,
      rows: result.rows,
      warnings: result.warnings || [],
      frameIssues: result.frameIssues || [],
      issues: result.issues || [],
      atlasIssues: result.atlasIssues || [],
      atlas: result.atlas ? { ...result.atlas } : null,
      skipped: result.skipped ? { ...result.skipped } : null,
    } : null,
    options: {
      keyMode: options.keyMode,
      fps: options.fps,
      packing: options.packing,
      atlasMaxSize: options.atlasMaxSize,
      atlasOverflow: options.atlasOverflow,
      exportFormat: options.exportFormat,
      fitEachFrame: Boolean(options.fitEachFrame),
      auxAI: options.auxAI,
      pixelPerfect: Boolean(options.pixelPerfect),
      loopMode: options.loopMode,
    },
    aiPlan: copilotState.aiPlan,
    ui: {
      resultDirty: Boolean(state.resultDirty),
      hasOutputFolder: Boolean(state.outputFolder),
      excludedFrames: state.excludedFrames.size,
      maskEdits: state.maskEdits.length,
      attachments: state.attachments.length,
      tab: document.querySelector(".tab.active")?.dataset.tab || "source", intent: state.intent, goal: window.taskCurrent?.() || null,
    },
  };
}

function visibleCopilotSuggestions() {
  return copilotState.suggestions.filter((suggestion) => !copilotState.dismissed.has(suggestion.id));
}

function copilotMood() {
  if (state.busy) return "busy";
  return visibleCopilotSuggestions().length ? "hint" : "idle";
}

function copilotCard(suggestion) {
  const card = document.createElement("article");
  card.className = `copilot-card${suggestion.severity === "warn" ? " warn" : ""}`;
  const title = document.createElement("strong");
  title.textContent = suggestion.title;
  const why = document.createElement("p");
  why.textContent = suggestion.why;
  const effect = document.createElement("small");
  effect.textContent = suggestion.effect;
  const actions = document.createElement("div");
  actions.className = "copilot-card-actions";
  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "button primary";
  apply.textContent = "Применить";
  apply.disabled = state.busy;
  apply.addEventListener("click", () => applyCopilotSuggestion(suggestion));
  const skip = document.createElement("button");
  skip.type = "button";
  skip.className = "button ghost";
  skip.textContent = "Не сейчас";
  skip.title = "Скрыть подсказку до перезапуска";
  skip.addEventListener("click", () => {
    copilotState.dismissed.add(suggestion.id);
    renderCopilot();
  });
  actions.append(apply, skip);
  card.append(title, why, effect, actions);
  return card;
}

function renderCopilot() {
  document.querySelector('#copilotRestore').classList.remove('hidden');
  const tasks = [...document.querySelectorAll('.copilot-tasks article')].map(card => ({ id: card.dataset.task, title: card.querySelector('strong').textContent }));
  const undoAdvice = copilotState.lastAdvice && copilotState.lastAdvice.index === state.historyIndex && copilotState.lastAdvice.source === state.source ? copilotState.lastAdvice.title : null;
  const workLabel = copilotState.comparing ? 'Сравниваю планы' : copilotState.refreshing ? 'Подбираю сценарии' : copilotState.applying ? 'Применяю совет' : 'Выполняю задачу';
  void window.spriteLab.updateCompanion({ busy: Boolean(state.busy || copilotState.applying || copilotState.comparing || copilotState.refreshing), workLabel, planner: copilotState.planner, plannerStatus: copilotState.plannerStatus, plannerInfo: copilotState.semanticPlan ? `${copilotState.semanticPlan.fallback ? 'Резерв: лёгкий' : copilotState.semanticPlan.model || 'Лёгкий'} · ${Math.round(copilotState.semanticPlan.elapsedMs)} мс` : 'Локальный анализ', error: copilotState.error, undoAdvice, sourceKey: state.source?.sheetPath || (state.source?.paths || []).join("|"), theme: document.documentElement.dataset.theme || 'dark', scenarios: copilotState.scenarios, suggestions: visibleCopilotSuggestions(), tasks }).catch(error => { console.error('Помощник: связь с окном', error); });
}

async function refreshCopilot() {
  if (copilotState.applying || copilotState.comparing || copilotState.refreshing) return;
  copilotState.refreshing = true;
  const sourceAtStart = state.source;
  const controlsAtStart = JSON.stringify(collectOptions());
  const goalAtStart = window.taskCurrent?.();
  const resultAtStart = state.result;
  let suggestions = [];
  try {
    if (state.source && typeof autoPilotSourcePaths === "function") {
      const paths = autoPilotSourcePaths();
      const target = autoPilotTarget();
      const key = JSON.stringify({ paths, target, kind: state.source.kind, frames: state.source.estimatedFrames });
      if (paths.length && key !== copilotState.planKey) {
        copilotState.aiPlan = await window.spriteLab.planAutoPilot({
          paths, target,
          source: { kind: state.source.kind, maskPrepared: Boolean(state.source.maskPrepared), frameCount: state.result?.allSourceFramePaths?.length || state.source.estimatedFrames || paths.length },
        });
        if (copilotState.aiPlan.measurements?.failures?.length) throw new Error(`Не удалось прочитать контрольные кадры: ${copilotState.aiPlan.measurements.failures.map(item => item.message).join('; ')}`);
        copilotState.planKey = key;
      }
    } else copilotState.aiPlan = null;
    const snapshot = buildCopilotSnapshot();
    let [taskScenarios, hints] = await Promise.all([
      window.spriteLab.suggestScenarios(snapshot),
      window.spriteLab.suggest(snapshot),
    ]);
    if (copilotState.errorOrigin !== 'action') copilotState.error = null;
    if (copilotState.planner !== 'rules' && state.source) {
      const key = JSON.stringify({ planner: copilotState.planner, snapshot });
      if (key !== copilotState.semanticKey) {
        copilotState.semanticPlan = await window.spriteLab.planCopilot({ planner: copilotState.planner, snapshot, paths: autoPilotSourcePaths() });
        copilotState.semanticKey = key;
      }
      taskScenarios = copilotState.semanticPlan.scenarios;
      // Measured safety warnings always remain visible, even if a model overlooks them.
      if (copilotState.semanticPlan.error) copilotState.error = `Модель не сработала: ${copilotState.semanticPlan.error} Используется лёгкий помощник.`;
    } else copilotState.semanticPlan = null;
    if (sourceAtStart !== state.source || resultAtStart !== state.result || controlsAtStart !== JSON.stringify(collectOptions()) || goalAtStart !== window.taskCurrent?.()) { copilotState.scenarios = []; copilotState.suggestions = []; scheduleCopilot(50); return; }
    window.taskRenderSuggestions?.(taskScenarios);
    copilotState.scenarios = Array.isArray(taskScenarios) ? taskScenarios.map(item => ({ ...item, title: document.querySelector('.copilot-tasks article[data-task="' + item.task + '"] strong')?.textContent || item.task })) : [];
    suggestions = hints;
  } catch (error) {
    copilotReportError(error, 'analysis');
    suggestions = [];
    copilotState.scenarios = [];
  } finally { copilotState.refreshing = false; renderCopilot(); }
  copilotState.suggestions = Array.isArray(suggestions) ? suggestions : [];
  renderCopilot();
}

async function compareCopilotPlanners() {
  if (!state.source || state.busy || copilotState.comparing) return;
  copilotState.comparing = true; renderCopilot();
  const dialog = document.createElement('dialog'); dialog.className = 'planner-comparison';
  const heading = document.createElement('h2'); heading.textContent = 'Сравнение копилотов на текущих файлах';
  const detail = document.createElement('p'); detail.textContent = 'Один снимок задачи и файлов для всех трёх планировщиков. Планы не применяются; модели работают последовательно и локально.';
  const close = document.createElement('button'); close.textContent = 'Закрыть'; close.onclick = () => dialog.close();
  const results = document.createElement('div'); results.className = 'planner-results'; results.textContent = 'Сравниваю лёгкого помощника, Qwen и Gemma…';
  dialog.append(heading, detail, results, close); dialog.onclose = () => dialog.remove(); document.body.append(dialog); dialog.showModal();
  try {
    const plans = await window.spriteLab.compareCopilots({ snapshot: buildCopilotSnapshot(), paths: autoPilotSourcePaths() });
    results.replaceChildren();
    for (const plan of plans) {
      const card = document.createElement('article'); const title = document.createElement('h3');
      title.textContent = `${plan.model || (plan.requestedPlanner ? plan.requestedPlanner + ' → лёгкий' : 'Лёгкий помощник')} · ${Math.round(plan.elapsedMs)} мс`;
      card.append(title);
      if (plan.error) { const error = document.createElement('p'); error.textContent = plan.error; card.append(error); }
      for (const item of plan.scenarios.slice(0, 3)) { const line = document.createElement('p'); line.textContent = `${document.querySelector('.copilot-tasks article[data-task="' + item.task + '"] strong')?.textContent || item.task}: ${item.why}`; card.append(line); }
      results.append(card);
    }
  } catch (error) { results.textContent = error.message; copilotReportError(error); }
  finally { copilotState.comparing = false; renderCopilot(); }
}

function copilotReportError(error, origin = 'action') {
  copilotState.errorOrigin = origin;
  copilotState.error = `Помощник не завершил действие: ${error.message || error}. Можно повторить; правка доступна вручную.`;
  void window.spriteLab.logError(copilotState.error).catch(() => {});
  renderCopilot();
}

function scheduleCopilot(delay = 450) {
  clearTimeout(copilotState.timer);
  copilotState.timer = setTimeout(() => { void refreshCopilot(); }, delay);
}

function copilotSetControl(controlId, value) {
  const control = $(`#${controlId}`);
  if (!control) return false;
  if (control.type === "checkbox") control.checked = Boolean(value);
  else control.value = String(value);
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function copilotOpenConsistency() {
  setTab("process");
  const panel = $("#consistencyPanel");
  if (panel) panel.open = true;
  panel?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  $("#analyzeFrameSizes").click();
}

async function applyCopilotSuggestion(suggestion) {
  if (state.busy || copilotState.applying || !suggestion) return;
  const oldResult = state.result;
  clearTimeout(state.historyTimer);
  pushHistory("До совета помощника");
  const beforeIndex = state.historyIndex;
  copilotState.applying = true;
  state.adviceApplying = true; updateActionState();
  state.historyApplying = true;
  renderCopilot();
  try {
    const { executeAdvice } = await import('./copilot-actions.mjs');
    await executeAdvice({ steps: suggestion.steps, capture: () => captureHistoryState("До совета помощника"), apply: async step => {
    if (step.op === "option" || step.op === "check") copilotSetControl(step.control, step.value);
    else if (step.op === "keyMode") setKeyMode(step.value);
    else if (step.op === "anchor") setAnchor(step.value);
    else if (step.op === "loopMode") setLoopMode(step.value);
    else if (step.op === "tab") setTab(step.value);
    else if (step.op === "openConsistency") copilotOpenConsistency();
    else if (step.op === "openLoopEditor") { setTab("process"); $("#loopMode").scrollIntoView({ block: "center", behavior: "smooth" }); }
    else if (step.op === "chooseOutput") { setTab("export"); $("#chooseOutput").click(); }
    else if (step.op === "openModels") { void autoPilotOpenModels(); }
    else if (step.op === "rebuild" && state.source) { if (!await runBuild(true)) throw new Error("Не удалось собрать предпросмотр. Настройки восстановлены."); }
    }, restore: snapshot => { applyHistorySnapshot(snapshot); if (oldResult) updatePreview(oldResult); }, commit: () => {
      state.historyApplying = false;
      pushHistory(`Помощник: ${suggestion.title}`);
      if (state.historyIndex > beforeIndex) copilotState.lastAdvice = { title: suggestion.title, id: suggestion.id, index: state.historyIndex, source: state.source, result: oldResult };
    } });
  copilotState.error = null;
  copilotState.dismissed.add(suggestion.id);
  setStatus(`Помощник: ${suggestion.title}`, "done", 0);
  } catch (error) { copilotReportError(error); }
  finally { state.historyApplying = false; state.adviceApplying = false; copilotState.applying = false; updateActionState(); renderCopilot(); }
  scheduleCopilot(700);
}

function setCopilotPanel(open) {
  void window.spriteLab.showCompanion({ open }).catch(() => {});
  if (open) void refreshCopilot();
  if (open) void window.spriteLab.copilotPlannerStatus().then(status => { copilotState.plannerStatus = status; renderCopilot(); }).catch(error => copilotReportError(error, 'analysis'));
}
window.spriteLab.onCompanionCommand(command => {
  if (state.busy && !['refresh', 'models'].includes(command.kind)) return;
  if (command.kind === 'suggestion') applyCopilotSuggestion(copilotState.suggestions.find(item => item.id === command.id));
  else if (command.kind === 'task') window.taskChoose?.(command.id, command.approach === 'auto' ? 'auto' : 'manual');
  else if (command.kind === 'quick') document.querySelector('[data-quick-task="' + command.id.replace(/[^a-z]/g, '') + '"]')?.click();
  else if (command.kind === 'models') void autoPilotOpenModels();
  else if (command.kind === 'refresh') { copilotState.errorOrigin = null; void refreshCopilot(); }
  else if (command.kind === 'compare-planners') void compareCopilotPlanners();
  else if (command.kind === 'planner' && ['rules', 'qwen', 'gemma'].includes(command.id)) { copilotState.planner = command.id; copilotState.semanticKey = null; saveCopilotPreferences(); void refreshCopilot(); }
  else if (command.kind === 'undo-advice') {
    const advice = copilotState.lastAdvice;
    if (advice && advice.source === state.source && advice.index === state.historyIndex) {
      undoWorkspace(); if (advice.result) updatePreview(advice.result);
      copilotState.dismissed.delete(advice.id); copilotState.lastAdvice = null; renderCopilot();
    }
  }
});
document.querySelector('#copilotRestore').addEventListener('click', () => setCopilotPanel(true));
new MutationObserver(renderCopilot).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
const copilotBaseSetStatus = setStatus;
setStatus = function copilotObservedSetStatus(...args) {
  const value = copilotBaseSetStatus(...args);
  scheduleCopilot();
  return value;
};
loadCopilotPreferences();
scheduleCopilot(50);
