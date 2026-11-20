import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fakeDeps } from "./helpers.ts";
import { checkMoved, readMoved, writeMoved, isMovedFresh, movedTo, setUrlFix } from "../src/moved.ts";
import type { Remote } from "../src/remote.ts";

const API = "https://api.github.com/repos/alice/app";
const movedPath = path.join("/home/test", ".claude-gh-guard", "moved.json");
const tokens = (cmd: string, args: string[]) =>
  cmd === "gh" && args[0] === "auth" && args[1] === "token" ? { code: 0, stdout: `tok_${args[3]}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" };

function setup(byLogin: Record<string, number | string>, exec = tokens) {
  const calls: string[] = [];
  const d = fakeDeps({
    now: () => 5000,
    exec,
    fetch: (async (url: string, init?: RequestInit) => {
      const login = (init?.headers as Record<string, string>).Authorization!.replace("Bearer tok_", "");
      calls.push(`${login} ${url}`);
      const v = byLogin[login];
      if (typeof v === "number") return new Response("{}", { status: v });
      return new Response(JSON.stringify({ full_name: v }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  return { d, calls };
}

test("checkMoved returns the canonical name, asking the active account first", async () => {
  const { d, calls } = setup({ alice: "corp/app", bob: "corp/app" });
  const e = await checkMoved("alice", "app", ["bob", "alice"], "alice", d, 1000);
  assert.deepEqual(e, { fullName: "corp/app", checkedAt: 5000 });
  assert.deepEqual(calls, [`alice ${API}`]);
});

test("checkMoved: 404 tries the next login; all 404 → fullName null", async () => {
  const { d, calls } = setup({ alice: 404, bob: "alice/app" });
  assert.deepEqual(await checkMoved("alice", "app", ["alice", "bob"], "alice", d, 1000), { fullName: "alice/app", checkedAt: 5000 });
  assert.equal(calls.length, 2);
  const s = setup({ alice: 404, bob: 404 });
  assert.deepEqual(await checkMoved("alice", "app", ["alice", "bob"], "alice", s.d, 1000), { fullName: null, checkedAt: 5000 });
});

test("checkMoved gives up on errors, missing tokens and no logins", async () => {
  assert.equal(await checkMoved("alice", "app", ["alice"], "alice", setup({ alice: 403 }).d, 1000), null);
  assert.equal(await checkMoved("alice", "app", ["alice"], "alice", setup({ alice: 500 }).d, 1000), null);
  assert.equal(await checkMoved("alice", "app", [], null, setup({}).d, 1000), null);
  const noTok = setup({ alice: "corp/app" }, () => ({ code: 1, stdout: "", stderr: "" }));
  assert.equal(await checkMoved("alice", "app", ["alice"], "alice", noTok.d, 1000), null);
  const throws = fakeDeps({ exec: tokens, fetch: (() => Promise.reject(new Error("net"))) as unknown as typeof fetch });
  assert.equal(await checkMoved("alice", "app", ["alice"], "alice", throws, 1000), null);
});

test("checkMoved times out", async () => {
  const d = fakeDeps({ exec: tokens, fetch: (() => new Promise(() => {})) as unknown as typeof fetch });
  assert.equal(await checkMoved("alice", "app", ["alice"], "alice", d, 20), null);
});

test("cache round trip, freshness and movedTo", () => {
  const d = fakeDeps();
  assert.deepEqual(readMoved(d), {});
  writeMoved(d, "Alice/App", { fullName: "corp/app", checkedAt: 0 });
  writeMoved(d, "corp/same", { fullName: "Corp/Same", checkedAt: 0 });
  writeMoved(d, "corp/gone", { fullName: null, checkedAt: 0 });
  assert.ok(d.readFile(movedPath)?.includes("alice/app"));
  assert.ok(isMovedFresh({ fullName: null, checkedAt: 0 }, 604800000));
  assert.ok(!isMovedFresh({ fullName: null, checkedAt: 0 }, 604800001));

  const r = (owner: string, repo: string): Remote => ({ protocol: "https", host: "github.com", sshAlias: null, owner, repo });
  assert.equal(movedTo(d, r("alice", "app")), "corp/app");
  assert.equal(movedTo(d, r("corp", "same")), null); // only case differs
  assert.equal(movedTo(d, r("corp", "gone")), null);
  assert.equal(movedTo(d, r("other", "x")), null);
  assert.equal(movedTo(d, { ...r("alice", "app"), host: "ghe.example.com" }), null);
  assert.equal(movedTo(d, null), null);
  d.writeFile(movedPath, "{bad");
  assert.deepEqual(readMoved(d), {});
});

test("setUrlFix keeps protocol and ssh alias", () => {
  const ssh: Remote = { protocol: "ssh", host: "github.com", sshAlias: "gh-work", owner: "alice", repo: "app" };
  assert.equal(setUrlFix(ssh, "corp/app", "origin"), "git remote set-url origin git@gh-work:corp/app.git");
  assert.equal(setUrlFix({ ...ssh, sshAlias: null }, "corp/app", "up"), "git remote set-url up git@github.com:corp/app.git");
  assert.equal(setUrlFix({ ...ssh, protocol: "https", sshAlias: null }, "corp/app", "origin"), "git remote set-url origin https://github.com/corp/app.git");
  assert.equal(setUrlFix(ssh, "corp/app", ""), "use corp/app instead");
});
