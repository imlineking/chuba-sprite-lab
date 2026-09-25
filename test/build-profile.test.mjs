import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadProfileFile, profileFormat, profileVersion, readProfile } from "../src/build-profile.mjs";
import { exportFormats } from "../src/processor.mjs";

const baseDir = path.resolve(os.tmpdir(), "chuba-profile-base");

function profile(overrides = {}) {
  return {
    format: profileFormat,
    version: profileVersion,
    name: "chuba-run",
    source: { kind: "frames", paths: ["frames/a.png", "frames/b.png"] },
    options: { keyMode: "white", fps: 12 },
    ...overrides,
  };
}

test("a valid profile resolves relative paths against the profile folder", () => {
  const parsed = readProfile(profile({ outputDir: "out" }), { baseDir });
  assert.equal(parsed.name, "chuba-run");
  assert.equal(parsed.outputDir, path.resolve(baseDir, "out"));
  assert.deepEqual(parsed.animations.map((animation) => animation.name), ["chuba-run"]);
  assert.equal(parsed.animations[0].source.kind, "frames");
  assert.deepEqual(parsed.animations[0].source.paths, [path.resolve(baseDir, "frames/a.png"), path.resolve(baseDir, "frames/b.png")]);
  assert.deepEqual(parsed.animations[0].options, { keyMode: "white", fps: 12 });
});

test("a mistyped option is rejected instead of silently ignored", () => {
  assert.throws(() => readProfile(profile({ options: { keymode: "white" } }), { baseDir }), /keymode: неизвестная настройка/);
  assert.throws(() => readProfile(profile({ options: { exports: { sprite: true } } }), { baseDir }), /exports\.sprite: неизвестный формат/);
});

test("structural problems are reported together", () => {
  const broken = { format: "wrong", version: 9, source: { kind: "song", paths: [] }, options: "nope" };
  assert.throws(() => readProfile(broken, { baseDir }), (error) => {
    for (const fragment of ['format: ожидается', "version: поддерживается только 1", "source.kind: ожидается одно из", "source.paths: нужен непустой", "options: ожидался объект", "name: укажите имя набора"]) {
      assert.ok(error.message.includes(fragment), `missing: ${fragment}\n${error.message}`);
    }
    return true;
  });
});

test("enum values are validated", () => {
  assert.throws(() => readProfile(profile({ options: { keyMode: "magic" } }), { baseDir }), /keyMode: ожидается одно из/);
  assert.throws(() => readProfile(profile({ options: { exportFormat: "cocos" } }), { baseDir }), /exportFormat: ожидается одно из/);
  assert.throws(() => readProfile(profile({ options: { loopMode: "spin" } }), { baseDir }), /loopMode: ожидается одно из/);
  assert.throws(() => readProfile(profile({ options: { aiQuality: "maximum" } }), { baseDir }), /aiQuality: ожидается одно из/);
  // Every engine format the exporter knows must validate, so the list cannot drift from the code.
  for (const format of exportFormats) {
    assert.doesNotThrow(() => readProfile(profile({ options: { exportFormat: format } }), { baseDir }), `${format} must be accepted`);
  }
});

test("named animations override the shared options", () => {
  const parsed = readProfile(profile({
    animations: [
      { name: "idle", source: { kind: "frames", paths: ["idle/a.png"] } },
      { name: "run", source: { kind: "frames", paths: ["run/a.png"] }, options: { fps: 24 } },
    ],
  }), { baseDir });
  assert.deepEqual(parsed.animations.map((animation) => animation.name), ["idle", "run"]);
  assert.equal(parsed.animations[0].options.fps, 12);
  assert.equal(parsed.animations[1].options.fps, 24);
  assert.equal(parsed.animations[1].options.keyMode, "white");
});

