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

const copilotState = { hidden: false, petPosition: null, panelPosition: null, scenarios: [], bubbleDismissed: true, bubbleSignature: "", bubbleTimer: null, suggestions: [], dismissed: new Set(), timer: null, planKey: null, aiPlan: null };

const copilotPreferenceKey = "spriteLab.copilot";

function loadCopilotPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(copilotPreferenceKey) || "null");
    copilotState.hidden = saved?.hidden === true;
    if (Number.isFinite(saved?.petPosition?.x) && Number.isFinite(saved?.petPosition?.y)) copilotState.petPosition = saved.petPosition;
    if (Number.isFinite(saved?.panelPosition?.x) && Number.isFinite(saved?.panelPosition?.y)) copilotState.panelPosition = saved.panelPosition;
  } catch { /* preferences are optional */ }
}

function saveCopilotPreferences() {
  try { localStorage.setItem(copilotPreferenceKey, JSON.stringify({ hidden: copilotState.hidden, petPosition: copilotState.petPosition, panelPosition: copilotState.panelPosition })); } catch { /* optional */ }
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
    },
    aiPlan: copilotState.aiPlan,
    ui: {
      resultDirty: Boolean(state.resultDirty),
      hasOutputFolder: Boolean(state.outputFolder),
      excludedFrames: state.excludedFrames.size,
      maskEdits: state.maskEdits.length,
      attachments: state.attachments.length,
      tab: document.querySelector(".tab.active")?.dataset.tab || "source", intent: state.intent,
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
  void window.spriteLab.updateCompanion({ busy: Boolean(state.busy), sourceKey: state.source?.sheetPath || (state.source?.paths || []).join("|"), theme: document.documentElement.dataset.theme || 'dark', scenarios: copilotState.scenarios, suggestions: visibleCopilotSuggestions(), tasks }).catch(() => {});
}

async function refreshCopilot() {
  let suggestions = [];
  try {
    if (state.source && typeof autoPilotSourcePaths === "function") {
      const paths = autoPilotSourcePaths();
      const target = autoPilotTarget();
      const key = JSON.stringify({ paths, target, kind: state.source.kind, frames: state.source.estimatedFrames });
      if (paths.length && key !== copilotState.planKey) {
        copilotState.planKey = key;
        copilotState.aiPlan = await window.spriteLab.planAutoPilot({
          paths, target,
          source: { kind: state.source.kind, frameCount: state.result?.allSourceFramePaths?.length || state.source.estimatedFrames || paths.length },
        });
      }
    } else copilotState.aiPlan = null;
    const snapshot = buildCopilotSnapshot();
    const [taskScenarios, hints] = await Promise.all([
      window.spriteLab.suggestScenarios(snapshot),
      window.spriteLab.suggest(snapshot),
    ]);
    window.taskRenderSuggestions?.(taskScenarios);
    copilotState.scenarios = Array.isArray(taskScenarios) ? taskScenarios.map(item => ({ ...item, title: document.querySelector('.copilot-tasks article[data-task="' + item.task + '"] strong')?.textContent || item.task })) : [];
    suggestions = hints;
  } catch {
    suggestions = [];
    copilotState.scenarios = [];
  }
  copilotState.suggestions = Array.isArray(suggestions) ? suggestions : [];
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

function applyCopilotSuggestion(suggestion) {
  if (state.busy || !suggestion) return;
  let rebuild = false;
  for (const step of suggestion.steps || []) {
    if (step.op === "option" || step.op === "check") copilotSetControl(step.control, step.value);
    else if (step.op === "keyMode") setKeyMode(step.value);
    else if (step.op === "anchor") setAnchor(step.value);
    else if (step.op === "loopMode") setLoopMode(step.value);
    else if (step.op === "tab") setTab(step.value);
    else if (step.op === "openConsistency") copilotOpenConsistency();
    else if (step.op === "chooseOutput") { setTab("export"); $("#chooseOutput").click(); }
    else if (step.op === "openModels") { void autoPilotOpenModels(); }
    else if (step.op === "rebuild") rebuild = true;
  }
  copilotState.dismissed.add(suggestion.id);
  setStatus(`Помощник: ${suggestion.title}`, "done", 0);
  if (rebuild && state.source) runBuild(true);
  scheduleCopilot(700);
}

function setCopilotPanel(open) {
  void window.spriteLab.showCompanion({ open }).catch(() => {});
  if (open) void refreshCopilot();
}
window.spriteLab.onCompanionCommand(command => {
  if (state.busy && !['refresh', 'models'].includes(command.kind)) return;
  if (command.kind === 'suggestion') applyCopilotSuggestion(copilotState.suggestions.find(item => item.id === command.id));
  else if (command.kind === 'task') window.taskChoose?.(command.id, command.approach === 'auto' ? 'auto' : 'manual');
  else if (command.kind === 'quick') document.querySelector('[data-quick-task="' + command.id.replace(/[^a-z]/g, '') + '"]')?.click();
  else if (command.kind === 'models') void autoPilotOpenModels();
  else if (command.kind === 'refresh') void refreshCopilot();
});
document.querySelector('#copilotRestore').addEventListener('click', () => setCopilotPanel(true));
new MutationObserver(renderCopilot).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
const copilotBaseSetStatus = setStatus;
setStatus = function copilotObservedSetStatus(...args) {
  const value = copilotBaseSetStatus(...args);
  scheduleCopilot();
  return value;
};
scheduleCopilot(50);
