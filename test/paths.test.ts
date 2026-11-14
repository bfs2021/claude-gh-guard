import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { ghConfigDir, stateDir, cacheDir, claudeSettingsPath } from "../src/paths.ts";
import { fakeDeps } from "./helpers.ts";

test("GH_CONFIG_DIR wins", () => assert.equal(ghConfigDir(fakeDeps({ env: { GH_CONFIG_DIR: "/x" } })), "/x"));
test("win32 uses APPDATA", () => assert.equal(ghConfigDir(fakeDeps({ platform: "win32", env: { APPDATA: "C:\A" } })), path.join("C:\A", "GitHub CLI")));
test("XDG then ~/.config", () => {
  assert.equal(ghConfigDir(fakeDeps({ platform: "linux", env: { XDG_CONFIG_HOME: "/xdg" } })), path.join("/xdg", "gh"));
  assert.equal(ghConfigDir(fakeDeps({ platform: "darwin", env: {}, home: "/h" })), path.join("/h", ".config", "gh"));
});
test("state and cache dirs", () => {
  const d = fakeDeps({ home: "/h", tmpdir: "/t" });
  assert.equal(stateDir(d), path.join("/h", ".claude-gh-guard"));
  assert.equal(cacheDir(d), path.join("/t", "claude-gh-guard"));
});
test("claudeSettingsPath: CLAUDE_CONFIG_DIR wins, else ~/.claude", () => {
  assert.equal(claudeSettingsPath(fakeDeps({ env: { CLAUDE_CONFIG_DIR: "/cc" } })), path.join("/cc", "settings.json"));
  assert.equal(claudeSettingsPath(fakeDeps({ env: {}, home: "/h" })), path.join("/h", ".claude", "settings.json"));
});
