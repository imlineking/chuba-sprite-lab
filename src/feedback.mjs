export const feedbackKinds = { bug: "Ошибка", idea: "Предложение" };

export function normalizeFeedback(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Заполните форму обратной связи.");
  const kind = String(value.kind || "");
  const subject = String(value.subject || "").trim().replace(/[\r\n]+/g, " ");
  const message = String(value.message || "").trim();
  if (!Object.hasOwn(feedbackKinds, kind)) throw new Error("Выберите тип сообщения.");
  if (subject.length < 4 || subject.length > 120) throw new Error("Тема должна содержать от 4 до 120 символов.");
  if (message.length < 20 || message.length > 4000) throw new Error("Описание должно содержать от 20 до 4000 символов.");
  return { kind, subject, message };
}

export function formatFeedbackDraft(value, version) {
  const feedback = normalizeFeedback(value);
  return `${feedbackKinds[feedback.kind]}: ${feedback.subject}\n\n${feedback.message}\n\n---\nChuba Sprite Lab ${String(version || "").slice(0, 32)}\n`;
}
