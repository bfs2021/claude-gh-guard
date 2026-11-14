import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseHostsYml, readGhHosts } from "../src/ghHosts.ts";
import { fakeDeps } from "./helpers.ts";

test("multi-account hosts.yml", () => {
  const yml = "github.com:\n    git_protocol: ssh\n    users:\n        alice:\n            git_protocol: ssh\n        bob-work:\n    user: alice\n";
  assert.deepEqual(parseHostsYml(yml, "github.com"), { active: "alice", logins: ["alice", "bob-work"] });
});
test("old format without users map", () => {
  const yml = "github.com:\n    oauth_token: gho_x\n    user: alice\n    git_protocol: https\n";
  assert.deepEqual(parseHostsYml(yml, "github.com"), { active: "alice", logins: ["alice"] });
});
test("other host ignored, missing host → empty", () => {
  assert.deepEqual(parseHostsYml("ghe.corp:\n    user: bob\n", "github.com"), { active: null, logins: [] });
});
test("readGhHosts reads file or returns null", () => {
  const dir = "/cfg";
  const d = fakeDeps({ env: { GH_CONFIG_DIR: dir }, files: { [path.join(dir, "hosts.yml")]: "github.com:\n    user: a\n" } });
  assert.deepEqual(readGhHosts(d), { active: "a", logins: ["a"], hostsFile: path.join(dir, "hosts.yml") });
  assert.equal(readGhHosts(fakeDeps({ env: { GH_CONFIG_DIR: dir } })), null);
});
