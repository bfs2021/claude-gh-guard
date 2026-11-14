import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fakeDeps } from "../test/helpers.ts";
import { gatherFacts } from "../src/gather.ts";

const HOSTS = `github.com:
    user: alice
    users:
        alice:
        corpUser:
`;
const hostsPath = path.join("/home/test", ".config", "gh", "hosts.yml");

function repoFiles(url: string, extra: Record<string, string> = {}) {
  return {
    [hostsPath]: HOSTS,
    [path.join(path.resolve("/w/r"), ".git", "HEAD")]: "ref: refs/heads/main\n",
    [path.join(path.resolve("/w/r"), ".git", "config")]: `[remote "origin"]\n\turl = ${url}\n`,
    ...extra,
  };
}
const learnedPath = path.join("/home/test", ".claude-gh-guard", "learned.json");

test("owner login resolves expected, no learn needed", () => {
  const d = fakeDeps({ files: repoFiles("git@github.com:alice/x.git") });
  const r = gatherFacts("/w/r", d, { allowSpawn: false });
  assert.equal(r.facts.expected?.login, "alice");
  assert.equal(r.facts.remoteName, "origin");
  assert.equal(r.needsLearn, null);
  assert.ok(r.repo);
});

test("unknown org without learned entry needs learn", () => {
  const d = fakeDeps({ files: repoFiles("https://github.com/corp/app.git") });
  const r = gatherFacts("/w/r", d, { allowSpawn: false });
  assert.deepEqual(r.needsLearn, { owner: "corp", repo: "app" });
  assert.equal(r.facts.expected?.source, "none");
});

test("fresh learned entry is used; stale one triggers learn", () => {
  const entry = { pushers: ["corpUser"], expected: "corpUser", basis: "single", checkedAt: 0, loginsKey: "alice,corpUser" };
  let d = fakeDeps({ files: repoFiles("https://github.com/corp/app.git", { [learnedPath]: JSON.stringify({ "corp/app": entry }) }) });
  let r = gatherFacts("/w/r", d, { allowSpawn: false });
  assert.equal(r.facts.expected?.login, "corpUser");
  assert.equal(r.needsLearn, null);

  d = fakeDeps({
    now: () => 10 * 86400000,
    files: repoFiles("https://github.com/corp/app.git", { [learnedPath]: JSON.stringify({ "corp/app": entry }) }),
  });
  r = gatherFacts("/w/r", d, { allowSpawn: false });
  assert.equal(r.facts.expected?.login, null);
  assert.deepEqual(r.needsLearn, { owner: "corp", repo: "app" });
});

test("learned entry naming a login we no longer have is ignored", () => {
  const entry = { pushers: ["gone"], expected: "gone", basis: "single", checkedAt: 0, loginsKey: "alice,corpUser" };
  const d = fakeDeps({ files: repoFiles("https://github.com/corp/app.git", { [learnedPath]: JSON.stringify({ "corp/app": entry }) }) });
  const r = gatherFacts("/w/r", d, { allowSpawn: false });
  assert.equal(r.facts.expected?.login, null);
  assert.deepEqual(r.needsLearn, { owner: "corp", repo: "app" });
});

test("no repo -> null remote, remoteName origin or override", () => {
  const d = fakeDeps({ files: { [hostsPath]: HOSTS } });
  const r = gatherFacts("/nowhere", d, { allowSpawn: false, remoteName: "up" });
  assert.equal(r.repo, null);
  assert.equal(r.facts.remote, null);
  assert.equal(r.facts.remoteName, "up");
  assert.equal(r.needsLearn, null);
});

test("non-github host never needs learn", () => {
  const d = fakeDeps({ files: repoFiles("https://gitlab.com/corp/app.git") });
  assert.equal(gatherFacts("/w/r", d, { allowSpawn: false }).needsLearn, null);
});

const sshCachePath = path.join("/home/test", ".claude-gh-guard", "ssh.json");

test("status line: core.sshCommand in repo config → push unknown despite a cached ssh login", () => {
  const cache = { [sshCachePath]: JSON.stringify({ "github.com": { login: "alice", key: 0 } }) };
  let d = fakeDeps({ files: repoFiles("git@github.com:corp/app.git", cache) });
  assert.deepEqual(gatherFacts("/w/r", d, { allowSpawn: false }).facts.push, { via: "ssh", login: "alice" });
  const cfgPath = path.join(path.resolve("/w/r"), ".git", "config");
  d = fakeDeps({
    files: {
      ...repoFiles("git@github.com:corp/app.git", cache),
      [cfgPath]: `[remote "origin"]\n\turl = git@github.com:corp/app.git\n[core]\n\tsshCommand = ssh -i k\n`,
    },
  });
  assert.deepEqual(gatherFacts("/w/r", d, { allowSpawn: false }).facts.push, { via: "unknown" });
});

test("status line: GIT_SSH_COMMAND env → push unknown", () => {
  const cache = { [sshCachePath]: JSON.stringify({ "github.com": { login: "alice", key: 0 } }) };
  const d = fakeDeps({ env: { GIT_SSH_COMMAND: "ssh -i k" }, files: repoFiles("git@github.com:corp/app.git", cache) });
  assert.deepEqual(gatherFacts("/w/r", d, { allowSpawn: false }).facts.push, { via: "unknown" });
});

test("status line honors remote.<name>.pushurl from the repo config", () => {
  const cfgPath = path.join(path.resolve("/w/r"), ".git", "config");
  const d = fakeDeps({
    files: {
      ...repoFiles("x"),
      [cfgPath]: `[remote "origin"]\n\turl = https://github.com/corp/app.git\n\tpushurl = git@github.com:corp/app.git\n`,
    },
  });
  const f = gatherFacts("/w/r", d, { allowSpawn: false }).facts;
  assert.equal(f.remote?.protocol, "ssh");
  assert.equal(f.push?.via, "ssh");
});

test("hook path resolves the push URL with git remote get-url --push, falling back to config", () => {
  const calls: string[] = [];
  let resolved: string | null = "git@github.com:corp/app.git\n";
  const d = fakeDeps({
    files: repoFiles("https://github.com/corp/app.git"),
    exec: (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      if (cmd === "git" && args.join(" ") === "remote get-url --push origin" && resolved !== null) {
        return { code: 0, stdout: resolved, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    },
  });
  assert.equal(gatherFacts("/w/r", d, { allowSpawn: true }).facts.remote?.protocol, "ssh");
  assert.ok(calls.includes("git remote get-url --push origin"));
  resolved = null;
  assert.equal(gatherFacts("/w/r", d, { allowSpawn: true }).facts.remote?.protocol, "https");
  // commit-only gathers (skipPush) keep the configured fetch URL
  resolved = "git@github.com:corp/app.git\n";
  assert.equal(gatherFacts("/w/r", d, { allowSpawn: true, skipPush: true }).facts.remote?.protocol, "https");
});
