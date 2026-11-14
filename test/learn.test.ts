import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fakeDeps } from "./helpers.ts";
import { learnRepo, readLearned, writeLearned, isFresh } from "../src/learn.ts";
import type { LearnedEntry } from "../src/learn.ts";

const REPO = "https://api.github.com/repos/org/repo";
const COMMITS = `${REPO}/commits?per_page=50`;

function res(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function setup(opts: {
  push: Record<string, boolean | number>; // login -> push perm or http status
  commits?: unknown[] | number;
  now?: number;
  rateLimit403?: boolean;
  commitsReject?: boolean;
  tokenFail?: string;
}) {
  const calls: { url: string; auth: string | null; signal: boolean }[] = [];
  const d = fakeDeps({
    now: () => opts.now ?? 1000,
    exec: (cmd, args) => {
      if (cmd === "gh" && args[3] === opts.tokenFail) return { code: 1, stdout: "", stderr: "" };
      if (cmd === "gh" && args[0] === "auth" && args[1] === "token" && args[2] === "--user") {
        return { code: 0, stdout: `gho_${args[3]}\n`, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    },
    fetch: (async (url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      calls.push({ url, auth: headers.Authorization ?? null, signal: !!init?.signal });
      if (url === REPO) {
        const login = headers.Authorization!.replace("Bearer gho_", "");
        const v = opts.push[login];
        if (v === 1) throw new Error("boom");
        if (typeof v === "number") return res(v, {}, v === 403 && opts.rateLimit403 ? { "x-ratelimit-remaining": "0" } : undefined);
        return res(200, { permissions: { push: v === true } });
      }
      if (url === COMMITS) {
        if (opts.commitsReject) throw new Error("boom");
        if (typeof opts.commits === "number") return res(opts.commits, {});
        return res(200, opts.commits ?? []);
      }
      throw new Error("unexpected " + url);
    }) as unknown as typeof fetch,
  });
  return { d, calls };
}

const commit = (login: string | null) => ({ author: login === null ? null : { login } });

test("single pusher", async () => {
  const { d, calls } = setup({ push: { A: true, B: false } });
  const e = await learnRepo("org", "repo", ["A", "B"], d, 1000);
  assert.deepEqual(e, { pushers: ["A"], expected: "A", basis: "single", checkedAt: 1000, loginsKey: "A,B" });
  assert.ok(calls.every((c) => c.signal));
  assert.ok(!calls.some((c) => c.url === COMMITS));
});

test("two pushers, history picks B", async () => {
  const { d } = setup({
    push: { A: true, B: true },
    commits: [commit("b"), commit("B"), commit("B"), commit("A"), commit("x"), commit("x"), commit(null)],
  });
  const e = await learnRepo("org", "repo", ["A", "B"], d, 1000);
  assert.equal(e?.expected, "B");
  assert.equal(e?.basis, "history");
  assert.deepEqual(e?.pushers, ["A", "B"]);
});

test("two pushers, no history -> ambiguous", async () => {
  const { d } = setup({ push: { A: true, B: true }, commits: [commit("stranger"), commit(null)] });
  const e = await learnRepo("org", "repo", ["A", "B"], d, 1000);
  assert.equal(e?.expected, null);
  assert.equal(e?.basis, "ambiguous");
});

test("two pushers, commits call fails -> ambiguous", async () => {
  const { d } = setup({ push: { A: true, B: true }, commits: 409 });
  const e = await learnRepo("org", "repo", ["A", "B"], d, 1000);
  assert.equal(e?.basis, "ambiguous");
});

test("two pushers, tie -> ambiguous", async () => {
  const { d } = setup({ push: { A: true, B: true }, commits: [commit("A"), commit("B")] });
  const e = await learnRepo("org", "repo", ["A", "B"], d, 1000);
  assert.equal(e?.expected, null);
  assert.equal(e?.basis, "ambiguous");
});

test("404 for both -> none", async () => {
  const { d } = setup({ push: { A: 404, B: 403 } });
  const e = await learnRepo("org", "repo", ["A", "B"], d, 1000);
  assert.equal(e?.basis, "none");
  assert.deepEqual(e?.pushers, []);
  assert.equal(e?.expected, null);
});

test("empty logins -> none without network", async () => {
  const d = fakeDeps();
  const e = await learnRepo("org", "repo", [], d, 1000);
  assert.deepEqual(e, { pushers: [], expected: null, basis: "none", checkedAt: 0, loginsKey: "" });
});

test("network error -> null", async () => {
  const d = fakeDeps({
    exec: () => ({ code: 0, stdout: "gho_x\n", stderr: "" }),
    fetch: (() => Promise.reject(new Error("boom"))) as typeof fetch,
  });
  assert.equal(await learnRepo("org", "repo", ["A"], d, 1000), null);
});

test("timeout -> null", async () => {
  const d = fakeDeps({
    exec: () => ({ code: 0, stdout: "gho_x\n", stderr: "" }),
    fetch: (() => new Promise(() => {})) as typeof fetch,
  });
  const t0 = Date.now();
  assert.equal(await learnRepo("org", "repo", ["A"], d, 50), null);
  assert.ok(Date.now() - t0 < 500);
});

test("token never written to disk", async () => {
  const written: string[] = [];
  const { d } = setup({ push: { A: true, B: false } });
  const d2 = { ...d, writeFile: (p: string, s: string) => { written.push(s); d.writeFile(p, s); } };
  const e = await learnRepo("org", "repo", ["A", "B"], d2, 1000);
  writeLearned(d2, "Org/Repo", e!);
  assert.ok(written.length > 0);
  assert.ok(written.every((s) => !s.includes("gho_")));
  assert.deepEqual(Object.keys(readLearned(d2)), ["org/repo"]);
  assert.ok(d2.readFile(path.join(d2.home, ".claude-gh-guard", "learned.json")));
});

test("readLearned: corrupt -> {}; writeLearned preserves others", () => {
  const p = path.join("/home/test", ".claude-gh-guard", "learned.json");
  const bad = fakeDeps({ files: { [p]: "{nope" } });
  assert.deepEqual(readLearned(bad), {});
  const e: LearnedEntry = { pushers: [], expected: null, basis: "none", checkedAt: 1, loginsKey: "" };
  const d = fakeDeps();
  writeLearned(d, "a/b", e);
  writeLearned(d, "C/D", e);
  assert.deepEqual(Object.keys(readLearned(d)).sort(), ["a/b", "c/d"]);
});

test("isFresh: age and login-set change", () => {
  const e: LearnedEntry = { pushers: ["A"], expected: "A", basis: "single", checkedAt: 1000, loginsKey: "A,B" };
  assert.equal(isFresh(e, ["B", "A"], 1000 + 604800000), true);
  assert.equal(isFresh(e, ["A", "B"], 1000 + 604800001), false);
  assert.equal(isFresh(e, ["A", "B", "C"], 2000), false);
});

test("B fetch rejects -> null", async () => {
  const { d } = setup({ push: { A: true, B: 1 } });
  assert.equal(await learnRepo("org", "repo", ["A", "B"], d, 1000), null);
});

test("B 503 or 429 -> null", async () => {
  for (const st of [503, 429]) {
    const { d } = setup({ push: { A: true, B: st } });
    assert.equal(await learnRepo("org", "repo", ["A", "B"], d, 1000), null);
  }
});

test("403 rate limited -> null; plain 403 -> single", async () => {
  const rl = setup({ push: { A: true, B: 403 }, rateLimit403: true });
  assert.equal(await learnRepo("org", "repo", ["A", "B"], rl.d, 1000), null);
  const plain = setup({ push: { A: true, B: 403 } });
  const e = await learnRepo("org", "repo", ["A", "B"], plain.d, 1000);
  assert.equal(e?.basis, "single");
  assert.equal(e?.expected, "A");
});

test("history ignores non-pusher logins", async () => {
  const { d } = setup({
    push: { A: true, B: true, C: 404 },
    commits: [commit("C"), commit("C"), commit("C"), commit("A"), commit("A"), commit("B")],
  });
  const e = await learnRepo("org", "repo", ["A", "B", "C"], d, 1000);
  assert.equal(e?.expected, "A");
  assert.equal(e?.basis, "history");
});

test("commits fetch rejects -> ambiguous", async () => {
  const { d } = setup({ push: { A: true, B: true }, commitsReject: true });
  const e = await learnRepo("org", "repo", ["A", "B"], d, 1000);
  assert.equal(e?.basis, "ambiguous");
});

test("token exec failure for any login aborts learning", async () => {
  const { d } = setup({ push: { A: true, B: true }, tokenFail: "B" });
  assert.equal(await learnRepo("org", "repo", ["A", "B"], d, 1000), null);
});
