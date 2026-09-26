// Apply saved appearance before the first paint. Both themes share markup and layout.
(() => {
  const storageKey = "spriteLab.theme", motionKey = "spriteLab.shellMotion";
  const system = matchMedia("(prefers-color-scheme: light)");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const store = (key, value) => { try { localStorage.setItem(key, value); } catch { /* Appearance remains usable without storage. */ } };
  const saved = read(storageKey);
  document.documentElement.dataset.theme = ["dark", "light"].includes(saved) ? saved : system.matches ? "light" : "dark";
  document.documentElement.dataset.shellMotion = read(motionKey) === "off" || reduced.matches ? "off" : "on";

  function update() {
    const label = source => typeof t === "function" ? t(source) : source;
    const light = document.documentElement.dataset.theme === "light";
    const button = document.querySelector("#themeToggle");
    if (button) {
      button.setAttribute("aria-pressed", String(light));
      button.setAttribute("aria-label", label(light ? "Включить тёмную тему Призма" : "Включить светлую тему Фарфор"));
      button.title = label(light ? "Тёмная тема · Призма" : "Светлая тема · Фарфор");
    }
    document.querySelectorAll("[data-appearance-theme]").forEach(node => node.setAttribute("aria-pressed", String(node.dataset.appearanceTheme === document.documentElement.dataset.theme)));
    const motion = document.querySelector("#appearanceMotion");
    if (motion) {
      motion.checked = document.documentElement.dataset.shellMotion === "on" && !reduced.matches;
      motion.disabled = reduced.matches;
      const hint = document.querySelector("#appearanceMotionHint");
      if (hint) hint.textContent = label(reduced.matches ? "Движение отключено в настройках доступности системы" : "Переходы разделов и раскрытие меню");
    }
  }
  function choose(theme, persist = true) {
    if (!["dark", "light"].includes(theme)) return;
    document.documentElement.dataset.theme = theme;
    if (persist) store(storageKey, theme);
    update();
    document.dispatchEvent(new CustomEvent("spriteLab:appearance", { detail: { theme } }));
  }
  document.addEventListener("DOMContentLoaded", () => {
    document.querySelector("#themeToggle")?.addEventListener("click", () => choose(document.documentElement.dataset.theme === "light" ? "dark" : "light"));
    document.querySelectorAll("[data-appearance-theme]").forEach(button => button.addEventListener("click", () => choose(button.dataset.appearanceTheme)));
    document.querySelector("#appearanceMotion")?.addEventListener("change", event => {
      const mode = event.target.checked ? "on" : "off";
      store(motionKey, mode); document.documentElement.dataset.shellMotion = mode; update();
      document.dispatchEvent(new CustomEvent("spriteLab:appearance", { detail: { motion: mode } }));
    });
    update();
  });
  system.addEventListener("change", event => { if (!["dark", "light"].includes(read(storageKey))) choose(event.matches ? "light" : "dark", false); });
  reduced.addEventListener("change", () => { document.documentElement.dataset.shellMotion = reduced.matches || read(motionKey) === "off" ? "off" : "on"; update(); });
  window.spriteLabAppearance = Object.freeze({ choose, update });
})();
