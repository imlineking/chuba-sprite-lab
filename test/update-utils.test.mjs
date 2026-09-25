import assert from "node:assert/strict";
import test from "node:test";
import { assertGitHubDownloadUrl, compareVersions, parseSha256 } from "../src/update-utils.mjs";

test("version comparison handles release tags", () => {
  assert.equal(compareVersions("v1.2.2", "1.2.1"), 1);
  assert.equal(compareVersions("1.2.1", "v1.2.1"), 0);
  assert.equal(compareVersions("1.1.9", "1.2.0"), -1);
});

test("updater accepts only trusted GitHub HTTPS hosts", () => {
  assert.match(assertGitHubDownloadUrl("https://github.com/imlineking/chuba-sprite-lab/releases/download/v1/file.exe"), /^https:/);
  assert.match(assertGitHubDownloadUrl("https://release-assets.githubusercontent.com/file"), /^https:/);
  assert.throws(() => assertGitHubDownloadUrl("http://github.com/file.exe"), /недопустимый/i);
  assert.throws(() => assertGitHubDownloadUrl("https://github.com.example.org/file.exe"), /недопустимый/i);
});

test("SHA-256 parser rejects malformed release metadata", () => {
  const hash = "a".repeat(64);
  assert.equal(parseSha256(`${hash}  Chuba-Sprite-Lab-portable.exe`), hash);
  assert.throws(() => parseSha256("not-a-checksum"), /неверный формат/i);
});
