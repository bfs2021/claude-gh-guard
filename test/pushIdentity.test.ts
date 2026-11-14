import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pushIdentity, parseSshHello } from "../src/pushIdentity.ts";
import type { Remote } from "../src/remote.ts";
import type { Repo } from "../src/gitRepo.ts";
import type { GhHosts } from "../src/ghHosts.ts";
import { fakeDeps } from "./helpers.ts";

const repo = { workTree: path.resolve("/w") } as Repo;
const hosts: GhHosts = { active: "alice", logins: ["alice"], hostsFile: "h" };
const sshRemote: Remote = { protocol: "ssh", host: "github.com", sshAlias: "github.com-work", owner: "o", repo: "r" };
const httpsRemote: Remote = { protocol: "https", host: "GitHub.com", sshAlias: null, owner: "o", repo: "r" };
const HELLO = "Hi alice! You've successfully authenticated, but GitHub does not provide shell access.";

test("parseSshHello", () => {
  assert.equal(parseSshHello(HELLO), "alice");
  assert.equal(parseSshHello("Permission denied"), null);
});

test("ssh remote spawns ssh -T on alias and caches", () => {
  const calls: string[][] = [];
  const d = fakeDeps({
    exec: (cmd, args) => { calls.push([cmd, ...args]); return { code: 1, stdout: "", stderr: HELLO }; },
  });
  assert.deepEqual(pushIdentity(sshRemote, repo, hosts, d, { allowSpawn: true }), { via: "ssh", login: "alice" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=3", "git@github.com-work"]);
  assert.deepEqual(pushIdentity(sshRemote, repo, hosts, d, { allowSpawn: true }), { via: "ssh", login: "alice" });
  assert.equal(calls.length, 1);
});

test("ssh cache invalidated when ~/.ssh/config mtime changes", () => {
  let n = 0;
  let m = 100;
  const cfg = path.join("/home/test", ".ssh", "config");
  const d = fakeDeps({
    files: { [cfg]: "x" },
    mtime: (p) => (path.normalize(p) === path.normalize(cfg) ? m : null),
    exec: () => { n++; return { code: 1, stdout: "", stderr: HELLO }; },
  });
  pushIdentity(sshRemote, repo, hosts, d, { allowSpawn: true });
  pushIdentity(sshRemote, repo, hosts, d, { allowSpawn: true });
  assert.equal(n, 1);
  m = 200;
  pushIdentity(sshRemote, repo, hosts, d, { allowSpawn: true });
  assert.equal(n, 2);
});

test("allowSpawn false + no cache → login null; failed ssh not cached", () => {
  let n = 0;
  const d = fakeDeps({ exec: () => { n++; return { code: 255, stdout: "", stderr: "timeout" }; } });
  assert.deepEqual(pushIdentity(sshRemote, repo, hosts, d, { allowSpawn: false }), { via: "ssh", login: null });
  assert.equal(n, 0);
  assert.deepEqual(pushIdentity(sshRemote, repo, hosts, d, { allowSpawn: true }), { via: "ssh", login: null });
  pushIdentity(sshRemote, repo, hosts, d, { allowSpawn: true });
  assert.equal(n, 2);
});

test("allowSpawn false uses fresh cache; corrupt cache treated as empty", () => {
  const d = fakeDeps({ exec: () => ({ code: 1, stdout: "", stderr: HELLO }) });
  pushIdentity(sshRemote, repo, hosts, d, { allowSpawn: true });
  assert.deepEqual(pushIdentity(sshRemote, repo, hosts, d, { allowSpawn: false }), { via: "ssh", login: "alice" });
  const bad = fakeDeps({ files: { [path.join("/home/test", ".claude-gh-guard", "ssh.json")]: "{nope" } });
  assert.deepEqual(pushIdentity(sshRemote, repo, hosts, bad, { allowSpawn: false }), { via: "ssh", login: null });
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

test("https + gh helper → via gh, active login", () => {
  const d = helperDeps({
    "config --get-all credential.helper": "manager\n!'C:\Program Files\GitHub CLI\gh.exe' auth git-credential\n",
  });
  assert.deepEqual(pushIdentity(httpsRemote, repo, hosts, d, { allowSpawn: false }), { via: "gh", login: "alice" });
  assert.deepEqual(pushIdentity(httpsRemote, repo, null, d, { allowSpawn: false }), { via: "gh", login: null });
});

test("https + manager helper → unknown", () => {
  const d = helperDeps({ "config --get-all credential.helper": "manager\n" });
  assert.deepEqual(pushIdentity(httpsRemote, repo, hosts, d, { allowSpawn: false }), { via: "unknown" });
});

test("https specific-URL helper decides over generic", () => {
  const d = helperDeps({
    "config --get-all credential.https://github.com.helper": "manager\n",
    "config --get-all credential.helper": "!gh auth git-credential\n",
  });
  assert.deepEqual(pushIdentity(httpsRemote, repo, hosts, d, { allowSpawn: false }), { via: "unknown" });
});