test("a manual sheet needs frames and manual mode needs boxes", () => {
  assert.throws(() => readProfile(profile({ source: { kind: "sheet", paths: ["sheet.png"], sheetOptions: { mode: "manual", cells: [] } } }), { baseDir }), /sheetOptions\.cells: для режима manual/);
  const parsed = readProfile(profile({ source: { kind: "sheet", paths: ["sheet.png"], sheetOptions: { mode: "manual", cells: [{ left: 0, top: 0, width: 32, height: 32 }] } } }), { baseDir });
  assert.deepEqual(parsed.animations[0].source.paths, [path.resolve(baseDir, "sheet.png")]);
  assert.deepEqual(parsed.animations[0].source.sheetOptions.cells, [{ left: 0, top: 0, width: 32, height: 32 }]);
});

test("loading a file resolves paths relative to that file", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-profile-"));
  const file = path.join(temp, "build.json");
  await fs.writeFile(file, JSON.stringify(profile({ outputDir: "out" })), "utf8");
  const loaded = await loadProfileFile(file);
  assert.equal(loaded.path, file);
  assert.equal(loaded.profile.animations[0].source.paths[0], path.join(temp, "frames", "a.png"));

  const broken = path.join(temp, "broken.json");
  await fs.writeFile(broken, "{ not json", "utf8");
  await assert.rejects(() => loadProfileFile(broken), /не является корректным JSON/);
  await assert.rejects(() => loadProfileFile(path.join(temp, "missing.json")), /Не удалось прочитать профиль/);
});

test("a custom background colour is validated and normalised", () => {
  const parsed = readProfile(profile({ options: { keyMode: "custom", keyColor: [200, 180, "160"] } }), { baseDir });
  assert.deepEqual(parsed.animations[0].options.keyColor, [200, 180, 160]);
  assert.throws(() => readProfile(profile({ options: { keyColor: [300, 0, 0] } }), { baseDir }), /keyColor: ожидался массив/);
  assert.throws(() => readProfile(profile({ options: { keyColor: "white" } }), { baseDir }), /keyColor: ожидался массив/);
  assert.throws(() => readProfile(profile({ options: { keyColor: [1, 2] } }), { baseDir }), /keyColor: ожидался массив/);
});

test("every path in a profile resolves against the profile folder", () => {
  const parsed = readProfile(profile({
    options: {
      frameOverrides: { "3": "edits/frame-3.png" },
      attachments: [{ id: "a1", path: "png/bow.png", points: [] }, { id: "a2", enabled: false }],
    },
  }), { baseDir });
  assert.equal(parsed.animations[0].options.frameOverrides["3"], path.resolve(baseDir, "edits/frame-3.png"));
  assert.equal(parsed.animations[0].options.attachments[0].path, path.resolve(baseDir, "png/bow.png"));
  assert.equal(parsed.animations[0].options.attachments[1].path, undefined);

  assert.throws(() => readProfile(profile({ options: { frameOverrides: { "0": 5 } } }), { baseDir }), /frameOverrides\.0: ожидался путь/);
  assert.throws(() => readProfile(profile({ options: { attachments: [{ id: "a", path: " " }] } }), { baseDir }), /attachments\[0\]\.path: ожидался путь/);
});

test("a profile that would export nothing is rejected", () => {
  assert.throws(
    () => readProfile(profile({ options: { exports: { sheet: false, frames: false, metadata: false, preview: false } } }), { baseDir }),
    /выберите хотя бы один формат/,
  );
  // An empty exports object means "use the defaults", not "export nothing".
  assert.doesNotThrow(() => readProfile(profile({ options: { exports: {} } }), { baseDir }));
});

test("a batch of videos cannot be mixed with other animations", () => {
  const batch = { kind: "video", paths: ["a.mp4", "b.mp4"] };
  assert.doesNotThrow(() => readProfile(profile({ source: batch }), { baseDir }));
  assert.throws(() => readProfile(profile({
    animations: [{ name: "one", source: batch }, { name: "two", source: { kind: "frames", paths: ["x.png"] } }],
  }), { baseDir }), /пакет из нескольких видео/);
});
