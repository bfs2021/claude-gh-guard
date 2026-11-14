import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pushIdentity, parseSshHello } from "../src/pushIdentity.ts";
import type { Remote } from "../src/remote.ts";
import type { Repo } from "../src/gitRepo.ts";
import type { GhHosts } from "../src/ghHosts.ts";
import { fakeDeps } from "./helpers.ts";

const repo = { workTree: path.resolve("/w"), config: new Map() } as Repo;
const hosts: GhHosts = { active: "alice", logins: ["alice"], hostsFile: "h" };
const sshRemote: Remote = { protocol: "ssh", host: "github.com", sshAlias: "github.com-work", owner: "o", repo: "r" };
const httpsRemote: Remote = { protocol: "https", host: "GitHub.com", sshAlias: null, owner: "o", repo: "r" };
const HELLO = "Hi alice! You've successfully authenticated, but GitHub does not provide shell access.";

test("parseSshHello", () => {
  assert.equal(parseSshHello(HELLO), "alice");
  assert.equal(parseSshHello("Permission denied"), null);
});

test("ssh remote: hook path probes ssh -T on alias every time and refreshes the cache", () => {
  const calls: string[][] = [];
  const d = fakeDeps({
    exec: (cmd, args) => { calls.push([cmd, ...args]); return { code: 1, stdout: "", stderr: HELLO }; },
  });
  assert.deepEqual(pushIdentity(sshRemote, repo, hosts, d, { allowSpawn: true }), { via: "ssh", login: "alice" });
  const ssh = calls.filter((c) => c[0] === "ssh");
  assert.equal(ssh.length, 1);
  assert.deepEqual(ssh[0], ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=3", "git@github.com-work"]);
  assert.deepEqual(pushIdentity(sshRemote, repo, hosts, d, { allowSpawn: true }), { via: "ssh", login: "alice" });
  assert.equal(calls.filter((c) => c[0] === "ssh").length, 2);
  // the status line (no spawning) reads what the hook cached
  assert.deepEqual(pushIdentity(sshRemote, repo, hosts, d, { allowSpawn: false }), { via: "ssh", login: "alice" });
  assert.equal(calls.filter((c) => c[0] === "ssh").length, 2);
});

test("hook path ignores a stale cache: cached personal, agent now offers work", () => {
  let who = "alice";
  const d = fakeDeps({ exec: (cmd) => (cmd === "ssh" ? { code: 1, stdout: "", stderr: `Hi ${who}!` } : { code: 1, stdout: "", stderr: "" }) });
  pushIdentity(sshRemote, repo, hosts, d, { allowSpawn: true });
  who = "workUser";
  assert.deepEqual(pushIdentity(sshRemote, repo, hosts, d, { allowSpawn: true }), { via: "ssh", login: "workUser" });
  assert.deepEqual(pushIdentity(sshRemote, repo, hosts, d, { allowSpawn: false }), { via: "ssh", login: "workUser" });
});

test("hook path: failed probe returns null even with a cached login", () => {
  let ok = true;
  const d = fakeDeps({
    exec: (cmd) => (cmd === "ssh" && ok ? { code: 1, stdout: "", stderr: HELLO } : { code: 255, stdout: "", stderr: "timeout" }),
  });
  pushIdentity(sshRemote, repo, hosts, d, { allowSpawn: true });
  ok = false;
  assert.deepEqual(pushIdentity(sshRemote, repo, hosts, d, { allowSpawn: true }), { via: "ssh", login: null });
});

test("status-line ssh cache invalidated when ~/.ssh/config mtime changes", () => {
  let m = 100;
  const cfg = path.join("/home/test", ".ssh", "config");
  const d = fakeDeps({
    files: { [cfg]: "x" },
    mtime: (p) => (path.normalize(p) === path.normalize(cfg) ? m : null),
    exec: () => ({ code: 1, stdout: "", stderr: HELLO }),
  });
  pushIdentity(sshRemote, repo, hosts, d, { allowSpawn: true });
  assert.deepEqual(pushIdentity(sshRemote, repo, hosts, d, { allowSpawn: false }), { via: "ssh", login: "alice" });
  m = 200;
  assert.deepEqual(pushIdentity(sshRemote, repo, hosts, d, { allowSpawn: false }), { via: "ssh", login: null });
});

test("allowSpawn false + no cache → login null; failed ssh not cached", () => {
  let n = 0;
  const d = fakeDeps({ exec: (cmd) => { if (cmd === "ssh") n++; return { code: 255, stdout: "", stderr: "timeout" }; } });
  assert.deepEqual(pushIdentity(sshRemote, repo, hosts, d, { allowSpawn: false }), { via: "ssh", login: null });
  assert.equal(n, 0);
  assert.deepEqual(pushIdentity(sshRemote, repo, hosts, d, { allowSpawn: true }), { via: "ssh", login: null });
  assert.deepEqual(pushIdentity(sshRemote, repo, hosts, d, { allowSpawn: false }), { via: "ssh", login: null });
  assert.equal(n, 1);
});

test("allowSpawn false uses fresh cache; corrupt cache treated as empty", () => {
  const d = fakeDeps({ exec: () => ({ code: 1, stdout: "", stderr: HELLO }) });
  pushIdentity(sshRemote, repo, hosts, d, { allowSpawn: true });
  assert.deepEqual(pushIdentity(sshRemote, repo, hosts, d, { allowSpawn: false }), { via: "ssh", login: "alice" });
  const bad = fakeDeps({ files: { [path.join("/home/test", ".claude-gh-guard", "ssh.json")]: "{nope" } });
  assert.deepEqual(pushIdentity(sshRemote, repo, hosts, bad, { allowSpawn: false }), { via: "ssh", login: null });
});

test("custom ssh command in repo config → unknown (status line and hook)", () => {
  const calls: string[] = [];
  const r = { ...repo, config: new Map([["core.sshcommand", ["ssh -i ~/.ssh/work"]]]) } as Repo;
  const d = fakeDeps({ exec: (cmd) => { calls.push(cmd); return { code: 1, stdout: "", stderr: HELLO }; } });
  // cache a login first so the status line would otherwise report it
  pushIdentity(sshRemote, repo, hosts, d, { allowSpawn: true });
  calls.length = 0;
  assert.deepEqual(pushIdentity(sshRemote, r, hosts, d, { allowSpawn: false }), { via: "unknown" });
  assert.equal(calls.length, 0);
  const h = fakeDeps({
    exec: (cmd, args) => {
      calls.push(cmd);
      if (cmd === "git" && args.join(" ") === "config core.sshCommand") return { code: 0, stdout: "ssh -i ~/.ssh/work\n", stderr: "" };
      return { code: 1, stdout: "", stderr: HELLO };
    },
  });
  assert.deepEqual(pushIdentity(sshRemote, r, hosts, h, { allowSpawn: true }), { via: "unknown" });
  assert.ok(!calls.includes("ssh"));
});

test("global core.sshCommand (via git config) → unknown on the hook path, ssh not probed", () => {
  const calls: string[][] = [];
  const d = fakeDeps({
    exec: (cmd, args, opts) => {
      calls.push([cmd, ...args]);
      if (cmd === "git" && args.join(" ") === "config core.sshCommand") {
        assert.equal(opts?.cwd, repo.workTree);
        return { code: 0, stdout: "C:/Windows/System32/OpenSSH/ssh.exe\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: HELLO };
    },
  });
  assert.deepEqual(pushIdentity(sshRemote, repo, hosts, d, { allowSpawn: true }), { via: "unknown" });
  assert.ok(!calls.some((c) => c[0] === "ssh"));
});

test("GIT_SSH_COMMAND / GIT_SSH env → unknown in both modes", () => {
  for (const env of [{ GIT_SSH_COMMAND: "ssh -i k" }, { GIT_SSH: "plink" }]) {
    const d = fakeDeps({ env, exec: () => ({ code: 1, stdout: "", stderr: HELLO }) });
    assert.deepEqual(pushIdentity(sshRemote, repo, hosts, d, { allowSpawn: true }), { via: "unknown" });
    assert.deepEqual(pushIdentity(sshRemote, repo, hosts, d, { allowSpawn: false }), { via: "unknown" });
  }
});

function helperDeps(map: Record<string, string>) {
  return fakeDeps({
    exec: (cmd, args, opts) => {
      assert.equal(cmd, "git");
      assert.equal(opts?.cwd, repo.workTree);
      const v = map[args.join(" ")];
      return v === undefined ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: v, stderr: "" };
    },
  });
}

const GH = "!'C:\\Program Files\\GitHub CLI\\gh.exe' auth git-credential";

test("https + gh helper first → via gh, active login", () => {
  const d = helperDeps({ "config --get-all credential.helper": `${GH}\nmanager\n` });
  assert.deepEqual(pushIdentity(httpsRemote, repo, hosts, d, { allowSpawn: false }), { via: "gh", login: "alice" });
  assert.deepEqual(pushIdentity(httpsRemote, repo, null, d, { allowSpawn: false }), { via: "gh", login: null });
});

test("https helper order: [manager, gh] → unknown (manager answers first)", () => {
  const d = helperDeps({ "config --get-all credential.helper": `manager\n${GH}\n` });
  assert.deepEqual(pushIdentity(httpsRemote, repo, hosts, d, { allowSpawn: false }), { via: "unknown" });
});

test("https helper reset: [manager, '', gh] → gh", () => {
  const d = helperDeps({ "config --get-all credential.helper": `manager\n\n${GH}\n` });
  assert.deepEqual(pushIdentity(httpsRemote, repo, hosts, d, { allowSpawn: false }), { via: "gh", login: "alice" });
});

test("https helper list of only a reset [''] → unknown", () => {
  const d = helperDeps({ "config --get-all credential.helper": "\n" });
  assert.deepEqual(pushIdentity(httpsRemote, repo, hosts, d, { allowSpawn: false }), { via: "unknown" });
});

test("https + manager helper → unknown", () => {
  const d = helperDeps({ "config --get-all credential.helper": "manager\n" });
  assert.deepEqual(pushIdentity(httpsRemote, repo, hosts, d, { allowSpawn: false }), { via: "unknown" });
});

test("https specific-URL helper decides over generic", () => {
  let d = helperDeps({
    "config --get-all credential.https://github.com.helper": "manager\n",
    "config --get-all credential.helper": "!gh auth git-credential\n",
  });
  assert.deepEqual(pushIdentity(httpsRemote, repo, hosts, d, { allowSpawn: false }), { via: "unknown" });
  // a specific list emptied by a reset falls back to the generic list
  d = helperDeps({
    "config --get-all credential.https://github.com.helper": "manager\n\n",
    "config --get-all credential.helper": "!gh auth git-credential\n",
  });
  assert.deepEqual(pushIdentity(httpsRemote, repo, hosts, d, { allowSpawn: false }), { via: "gh", login: "alice" });
});
