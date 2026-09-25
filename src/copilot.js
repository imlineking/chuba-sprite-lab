/* Chuba Sprite Lab — помощник-питомец.
 *
 * Классический скрипт после studio.js: использует общие глобалы ($, state, setStatus,
 * setTab, setKeyMode, setAnchor, setLoopMode, runBuild) и window.spriteLab.
 *
 * Подсказки считает src/copilot-rules.mjs в основном процессе (IPC copilot:suggest).
 * Так правила остаются чистой тестируемой функцией, а здесь только отрисовка и
 * применение шагов. Шаг, которого нет в словаре правил, молча игнорируется.
 */

// The mascot belongs with window controls, where it never covers the preview or atlas.
document.querySelector(".window-actions").insertBefore($("#copilotPet"), $("#aboutApp"));
document.querySelector(".window-actions").insertBefore($("#copilotRestore"), $("#aboutApp"));

const copilotState = { hidden: false, suggestions: [], dismissed: new Set(), timer: null, planKey: null, aiPlan: null };

const copilotPreferenceKey = "spriteLab.copilot";

function loadCopilotPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(copilotPreferenceKey) || "null");
    copilotState.hidden = saved?.hidden === true;
  } catch { /* preferences are optional */ }
}

function saveCopilotPreferences() {
  try { localStorage.setItem(copilotPreferenceKey, JSON.stringify({ hidden: copilotState.hidden })); } catch { /* optional */ }
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
      tab: document.querySelector(".tab.active")?.dataset.tab || "source",
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
  const pet = $("#copilotPet");
  const visible = visibleCopilotSuggestions();
  $("#copilotRestore").classList.toggle("hidden", !copilotState.hidden);
  pet.classList.toggle("hidden", copilotState.hidden);
  if (copilotState.hidden) {
    $("#copilotPanel").classList.add("hidden");
    return;
  }
  pet.dataset.mood = copilotMood();
  pet.setAttribute("aria-label", visible.length ? `Помощник: подсказок ${visible.length}` : "Помощник");
  const badge = $("#copilotBadge");
  badge.textContent = String(visible.length);
  badge.classList.toggle("hidden", visible.length === 0);
  $("#copilotStatus").textContent = state.busy
    ? "Обрабатываю кадры…"
    : visible.length ? `Подсказок: ${visible.length}` : "Замечаний нет";
  const container = $("#copilotList");
  container.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "copilot-empty";
    empty.textContent = state.source
      ? "Набор выглядит согласованным: критичных замечаний нет."
      : "Добавьте видео или кадры, и я подскажу следующий шаг.";
    container.append(empty);
    return;
  }
  visible.slice(0, 6).forEach((suggestion) => container.append(copilotCard(suggestion)));
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
    suggestions = hints;
  } catch {
    suggestions = [];
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
  $("#copilotPanel").classList.toggle("hidden", !open);
  $("#copilotPet").setAttribute("aria-expanded", String(open));
  if (open) void refreshCopilot();
}

loadCopilotPreferences();
renderCopilot();

$("#copilotPet").addEventListener("click", () => setCopilotPanel($("#copilotPanel").classList.contains("hidden")));
$("#copilotClose").addEventListener("click", () => setCopilotPanel(false));
$("#copilotRefresh").addEventListener("click", () => void refreshCopilot());
$("#copilotHide").addEventListener("click", () => {
  copilotState.hidden = true;
  setCopilotPanel(false);
  saveCopilotPreferences();
  renderCopilot();
  setStatus("Помощник скрыт. Вернуть — кнопкой в верхней панели.", "done", 0);
});
$("#copilotRestore").addEventListener("click", () => {
  copilotState.hidden = false;
  saveCopilotPreferences();
  renderCopilot();
  scheduleCopilot(200);
});

// Every meaningful action already reports itself through setStatus, so that is the one
// place worth observing. The call is debounced: rebuilding suggestions is cheap, but
// doing it on every status message would not be.
const copilotBaseSetStatus = setStatus;
setStatus = function copilotObservedSetStatus(...args) {
  const value = copilotBaseSetStatus(...args);
  if (!copilotState.hidden) scheduleCopilot();
  return value;
};

scheduleCopilot(900);
