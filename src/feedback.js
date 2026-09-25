(() => {
  const key = "spriteLab.feedbackDraft";
  const modal = document.querySelector("#feedbackModal");
  const subject = document.querySelector("#feedbackSubject");
  const message = document.querySelector("#feedbackMessage");
  const status = document.querySelector("#feedbackStatus");
  let kind = "bug";
  let returnTarget = null;

  function showStatus(text, error = false) {
    status.textContent = text;
    status.classList.toggle("error", error);
  }

  function selectKind(value) {
    kind = value === "idea" ? "idea" : "bug";
    modal.querySelectorAll("[data-kind]").forEach((button) => {
      const selected = button.dataset.kind === kind;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  }

  function saveDraft() {
    try {
      localStorage.setItem(key, JSON.stringify({ kind, subject: subject.value, message: message.value }));
      showStatus("Черновик сохранён на этом компьютере.");
    } catch {
      showStatus("Не удалось сохранить черновик. Скопируйте текст перед закрытием.", true);
    }
  }

  function restoreDraft() {
    try {
      const draft = JSON.parse(localStorage.getItem(key) || "null");
      if (!draft || typeof draft !== "object") return;
      selectKind(draft.kind);
      subject.value = typeof draft.subject === "string" ? draft.subject.slice(0, 120) : "";
      message.value = typeof draft.message === "string" ? draft.message.slice(0, 4000) : "";
    } catch { /* A damaged local draft should not prevent opening the form. */ }
  }

  function openFeedback(preferredKind = "idea", errorText = "") {
    const fromAbout = !document.querySelector("#aboutModal").classList.contains("hidden");
    returnTarget = fromAbout ? document.querySelector("#aboutApp") : document.activeElement;
    if (fromAbout) closeAbout();
    const preservedDraft = Boolean(subject.value.trim() || message.value.trim());
    if (!preservedDraft) selectKind(errorText ? "bug" : preferredKind);
    if (errorText) {
      if (!preservedDraft) {
        subject.value = "Ошибка при работе с файлом";
        message.value = `Сообщение программы: ${errorText}\n\nШаги для повторения: `.slice(0, 4000);
        saveDraft();
      }
    }
    setModalOpen(modal, true, subject, returnTarget);
    if (errorText && preservedDraft) showStatus("Есть сохранённый черновик. Очистите его, чтобы начать сообщение об ошибке.");
  }

  function closeFeedback() {
    setModalOpen(modal, false, null, returnTarget);
    returnTarget = null;
  }

  restoreDraft();
  window.openFeedback = openFeedback;
  window.closeFeedback = closeFeedback;
  document.querySelector("#openFeedback").addEventListener("click", () => openFeedback("idea"));
  document.querySelector("#reportError").addEventListener("click", () => openFeedback("bug", document.querySelector("#errorText").textContent.trim()));
  document.querySelector("#closeFeedback").addEventListener("click", closeFeedback);
  modal.addEventListener("click", (event) => { if (event.target === modal) closeFeedback(); });
  modal.querySelector("#feedbackKind").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-kind]");
    if (!button) return;
    selectKind(button.dataset.kind);
    saveDraft();
  });
  subject.addEventListener("input", saveDraft);
  message.addEventListener("input", saveDraft);
  document.querySelector("#clearFeedback").addEventListener("click", () => {
    subject.value = "";
    message.value = "";
    selectKind("bug");
    try { localStorage.removeItem(key); } catch { /* The visible form is still cleared. */ }
    showStatus("Черновик очищен.");
    subject.focus();
  });
  document.querySelector("#copyFeedback").addEventListener("click", async () => {
    try {
      const result = await window.spriteLab.copyFeedback({ kind, subject: subject.value, message: message.value });
      if (!result.ok) { showStatus(result.error || "Не удалось скопировать текст.", true); return; }
      showStatus("Текст скопирован. Отправка из программы пока не подключена.");
    } catch (error) {
      showStatus(error?.message || "Не удалось скопировать текст.", true);
    }
  });
})();
