import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import { realDeps } from "../src/deps.ts";
import { fakeDeps } from "../test/helpers.ts";
import { runStatusline } from "../src/commands/statusline.ts";
import { runLearn } from "../src/commands/learn.ts";

const HOSTS = `github.com:
    user: alice
    users:
        alice:
        corpUser:
`;
const hostsPath = path.join("/home/test", ".config", "gh", "hosts.yml");
const cfgPath = path.join(path.resolve("/w/r"), ".git", "config");
const stdin = JSON.stringify({ workspace: { current_dir: "/w/r" } });

function files(url: string) {
  return {
    [hostsPath]: HOSTS,
    [path.join(path.resolve("/w/r"), ".git", "HEAD")]: "ref: refs/heads/main\n",
    [cfgPath]: `[remote "origin"]\n\turl = ${url}\n`,
  };
}
const env = { NO_COLOR: "1" };

test("statusline uses workspace.current_dir and caches", () => {
  const f = files("git@github.com:alice/x.git");
  const base = fakeDeps({ env, files: f });
  let cfgReads = 0;
  const d = { ...base, readFile: (p: string) => { if (path.normalize(p) === path.normalize(cfgPath)) cfgReads++; return base.readFile(p); } };
  assert.equal(runStatusline(stdin, [], d), "🟢 gh:alice");
  const first = cfgReads;
  assert.ok(first > 0);
  assert.equal(runStatusline(stdin, [], d), "🟢 gh:alice");
  assert.equal(cfgReads, first);
});

test("corrupt cache file is a miss", () => {
  const base = fakeDeps({ env, files: files("git@github.com:alice/x.git") });
  let cfgReads = 0;
  const d = { ...base, readFile: (p: string) => { if (path.normalize(p) === path.normalize(cfgPath)) cfgReads++; return base.readFile(p); } };
  runStatusline(stdin, [], d);
  const cacheFile = path.join("/tmp", "claude-gh-guard", createHash("sha1").update(path.resolve("/w/r")).digest("hex") + ".json");
  assert.ok(base.readFile(cacheFile)?.includes('"line"'));
  base.writeFile(cacheFile, "{not json");
  cfgReads = 0;
  assert.equal(runStatusline(stdin, [], d), "🟢 gh:alice");
  assert.ok(cfgReads > 0);
});

function countingDeps(extra: Parameters<typeof fakeDeps>[0] = {}) {
  const base = fakeDeps({ env, files: files("git@github.com:alice/x.git"), ...extra });
  const st = { cfgReads: 0, now: 0, ssh: 0 };
  const sshCfg = path.join("/home/test", ".ssh", "config");
  const d = {
    ...base,
    now: () => st.now,
    mtime: (p: string) => (path.normalize(p) === path.normalize(sshCfg) ? st.ssh : base.mtime(p)),
    readFile: (p: string) => { if (path.normalize(p) === path.normalize(cfgPath)) st.cfgReads++; return base.readFile(p); },
  };
  return { d, st };
}

test("cache misses when the 10-minute bucket changes", () => {
  const { d, st } = countingDeps();
  runStatusline(stdin, [], d);
  const n = st.cfgReads;
  st.now = 599999;
  runStatusline(stdin, [], d);
  assert.equal(st.cfgReads, n);
  st.now = 600000;
  runStatusline(stdin, [], d);
  assert.ok(st.cfgReads > n);
});

test("cache misses when ~/.ssh/config mtime changes", () => {
  const { d, st } = countingDeps();
  runStatusline(stdin, [], d);
  const n = st.cfgReads;
  st.ssh = 5;
  runStatusline(stdin, [], d);
  assert.ok(st.cfgReads > n);
});

test("internal error renders fallback line and logs", () => {
  const base = fakeDeps({ env });
  const d = { ...base, mtime: () => { throw new Error("boom"); } };
  assert.equal(runStatusline(stdin, [], d), "⚪ gh:? (error)");
  assert.equal(runStatusline(stdin, ["--ascii"], d), "[?] gh:? (error)");
  assert.match(base.readFile(path.join("/home/test", ".claude-gh-guard", "error.log")) ?? "", /boom/);
});

test("--after runs a quoted command through the real shell", () => {
  const real = realDeps();
  const d = { ...real, env: { ...real.env, NO_COLOR: "1" } };
  const out = runStatusline(stdin, ["--after", `node -e "process.stdout.write('a | b')"`], d);
  assert.ok(out.startsWith("a | b | "), out);
});

