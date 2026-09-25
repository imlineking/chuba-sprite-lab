import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import sharp from "sharp";
import { profileFormat, profileVersion } from "../src/build-profile.mjs";

const cliPath = path.resolve("scripts", "cli.mjs");

async function makeFrame(filePath) {
  const sprite = await sharp({ create: { width: 20, height: 24, channels: 4, background: { r: 225, g: 86, b: 18, alpha: 1 } } }).png().toBuffer();
  await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .composite([{ input: sprite, left: 22, top: 30 }]).png().toFile(filePath);
}

async function prepareProfile() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "chuba-cli-"));
  await fs.mkdir(path.join(temp, "in"), { recursive: true });
  await makeFrame(path.join(temp, "in", "frame-0.png"));
  await makeFrame(path.join(temp, "in", "frame-1.png"));
  const profilePath = path.join(temp, "build.json");
  await fs.writeFile(profilePath, JSON.stringify({
    format: profileFormat,
    version: profileVersion,
    name: "cli-run",
    outputDir: "out",
    source: { kind: "frames", paths: ["in/frame-0.png", "in/frame-1.png"] },
    options: {
      keyMode: "white", anchor: "ground", autoSize: true, autoColumns: true,
      padding: 8, removeDuplicates: false, outputBackground: "transparent",
      exports: { sheet: true, frames: true, metadata: true, preview: false },
    },
  }), "utf8");
  return { temp, profilePath, outputDir: path.join(temp, "out") };
}

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { cwd: path.resolve("."), encoding: "utf8" });
}

test("the command line builds a set from a profile", async () => {
  const { profilePath, outputDir } = await prepareProfile();
  const run = runCli(["--profile", profilePath, "--json"]);
  assert.equal(run.status, 0, run.stderr);
  const summary = JSON.parse(run.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.frameCount, 2);
  assert.equal(summary.outputDir, path.join(outputDir, "cli-run"));
  assert.ok(existsSync(summary.manifest), "the manifest must exist");
  assert.ok(summary.sheets.every((sheet) => existsSync(sheet)));
  assert.ok(summary.frames.every((frame) => existsSync(frame)));
  const manifest = JSON.parse(await fs.readFile(summary.manifest, "utf8"));
  assert.equal(manifest.frameCount, 2);
  assert.ok(manifest.frames.every((frame) => frame.hitboxSpace === "cell"));
});

test("--dry-run validates without writing anything", async () => {
  const { profilePath, outputDir } = await prepareProfile();
  const run = runCli(["--profile", profilePath, "--dry-run", "--json"]);
  assert.equal(run.status, 0, run.stderr);
  const summary = JSON.parse(run.stdout);
  assert.equal(summary.dryRun, true);
  assert.equal(summary.sources[0].frames, 2);
  assert.equal(existsSync(outputDir), false, "a dry run must not create the output folder");
});

test("a recipe with the window's keying, model, edge and toning controls builds in CLI", async () => {
  const { profilePath } = await prepareProfile();
  const recipe = JSON.parse(await fs.readFile(profilePath, "utf8"));
  Object.assign(recipe.options, {
    keyScope: "exterior",
    aiModel: "u2netp",
    edgeRefine: { mode: "recolor", width: 1, depth: 2, whiteOnly: true },
    toning: { color: "#8bb8ff", strength: 35 },
  });
  await fs.writeFile(profilePath, JSON.stringify(recipe), "utf8");
  const run = runCli(["--profile", profilePath, "--json"]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).ok, true);
});

test("the exit code separates usage problems from build failures", async () => {
  const missing = runCli(["--json"]);
  assert.equal(missing.status, 1);
  assert.ok(missing.stderr.includes("--profile"));

  const unknown = runCli(["--nope"]);
  assert.equal(unknown.status, 1);
  assert.ok(unknown.stderr.includes("Неизвестная опция"));

  const { temp } = await prepareProfile();
  const brokenProfile = path.join(temp, "broken.json");
  await fs.writeFile(brokenProfile, JSON.stringify({ format: profileFormat, version: profileVersion, name: "x", source: { kind: "frames", paths: [] }, options: {} }), "utf8");
  const invalid = runCli(["--profile", brokenProfile, "--json"]);
  assert.equal(invalid.status, 1);
  assert.ok(invalid.stderr.includes("Профиль сборки отклонён"));

  const impossible = path.join(temp, "impossible.json");
  await fs.writeFile(impossible, JSON.stringify({
    format: profileFormat, version: profileVersion, name: "gone", outputDir: "out2",
    source: { kind: "frames", paths: ["in/missing-frame.png"] }, options: {},
  }), "utf8");
  const failed = runCli(["--profile", impossible, "--json"]);
  assert.equal(failed.status, 2);
  assert.equal(JSON.parse(failed.stdout).ok, false);
});

test("an existing set is never overwritten without an explicit flag", async () => {
  const { profilePath, outputDir } = await prepareProfile();
  const first = runCli(["--profile", profilePath, "--json"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).name, "cli-run");

  const repeat = runCli(["--profile", profilePath, "--json"]);
  assert.equal(repeat.status, 1);
  assert.ok(repeat.stderr.includes("уже существует"), repeat.stderr);
  assert.ok(repeat.stderr.includes("--clean"));
  assert.ok(repeat.stderr.includes("--version"));

  const cleaned = runCli(["--profile", profilePath, "--clean", "--json"]);
  assert.equal(cleaned.status, 0, cleaned.stderr);
  assert.equal(JSON.parse(cleaned.stdout).name, "cli-run");

  const versioned = runCli(["--profile", profilePath, "--version", "--json"]);
  assert.equal(versioned.status, 0, versioned.stderr);
  assert.equal(JSON.parse(versioned.stdout).name, "cli-run-2");
  assert.ok(existsSync(path.join(outputDir, "cli-run-2", "cli-run-2.json")));

  const both = runCli(["--profile", profilePath, "--clean", "--version"]);
  assert.equal(both.status, 1);
  assert.ok(both.stderr.includes("несовместимы"));
});

test("--strict accepts a healthy set and never fires on its own", async () => {
  const { profilePath } = await prepareProfile();
  const strict = runCli(["--profile", profilePath, "--strict", "--json"]);
  assert.equal(strict.status, 0, strict.stderr);
  assert.equal(JSON.parse(strict.stdout).ok, true);
});

test("--watch is accepted and a dry run still returns immediately", async () => {
  const { profilePath } = await prepareProfile();
  const run = runCli(["--profile", profilePath, "--watch", "--dry-run", "--json"]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).dryRun, true);
});
