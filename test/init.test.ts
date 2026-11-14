import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fakeDeps } from "./helpers.ts";
import { runInit, runUninstall, shellQuote, posixQuote, posixUnquote } from "../src/commands/init.ts";

const HOME = "/home/test";
const settings = path.join(HOME, ".claude", "settings.json");
const bin = path.join(HOME, ".claude-gh-guard", "bin", "cli.mjs");
const self = path.resolve("/pkg/dist/cli.js");
const base = `node "${bin.replace(/\\/g, "/")}"`;

function mk(s?: string) {
  return fakeDeps({ files: { [self]: "#!/usr/bin/env node\nconsole.log(1)\n", ...(s === undefined ? {} : { [settings]: s }) } });
}
const read = (d: ReturnType<typeof mk>, f = settings) => JSON.parse(d.readFile(f)!);

const TRICKY = [
  'npx -y ccstatusline@latest | tee "x y"',
  'echo $HOME',
  'input=$(cat); echo "$input" | jq -r .model',
  "echo `date`",
  "echo it's fine",
  "line1\nline2 \\n literal",
];

test("fresh settings: adds statusLine and hook, installs cli.mjs", () => {
  const d = mk();
  const out = runInit(d, self);
  assert.ok(!out.startsWith("error"), out);
  const j = read(d);
  assert.deepEqual(j.statusLine, { type: "command", command: `${base} statusline` });
  assert.deepEqual(j.hooks.PreToolUse, [{ matcher: "Bash", hooks: [{ type: "command", command: `${base} hook` }] }]);
  assert.equal(d.readFile(bin), "#!/usr/bin/env node\nconsole.log(1)\n");
  assert.ok(d.readFile(settings)!.startsWith('{\n  "'));
});

test("path with spaces quoted and slashes normalized", () => {
  assert.equal(shellQuote("C:\\Users\\First Last\\.claude-gh-guard\\bin\\cli.js"), '"C:/Users/First Last/.claude-gh-guard/bin/cli.js"');
});

test("posixQuote exact forms and round trip", () => {
  assert.equal(posixQuote("echo it's"), "'echo it'\\''s'");
  assert.equal(posixQuote("$(cat)"), "'$(cat)'");
  for (const t of TRICKY) assert.equal(posixUnquote(posixQuote(t)), t);
  assert.equal(posixUnquote("'a' b"), null);
  assert.equal(posixUnquote("'unterminated"), null);
});

test("existing statusLine wrapped with single quotes, extra fields kept", () => {
  const cmd = 'npx -y ccstatusline@latest | tee "x y"';
  const d = mk(JSON.stringify({ statusLine: { type: "command", command: cmd, padding: 0 } }));
  runInit(d, self);
  const j = read(d);
  assert.equal(j.statusLine.command, `${base} statusline --after 'npx -y ccstatusline@latest | tee "x y"'`);
  assert.equal(j.statusLine.padding, 0);
});

test("tricky commands: exact written string, no shell expansion, uninstall round-trips", () => {
  for (const t of TRICKY) {
    const original = { type: "command", command: t, padding: 1 };
    const d = mk(JSON.stringify({ statusLine: original }));
    runInit(d, self);
    assert.equal(read(d).statusLine.command, `${base} statusline --after ${posixQuote(t)}`);
    runUninstall(d);
    assert.deepEqual(read(d).statusLine, original);
  }
});

test("quoted argument reaches node byte-exact through a real bash", { skip: spawnSync("bash", ["-c", "true"]).status !== 0 }, () => {
  for (const t of TRICKY) {
    const r = spawnSync("bash", ["-c", `node -e 'process.stdout.write(process.argv[1])' ${posixQuote(t)}`], { encoding: "utf8" });
    assert.equal(r.stdout, t);
  }
});

test("idempotent: second init leaves one hook entry, no double wrapping, no new backup", () => {
  const original = { type: "command", command: "echo hi", padding: 2 };
  const d = mk(JSON.stringify({ statusLine: original, hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "x" }] }] } }));
  runInit(d, self);
  const first = d.readFile(settings);
  const out = runInit(d, self);
  assert.equal(d.readFile(settings), first);
  assert.match(out, /unchanged/);
  assert.equal(d.mtime(settings + ".bak-19700101-000000-1"), null);
  const j = read(d);
  assert.equal(j.hooks.PreToolUse.length, 2);
  assert.equal(j.statusLine.command, `${base} statusline --after 'echo hi'`);
});

test("re-init refreshes base path only (stale hook and statusLine replaced)", () => {
  const d = mk(JSON.stringify({
    statusLine: { type: "command", command: "node \"/old/.claude-gh-guard/bin/cli.js\" statusline --after 'echo hi'" },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'node "/old/.claude-gh-guard/bin/cli.js" hook' }] }] },
  }));
  runInit(d, self);
  const j = read(d);
  assert.equal(j.statusLine.command, `${base} statusline --after 'echo hi'`);
  assert.deepEqual(j.hooks.PreToolUse, [{ matcher: "Bash", hooks: [{ type: "command", command: `${base} hook` }] }]);
});