test("statusline spawns learn for unknown org, does not fetch", () => {
  const spawned: string[][] = [];
  let fetched = 0;
  const d = fakeDeps({
    env,
    files: files("https://github.com/corp/app.git"),
    spawnDetached: (a) => { spawned.push(a); },
    fetch: (() => { fetched++; return Promise.reject(new Error("no")); }) as typeof fetch,
  });
  assert.equal(runStatusline(stdin, [], d), "⚪ gh:alice (?)");
  assert.deepEqual(spawned, [["learn", "corp", "app"]]);
  runStatusline(stdin, [], d); // cache hit: no second spawn
  assert.equal(spawned.length, 1);
  assert.equal(fetched, 0);
});

test("--ascii and GH_GUARD_ASCII, color default", () => {
  const f = files("git@github.com:alice/x.git");
  assert.equal(runStatusline(stdin, ["--ascii"], fakeDeps({ env, files: f })), "[OK] gh:alice");
  assert.equal(runStatusline(stdin, [], fakeDeps({ env: { ...env, GH_GUARD_ASCII: "1" }, files: f })), "[OK] gh:alice");
  assert.equal(runStatusline(stdin, [], fakeDeps({ files: f })), "\x1b[32m🟢 gh:alice\x1b[0m");
});

test("invalid stdin falls back to process.cwd without throwing", () => {
  const d = fakeDeps({ env, files: { [hostsPath]: HOSTS } });
  assert.equal(runStatusline("not json", [], d), "⚪ gh:alice (no-remote)");
});

test("--after prepends existing output byte-exact, including quotes and pipes", () => {
  const calls: { cmd: string; args: string[]; input?: string; timeoutMs?: number; verbatim?: boolean }[] = [];
  const cmd = `node -e "console.log('a | b')" | cat`;
  const d = fakeDeps({
    env,
    files: files("git@github.com:alice/x.git"),
    exec: (c, args, o) => { calls.push({ cmd: c, args, input: o?.input, timeoutMs: o?.timeoutMs }); return { code: 0, stdout: "Ctx 48% | out 374tok\n", stderr: "" }; },
  });
  assert.equal(runStatusline(stdin, ["--after", cmd], d), "Ctx 48% | out 374tok | 🟢 gh:alice");
  const after = calls.find((c) => c.args.includes(cmd))!;
  assert.deepEqual([after.cmd, after.args], ["/bin/sh", ["-c", cmd]]);
  assert.equal(after.input, stdin);
  assert.equal(after.timeoutMs, 2000);
});

test("--after on win32 runs bash -c first", () => {
  const calls: { cmd: string; args: string[]; input?: string; timeoutMs?: number; verbatim?: boolean }[] = [];
  const cmd = `node -e "console.log(1)" | cat`;
  const w = fakeDeps({ env: { ...env, MSYSTEM: "MINGW64" }, platform: "win32", files: files("git@github.com:alice/x.git"),
    exec: (c, args, o) => { calls.push({ cmd: c, args, input: o?.input, timeoutMs: o?.timeoutMs, verbatim: o?.verbatim }); return { code: 0, stdout: "x\n", stderr: "" }; } });
  assert.equal(runStatusline(stdin, ["--after", cmd], w), "x | 🟢 gh:alice");
  const afters = calls.filter((c) => c.args.includes(cmd) || c.args.includes(`"${cmd}"`));
  assert.equal(afters.length, 1);
  assert.deepEqual([afters[0]!.cmd, afters[0]!.args], ["bash", ["-c", cmd]]);
  assert.equal(afters[0]!.input, stdin);
  assert.equal(afters[0]!.timeoutMs, 2000);
});

