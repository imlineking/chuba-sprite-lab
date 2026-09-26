const choices = {
  atlasOverflow: ["warn", "scale", "columns", "split"], atlasPacking: ["grid", "tight"],
};
const toggles = new Set(["sheetFitEach", "auxEsrgan", "auxRife", "auxDepth"]);
const enums = { keyMode: ["auto", "alpha", "white", "black", "green", "blue", "ai", "custom"], anchor: ["center", "bottom", "body"], loopMode: ["loop", "range", "pingpong"], tab: ["source", "process", "export"] };
const navigation = new Set(["openConsistency", "openLoopEditor", "chooseOutput", "openModels", "rebuild"]);

export function validateAdvice(steps) {
  if (!Array.isArray(steps) || !steps.length || steps.length > 12) throw new Error("План не содержит допустимых шагов.");
  for (const step of steps) {
    if (!step || typeof step !== "object") throw new Error("Некорректный шаг помощника.");
    if (step.op === "option") {
      const valid = step.control === "fps" ? Number.isFinite(step.value) && step.value >= 1 && step.value <= 60 : choices[step.control]?.includes(step.value);
      if (!valid) throw new Error(`Недопустимая настройка: ${step.control}.`);
    } else if (step.op === "check") {
      if (!toggles.has(step.control) || typeof step.value !== "boolean") throw new Error("Недопустимый переключатель.");
    } else if (enums[step.op]) {
      if (!enums[step.op].includes(step.value)) throw new Error(`Недопустимое значение: ${step.op}.`);
    } else if (!navigation.has(step.op)) throw new Error(`Неизвестный инструмент: ${step.op}.`);
  }
  return steps;
}

// Validate the entire plan before touching the workspace. Only one commit is made.
export async function executeAdvice({ steps, capture, apply, restore, commit }) {
  validateAdvice(steps);
  const before = capture();
  try {
    for (const step of steps) await apply(step);
    await commit(before);
    return before;
  } catch (error) {
    await restore(before);
    throw error;
  }
}
