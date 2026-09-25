import assert from "node:assert/strict";
import test from "node:test";
import { formatFeedbackDraft, normalizeFeedback } from "../src/feedback.mjs";

test("an error report can be copied without adding files or a recipient", () => {
  const draft = formatFeedbackDraft({
    kind: "bug",
    subject: "  Край кадра\nобрезан  ",
    message: "После сборки длинная нить обрезается у правого края кадра.",
    filePath: "C:/private/sprite.png",
    email: "private@example.com",
  }, "1.7.0");
  assert.match(draft, /^Ошибка: Край кадра обрезан\n\n/);
  assert.match(draft, /Chuba Sprite Lab 1\.7\.0/);
  assert.doesNotMatch(draft, /private|example\.com/);
});

test("short or invalid drafts are rejected before touching the clipboard", () => {
  assert.throws(() => normalizeFeedback({ kind: "other", subject: "Тема", message: "Подробное описание проблемы" }), /Выберите тип/);
  assert.throws(() => normalizeFeedback({ kind: "idea", subject: "Идея", message: "Коротко" }), /Описание должно/);
  assert.throws(() => normalizeFeedback({ kind: "idea", subject: "Нет", message: "Подробное описание идеи для программы" }), /Тема должна/);
});