test("sibling hooks in the same matcher entry survive init and uninstall", () => {
  const mine = { type: "command", command: "my-linter" };
  const start = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [mine, { type: "command", command: 'node "/old/.claude-gh-guard/bin/cli.js" hook' }] }] } };
  const d = mk(JSON.stringify(start));
  runInit(d, self);
  runInit(d, self);
  let pre = read(d).hooks.PreToolUse;
  assert.deepEqual(pre[0], { matcher: "Bash", hooks: [mine] });
  assert.equal(pre.length, 2);
  assert.equal(pre[1].hooks[0].command, `${base} hook`);
  runUninstall(d);
  pre = read(d).hooks.PreToolUse;
  assert.deepEqual(pre, [{ matcher: "Bash", hooks: [mine] }]);
});

test("a hook merely mentioning claude-gh-guard is not ours", () => {
  const other = { matcher: "Bash", hooks: [{ type: "command", command: "echo claude-gh-guard rocks" }] };
  const d = mk(JSON.stringify({ hooks: { PreToolUse: [other] } }));
  runInit(d, self);
  assert.deepEqual(read(d).hooks.PreToolUse[0], other);
  runUninstall(d);
  assert.deepEqual(read(d).hooks.PreToolUse, [other]);
});

test("invalid JSON settings -> error, file unchanged, no backup", () => {
  const d = mk("{not json");
  const out = runInit(d, self);
  assert.match(out, /^error/);
  assert.equal(d.readFile(settings), "{not json");
  assert.equal(d.readFile(bin), null);
  assert.equal(d.mtime(settings + ".bak-19700101-000000"), null);
  assert.match(runUninstall(d), /^error/);
});

test("backup written before change and never overwritten", () => {
  const text = '{"model":"opus"}';
  const d = mk(text);
  runInit(d, self);
  assert.equal(d.readFile(settings + ".bak-19700101-000000"), text);
  const changed = JSON.stringify({ ...read(d), model: "sonnet" });
  d.writeFile(settings, changed);
  runInit(d, self); // reformats -> differs -> second backup in the same second
  assert.equal(d.readFile(settings + ".bak-19700101-000000"), text);
  assert.equal(d.readFile(settings + ".bak-19700101-000000-1"), changed);
});

test("other keys preserved, in order", () => {
  const d = mk(JSON.stringify({ model: "opus", permissions: { allow: ["Bash(ls)"] }, env: { A: "1" } }));
  runInit(d, self);
  const j = read(d);
  assert.deepEqual(Object.keys(j), ["model", "permissions", "env", "statusLine", "hooks"]);
  assert.deepEqual(j.permissions, { allow: ["Bash(ls)"] });
});

test("--settings override path is used", () => {
  const custom = path.resolve("/elsewhere/s.json");
  const d = mk();
  runInit(d, self, { settings: custom });
  assert.ok(d.readFile(custom)!.includes("statusLine"));
  assert.equal(d.readFile(settings), null);
  runUninstall(d, { settings: custom });
  assert.equal(d.readFile(custom), "{}\n");
});

test("uninstall restores original statusLine and removes hook", () => {
  const original = { type: "command", command: "echo hi", padding: 2 };
  const start = { model: "opus", statusLine: original, hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "x" }] }] } };
  const d = mk(JSON.stringify(start));
  runInit(d, self);
  runUninstall(d);
  assert.deepEqual(read(d), start);
  assert.equal(d.readFile(bin), null);
});

test("uninstall works after ~/.claude-gh-guard was deleted", () => {
  const original = { type: "command", command: "echo $HOME", padding: 2 };
  const d = mk(JSON.stringify({ statusLine: original }));
  runInit(d, self);
  d.remove(path.join(HOME, ".claude-gh-guard"));
  runUninstall(d);
  assert.deepEqual(read(d).statusLine, original);
});

test("two settings files with different originals uninstall independently", () => {
  const a = path.resolve("/cfg/a/settings.json");
  const b = path.resolve("/cfg/b/settings.json");
  const oa = { type: "command", command: "echo A" };
  const ob = { type: "command", command: "echo B", padding: 3 };
  const d = fakeDeps({ files: { [self]: "x", [a]: JSON.stringify({ statusLine: oa }), [b]: JSON.stringify({ statusLine: ob }) } });
  runInit(d, self, { settings: a });
  runInit(d, self, { settings: b });
  runUninstall(d, { settings: a });
  assert.deepEqual(read(d, a).statusLine, oa);
  runUninstall(d, { settings: b });
  assert.deepEqual(read(d, b).statusLine, ob);
});

test("uninstall with no original deletes statusLine and drops emptied hooks", () => {
  const d = mk(JSON.stringify({ model: "opus" }));
  runInit(d, self);
  runUninstall(d);
  assert.deepEqual(read(d), { model: "opus" });
});

test("uninstall leaves a statusLine the user changed since", () => {
  const d = mk();
  runInit(d, self);
  const j = read(d);
  j.statusLine = { type: "command", command: "mine" };
  d.writeFile(settings, JSON.stringify(j));
  runUninstall(d);
  assert.deepEqual(read(d).statusLine, { type: "command", command: "mine" });
});