test("--after on win32 falls back to cmd.exe only when bash fails to start", () => {
  const cmd = `echo "a b"`;
  const calls: { cmd: string; args: string[]; verbatim?: boolean }[] = [];
  const mkw = (bash: { code: number | null; stdout: string; stderr: string }) =>
    fakeDeps({ env: { ...env, MSYSTEM: "MINGW64" }, platform: "win32", files: files("git@github.com:alice/x.git"),
      exec: (c, args, o) => {
        calls.push({ cmd: c, args, verbatim: o?.verbatim });
        return c === "bash" ? bash : c === "cmd.exe" ? { code: 0, stdout: "viacmd", stderr: "" } : { code: 1, stdout: "", stderr: "" };
      } });
  // spawn failure (code null, no output) -> cmd.exe verbatim
  assert.equal(runStatusline(stdin, ["--after", cmd], mkw({ code: null, stdout: "", stderr: "" })), "viacmd | 🟢 gh:alice");
  const wc = calls.at(-1)!;
  assert.deepEqual([wc.cmd, wc.args], ["cmd.exe", ["/d", "/s", "/c", `"${cmd}"`]]);
  assert.equal(wc.verbatim, true);
  // bash started but the command failed -> no fallback
  calls.length = 0;
  assert.equal(runStatusline(stdin, ["--after", cmd], mkw({ code: 3, stdout: "", stderr: "boom" })), "🟢 gh:alice");
  assert.ok(!calls.some((c) => c.cmd === "cmd.exe"));
  // exec throwing counts as failed to start
  calls.length = 0;
  const thrower = fakeDeps({ env: { ...env, MSYSTEM: "MINGW64" }, platform: "win32", files: files("git@github.com:alice/x.git"),
    exec: (c) => { if (c === "bash") throw new Error("ENOENT"); return { code: 0, stdout: "viacmd", stderr: "" }; } });
  assert.equal(runStatusline(stdin, ["--after", cmd], thrower), "viacmd | 🟢 gh:alice");
});

test("--after on win32 picks the bash to trust", () => {
  const f = files("git@github.com:alice/x.git");
  const run = (envx: Record<string, string>, extra: Record<string, string> = {}) => {
    const calls: string[] = [];
    const d = fakeDeps({ env: { ...env, ...envx }, platform: "win32", files: { ...f, ...extra },
      exec: (c) => { calls.push(c); return { code: 0, stdout: "o", stderr: "" }; } });
    runStatusline(stdin, ["--after", "x"], d);
    return calls.filter((c) => c !== "git");
  };
  const pf = "C:\\Program Files";
  const pfBash = pf + "\\Git\\bin\\bash.exe";
  const custom = "D:\\g\\bash.exe";
  assert.deepEqual(run({ CLAUDE_CODE_GIT_BASH_PATH: custom, MSYSTEM: "MINGW64" }), [custom]);
  assert.deepEqual(run({ MSYSTEM: "MINGW64" }), ["bash"]);
  assert.deepEqual(run({ ProgramFiles: pf }, { [pfBash]: "" }), [pfBash]);
  // no Git Bash anywhere: straight to cmd.exe, never a bare (possibly WSL) bash
  assert.deepEqual(run({ ProgramFiles: pf }), ["cmd.exe"]);
  assert.deepEqual(run({}), ["cmd.exe"]);
});

test("--after failure -> ours alone", () => {
  const f = files("git@github.com:alice/x.git");
  const fail = fakeDeps({ env, files: f, exec: () => ({ code: 1, stdout: "junk", stderr: "" }) });
  assert.equal(runStatusline(stdin, ["--after", "x"], fail), "🟢 gh:alice");
  const empty = fakeDeps({ env, files: f, exec: () => ({ code: 0, stdout: "  \n", stderr: "" }) });
  assert.equal(runStatusline(stdin, ["--after", "x"], empty), "🟢 gh:alice");
});

test("learn lock prevents concurrent runs; stale lock reclaimed", async () => {
  const lock = path.join("/home/test", ".claude-gh-guard", "learn.lock");
  let fetches = 0;
  const mk = (now: number, extra: Record<string, string>) =>
    fakeDeps({
      now: () => now,
      files: { [hostsPath]: HOSTS, ...extra },
      exec: () => ({ code: 0, stdout: "tok\n", stderr: "" }),
      fetch: (async () => { fetches++; return new Response(JSON.stringify({ permissions: { push: true } }), { status: 200 }); }) as typeof fetch,
    });
  // fresh lock (mtime 0, now 0) -> skipped
  let d = mk(0, { [lock]: "0" });
  await runLearn(["corp", "app"], d);
  assert.equal(fetches, 0);
  assert.equal(d.readFile(lock), "0");
  // stale lock -> runs, writes entry, releases
  d = mk(120000, { [lock]: "0" });
  await runLearn(["corp", "app"], d);
  assert.ok(fetches > 0);
  const learned = JSON.parse(d.readFile(path.join("/home/test", ".claude-gh-guard", "learned.json"))!);
  assert.ok(learned["corp/app"]);
  assert.equal(d.readFile(lock), "");
  // released (empty) lock is reusable even when young
  const before = fetches;
  d = mk(0, { [lock]: "" });
  await runLearn(["corp", "app"], d);
  assert.ok(fetches > before);
});
