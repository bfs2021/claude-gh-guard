import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fakeDeps } from "./helpers.ts";
import { runDoctor } from "../src/commands/doctor.ts";

const HOSTS = `github.com:
    user: alice
    users:
        alice:
        corpUser:
`;
const hostsPath = path.join("/home/test", ".config", "gh", "hosts.yml");
const root = path.resolve("/w/r");
const repoFiles = (url: string) => ({
  [hostsPath]: HOSTS,
  [path.join(root, ".git", "HEAD")]: "ref: refs/heads/main\n",
  [path.join(root, ".git", "config")]: `[remote "origin"]\n\turl = ${url}\n[user]\n\temail = me@x.com\n`,
});
const labels = ["gh config:", "logins:", "active:", "repo:", "remote:", "email:", "push identity:", "expected:", "state:", "time:"];

test("doctor prints every label", () => {
  const d = fakeDeps({ files: repoFiles("git@github.com:alice/x.git") });
  const out = runDoctor(root, d);
  for (const l of labels) assert.ok(out.split("\n").some((x) => x.startsWith(l)), `${l}\n${out}`);
  assert.match(out, /logins:.*alice.*corpUser/);
  assert.match(out, /email:.*me@x\.com.*local/);
  assert.match(out, /expected:.*alice.*owner/);
  assert.match(out, /state:.*MATCH/);
  assert.match(out, /time:.*\d+ ms/);
});

test("doctor AMBIGUOUS prints pin snippet", () => {
  const learned = { "corp/app": { pushers: ["alice", "corpUser"], expected: null, basis: "ambiguous", checkedAt: 0, loginsKey: "alice,corpUser" } };
  const d = fakeDeps({ files: { ...repoFiles("https://github.com/corp/app.git"), [path.join("/home/test", ".claude-gh-guard", "learned.json")]: JSON.stringify(learned) } });
  const out = runDoctor(root, d);
  assert.match(out, /state:.*AMBIGUOUS/);
  assert.match(out, /~\/\.gh-guard\.json/);
  assert.match(out, /"owners": \["corp"\]/);
  assert.match(out, /"ghUser": "alice"/);
});

test("doctor outside a repo", () => {
  const out = runDoctor(path.resolve("/nowhere"), fakeDeps({ files: { [hostsPath]: HOSTS } }));
  assert.match(out, /repo:.*not a git repo/);
  assert.match(out, /state:.*UNTRACKED/);
});
