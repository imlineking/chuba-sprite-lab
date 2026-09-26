// Workbench effects only. A transition never delays navigation, focuses a control,
// touches asset pixels or changes the standalone companion's behaviour.
(() => {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const animations = new Map();
  const deck = document.querySelector(".control-deck");
  const curtains = document.createElement("div");
  curtains.className = "shell-curtains";
  curtains.setAttribute("aria-hidden", "true");
  curtains.append(...Array.from({ length: 6 }, () => document.createElement("i")));
  deck.append(curtains);

  function enabled() { return !reduced.matches && document.documentElement.dataset.shellMotion !== "off"; }
  function cancel() {
    for (const animation of animations.values()) animation.cancel();
    animations.clear();
  }
  function cancelWithin(root) {
    for (const [node, animation] of animations) {
      if (node === root || root.contains(node)) { animation.cancel(); animations.delete(node); }
    }
  }
  function animate(node, frames, options = {}) {
    animations.get(node)?.cancel();
    if (!enabled() || !node?.animate) return;
    const animation = node.animate(frames, { duration: 250, easing: "cubic-bezier(.22,.8,.24,1)", ...options });
    animations.set(node, animation);
    animation.finished.then(() => { if (animations.get(node) === animation) animations.delete(node); }).catch(() => {});
  }
  function reveal(node) {
    if (!enabled()) return;
    if (node.matches(".modal-backdrop")) {
      animate(node, [{ opacity: 0 }, { opacity: 1 }], { duration: 180 });
      const card = node.querySelector(":scope > article");
      if (card) animate(card, [{ opacity: 0, transform: "translateY(12px) scale(.98)", clipPath: "inset(0 0 6% 0 round 19px)" }, { opacity: 1, transform: "none", clipPath: "inset(0 round 19px)" }], { duration: 320 });
    } else {
      animate(node, [{ opacity: 0, transform: "translateY(7px) scale(.975)" }, { opacity: 1, transform: "none" }], { duration: 230 });
      node.querySelectorAll(":scope > button").forEach((button, i) => animate(button, [{ opacity: 0, transform: "translateY(5px)" }, { opacity: 1, transform: "none" }], { delay: i * 22, duration: 180 }));
    }
  }
  function transition(panel) {
    cancelWithin(deck);
    if (!enabled() || !panel) return;
    curtains.querySelectorAll("i").forEach((strip, i) => animate(strip,
      [{ transform: "scaleY(0)" }, { transform: "scaleY(.98)", offset: .32 }, { transform: "scaleY(0)" }],
      { duration: 420, delay: i * 16 }));
    animate(panel, [{ opacity: .15, transform: "translateY(9px)" }, { opacity: 1, transform: "none" }], { duration: 360 });
  }
  const observer = new MutationObserver(records => {
    for (const record of records) {
      const node = record.target;
      if (node.classList.contains("hidden") || (record.attributeName === "open" && !node.open)) { cancelWithin(node); continue; }
      if (record.attributeName === "open") {
        if (node.open) node.querySelectorAll(":scope > :not(summary)").forEach(child => animate(child, [{ opacity: 0, transform: "translateY(-5px)" }, { opacity: 1, transform: "none" }], { duration: 220 }));
      } else if (!node.classList.contains("hidden") && String(record.oldValue).split(/\s+/).includes("hidden")) reveal(node);
    }
  });
  document.querySelectorAll(".modal-backdrop, .backdrop-menu, .transform-panel, .tool-details, .advanced-panel, .export-details, .about-hotkeys").forEach(node => observer.observe(node, { attributes: true, attributeOldValue: true, attributeFilter: ["class", "open"] }));
  document.addEventListener("spriteLab:appearance", () => {
    cancel();
    if (enabled()) animate(document.querySelector("#appShell"), [{ opacity: .88 }, { opacity: 1 }], { duration: 160 });
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) cancel(); });
  reduced.addEventListener("change", cancel);
  window.addEventListener("pagehide", () => { cancel(); observer.disconnect(); });
  window.spriteLabShellMotion = Object.freeze({ transition, cancel });
})();
