// Apply the saved theme before the window paints; keep this script independent of the renderer.
(() => {
  const storageKey = "spriteLab.theme";
  const system = window.matchMedia("(prefers-color-scheme: light)");
  let saved = null;
  try { saved = localStorage.getItem(storageKey); } catch { /* Storage can be unavailable. */ }
  const theme = saved === "dark" || saved === "light" ? saved : system.matches ? "light" : "dark";
  document.documentElement.dataset.theme = theme;

  function updateButton() {
    const button = document.querySelector("#themeToggle");
    if (!button) return;
    const light = document.documentElement.dataset.theme === "light";
    button.setAttribute("aria-pressed", String(light));
    button.setAttribute("aria-label", light ? "Включить тёмную тему" : "Включить светлую тему");
    button.title = light ? "Тёмная тема" : "Светлая тема";
  }

  document.addEventListener("DOMContentLoaded", () => {
    const button = document.querySelector("#themeToggle");
    button?.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem(storageKey, next); } catch { /* Visual choice still applies. */ }
      updateButton();
    });
    updateButton();
  });

  system.addEventListener("change", (event) => {
    try { if (localStorage.getItem(storageKey)) return; } catch { /* Use system theme. */ }
    document.documentElement.dataset.theme = event.matches ? "light" : "dark";
    updateButton();
  });
})();
