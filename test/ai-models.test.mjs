import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aiModelCatalog,
  assertDownloadUrl,
  canDownload,
  familyInputSize,
  formatBytes,
  modelById,
  modelFamilies,
  modelFiles,
  modelTotalBytes,
  modelsForTask,
  readSessionShapes,
  rejectedModels,
  runnableModels,
  verificationOf,
} from "../src/ai-models.mjs";

test("every catalogue entry is complete and uniquely named", () => {
  const ids = aiModelCatalog.map((model) => model.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const model of aiModelCatalog) {
    assert.ok(model.name, `${model.id}: нет названия`);
    assert.ok(modelFamilies[model.family], `${model.id}: неизвестная семья ${model.family}`);
    assert.ok(model.tasks.length > 0, `${model.id}: не указаны задачи`);
    assert.ok(["ready", "staged", "manual"].includes(model.readiness), `${model.id}: непонятная готовность`);
    assert.ok(/\.onnx$/.test(model.file), `${model.id}: файл не ONNX`);
    // A size is claimed only where it is known: for a download it must be exact, and for an entry
    // that only points at the official page there is nothing to promise.
    if (model.url || model.bundled) assert.ok(Number.isFinite(model.sizeBytes) && model.sizeBytes > 0, `${model.id}: нет размера`);
    else assert.ok(model.sizeBytes == null, `${model.id}: размер неизвестен и не должен выдумываться`);
    assert.equal(model.licence.commercial, true, `${model.id}: лицензия не разрешает коммерческое использование`);
    assert.ok(model.licence.name, `${model.id}: не указана лицензия`);
    assert.ok(model.note, `${model.id}: нет пояснения`);
  }
});

test("only models that really exist can be downloaded", () => {
  const downloadable = aiModelCatalog.filter((model) => canDownload(model));
  assert.ok(downloadable.length >= 12, "ожидались загружаемые модели");
  for (const model of downloadable) {
    for (const file of modelFiles(model)) {
      assert.equal(assertDownloadUrl(file.url), file.url);
      assert.ok(file.sizeBytes > 0, `${model.id}/${file.file}: нет размера для проверки`);
    }
  }
  // Everything else has to offer the official page instead of a download button.
  for (const model of aiModelCatalog.filter((entry) => !canDownload(entry) && !entry.bundled)) {
    assert.match(model.page, /^https:\/\//, `${model.id}: нет ни файла, ни страницы проекта`);
  }
});

test("a download link is refused when it leads somewhere else", () => {
  assert.throws(() => assertDownloadUrl("http://github.com/x.onnx"), /HTTPS/);
  assert.throws(() => assertDownloadUrl("https://example.com/model.onnx"), /Недоверенный источник/);
  assert.throws(() => assertDownloadUrl("https://github.com/danielgatis/rembg/releases/download/v0.0.0/readme.txt"), /не похожа на файл модели/);
  assert.throws(() => assertDownloadUrl("не ссылка"), /Некорректная ссылка/);
  assert.equal(
    assertDownloadUrl("https://huggingface.co/org/repo/resolve/main/model.onnx"),
    "https://huggingface.co/org/repo/resolve/main/model.onnx",
  );
});

test("a model with several files counts its full size", () => {
  const sam = modelById("mobile-sam");
  assert.equal(modelFiles(sam).length, 2);
  assert.equal(modelTotalBytes(sam), sam.sizeBytes + sam.extraFiles[0].sizeBytes);
});

test("the bundled model needs no download and the ready ones are the runnable ones", () => {
  assert.equal(modelById("u2netp").bundled, true);
  assert.equal(canDownload(modelById("u2netp")), false);
  assert.ok(runnableModels().every((model) => model.readiness === "ready"));
  assert.ok(runnableModels().some((model) => model.id === "isnet-anime"));
  assert.ok(modelsForTask("matting", { onlyRunnable: true }).every((model) => model.tasks.includes("matting")));
  assert.equal(modelsForTask("inpaint").length, 1);
});

test("verification says plainly whether a hash was published or recorded here", () => {
  const published = modelFiles(modelById("vitmatte-small"))[0];
  assert.equal(verificationOf(published).level, "published");
  assert.equal(verificationOf(published).sha256.length, 64);
  assert.equal(verificationOf({ sha256: null }, { recorded: "abc" }).level, "recorded");
  assert.equal(verificationOf({ sha256: null }).level, "size");
});

test("the model file itself decides the input size, with the family as a fallback", () => {
  const arrayStyle = {
    inputNames: ["input"],
    outputNames: ["d0"],
    inputMetadata: [{ name: "input", dimensions: [1, 3, 320, 320] }],
    outputMetadata: [{ name: "d0", dimensions: [1, 1, 320, 320] }],
  };
  assert.deepEqual(readSessionShapes(arrayStyle), {
    inputName: "input",
    outputNames: ["d0"],
    dimensions: [1, 3, 320, 320],
    inputSize: 320,
  });
  const objectStyle = {
    inputNames: ["input_image"],
    outputNames: ["output_image"],
    inputMetadata: { input_image: { type: "float32", dimensions: [1, 3, 1024, 1024] } },
  };
  const shapes = readSessionShapes(objectStyle);
  assert.equal(shapes.inputName, "input_image");
  assert.equal(shapes.inputSize, 1024);
  // Dynamic dimensions carry no size, so the family default is used.
  const dynamic = { inputNames: ["x"], outputNames: ["y"], inputMetadata: { x: { dimensions: [1, 3, -1, -1] } } };
  assert.equal(readSessionShapes(dynamic).inputSize, null);
  assert.equal(familyInputSize("u2net"), 320);
  assert.equal(familyInputSize("birefnet"), 1024);
  assert.equal(familyInputSize("unknown-family"), 320);
});

test("sizes are shown the way a person reads them", () => {
  assert.equal(formatBytes(4574861), "4 МБ");
  assert.equal(formatBytes(224005088), "214 МБ");
  assert.equal(formatBytes(1098928867), "1.02 ГБ");
  assert.equal(formatBytes(0), "0 Б");
});

test("what was refused is refused for a stated reason", () => {
  assert.ok(rejectedModels.length >= 3);
  for (const model of rejectedModels) {
    assert.ok(model.reason.length > 40, `${model.id}: причина не объяснена`);
  }
  const nonCommercial = rejectedModels.filter((model) => /коммерческ|некоммерческ/i.test(model.reason));
  assert.ok(nonCommercial.length >= 2, "отказ по лицензии должен быть назван прямо");
  assert.ok(rejectedModels.some((model) => /эталон/.test(model.reason)), "подмена лица отклонена отдельно");
});
