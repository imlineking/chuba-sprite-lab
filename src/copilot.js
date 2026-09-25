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
    $("#copilotBubble").classList.add("hidden");
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
  renderCopilotBubble();
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
    copilotState.scenarios = Array.isArray(taskScenarios) ? taskScenarios : [];
    suggestions = hints;
  } catch {
    suggestions = [];
    copilotState.scenarios = [];
  }
  copilotState.suggestions = Array.isArray(suggestions) ? suggestions : [];
  const signature = JSON.stringify([copilotState.scenarios.slice(0, 2).map((item) => item.task), copilotState.suggestions.slice(0, 2).map((item) => item.id)]);
  if (signature !== copilotState.bubbleSignature) {
    copilotState.bubbleSignature = signature;
    copilotState.bubbleDismissed = !copilotState.scenarios.length && !copilotState.suggestions.length;
    clearTimeout(copilotState.bubbleTimer);
    if (!copilotState.bubbleDismissed) copilotState.bubbleTimer = setTimeout(() => { copilotState.bubbleDismissed = true; renderCopilotBubble(); }, 8500);
  }
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
  const panel = $("#copilotPanel");
  panel.classList.toggle("hidden", !open);
  $("#copilotPet").setAttribute("aria-expanded", String(open));
  if (open) positionCopilot(copilotState.panelPosition);
  renderCopilotBubble();
  if (open) void refreshCopilot();
}

function positionCopilot(position) {
  const panel = $("#copilotPanel");
  const width = panel.offsetWidth || 336;
  const height = panel.offsetHeight || 420;
  const pet = $("#copilotPet").getBoundingClientRect();
  const requestedX = Number.isFinite(position?.x) ? position.x : pet.left - width - 12;
  const requestedY = Number.isFinite(position?.y) ? position.y : pet.bottom - height;
  const x = Math.max(8, Math.min(requestedX, window.innerWidth - width - 8));
  const y = Math.max(48, Math.min(requestedY, window.innerHeight - height - 42));
  panel.style.left = `${x}px`;
  panel.style.top = `${y}px`;
  panel.style.right = "auto";
  panel.style.bottom = "auto";
  copilotState.panelPosition = { x, y };
}

function positionPet(position) {
  const pet = $("#copilotPet");
  const width = pet.offsetWidth || 76;
  const height = pet.offsetHeight || 76;
  const requestedX = Number.isFinite(position?.x) ? position.x : window.innerWidth - width - 18;
  const requestedY = Number.isFinite(position?.y) ? position.y : 52;
  const x = Math.max(6, Math.min(requestedX, window.innerWidth - width - 6));
  const y = Math.max(46, Math.min(requestedY, window.innerHeight - height - 42));
  pet.style.left = `${x}px`;
  pet.style.top = `${y}px`;
  pet.style.right = "auto";
  pet.style.bottom = "auto";
  copilotState.petPosition = { x, y };
  positionCopilotBubble();
}

function positionCopilotBubble() {
  const bubble = $("#copilotBubble");
  if (bubble.classList.contains("hidden")) return;
  const pet = $("#copilotPet").getBoundingClientRect();
  const width = bubble.offsetWidth || 255;
  const height = bubble.offsetHeight || 65;
  const left = pet.left >= width + 14 ? pet.left - width - 8 : pet.right + 8;
  bubble.dataset.side = pet.left >= width + 14 ? "left" : "right";
  bubble.style.left = `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`;
  bubble.style.top = `${Math.max(48, Math.min(pet.top, window.innerHeight - height - 42))}px`;
}

function renderCopilotBubble() {
  const bubble = $("#copilotBubble");
  const visible = !copilotState.hidden && !copilotState.bubbleDismissed && $("#copilotPanel").classList.contains("hidden");
  bubble.classList.toggle("hidden", !visible);
  if (!visible) return;
  const actions = $("#copilotBubbleActions");
  actions.replaceChildren();
  const scenarios = copilotState.scenarios.slice(0, 2);
  if (scenarios.length) {
    for (const scenario of scenarios) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `Предлагаю: ${$(".copilot-tasks article[data-task='" + scenario.task + "'] > strong")?.textContent || scenario.task}`;
      button.title = scenario.why;
      button.addEventListener("click", () => { copilotState.bubbleDismissed = true; window.taskChoose?.(scenario.task, "auto"); renderCopilotBubble(); });
      actions.append(button);
    }
  } else if (visibleCopilotSuggestions().length) {
    for (const suggestion of visibleCopilotSuggestions().slice(0, 2)) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `Предлагаю: ${suggestion.title}`;
      button.title = suggestion.effect;
      button.addEventListener("click", () => { copilotState.bubbleDismissed = true; applyCopilotSuggestion(suggestion); renderCopilotBubble(); });
      actions.append(button);
    }
  } else {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Что хотите сделать? Выберите задачу";
    button.addEventListener("click", () => setCopilotPanel(true));
    actions.append(button);
  }
  positionCopilotBubble();
}

$("#copilotPanel > header").addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || event.target.closest("button")) return;
  const panel = $("#copilotPanel");
  const rect = panel.getBoundingClientRect();
  const offsetX = event.clientX - rect.left;
  const offsetY = event.clientY - rect.top;
  panel.classList.add("dragging");
  positionCopilot({ x: rect.left, y: rect.top });
  event.currentTarget.setPointerCapture(event.pointerId);
  const move = (moveEvent) => positionCopilot({ x: moveEvent.clientX - offsetX, y: moveEvent.clientY - offsetY });
  const stop = () => {
    panel.classList.remove("dragging");
    event.currentTarget.removeEventListener("pointermove", move);
    event.currentTarget.removeEventListener("pointerup", stop);
    event.currentTarget.removeEventListener("pointercancel", stop);
    saveCopilotPreferences();
  };
  event.currentTarget.addEventListener("pointermove", move);
  event.currentTarget.addEventListener("pointerup", stop);
  event.currentTarget.addEventListener("pointercancel", stop);
});
let ignorePetClick = false;
$("#copilotPet").addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  const pet = event.currentTarget;
  const origin = { x: event.clientX, y: event.clientY };
  const initial = pet.getBoundingClientRect();
  let moved = false;
  pet.setPointerCapture(event.pointerId);
  const move = (next) => {
    if (!moved && Math.hypot(next.clientX - origin.x, next.clientY - origin.y) < 5) return;
    moved = true;
    pet.classList.add("dragging");
    positionPet({ x: initial.left + next.clientX - origin.x, y: initial.top + next.clientY - origin.y });
  };
  const stop = () => {
    pet.removeEventListener("pointermove", move);
    pet.removeEventListener("pointerup", stop);
    pet.removeEventListener("pointercancel", stop);
    pet.classList.remove("dragging");
    if (moved) { ignorePetClick = true; saveCopilotPreferences(); }
  };
  pet.addEventListener("pointermove", move);
  pet.addEventListener("pointerup", stop);
  pet.addEventListener("pointercancel", stop);
});
$("#copilotBubbleClose").addEventListener("click", () => { copilotState.bubbleDismissed = true; renderCopilotBubble(); });
window.addEventListener("resize", () => {
  positionPet(copilotState.petPosition);
  if (!$("#copilotPanel").classList.contains("hidden")) positionCopilot(copilotState.panelPosition);
});

loadCopilotPreferences();
positionPet(copilotState.petPosition);
renderCopilot();

$("#copilotPet").addEventListener("click", () => { if (ignorePetClick) { ignorePetClick = false; return; } setCopilotPanel($("#copilotPanel").classList.contains("hidden")); });
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
