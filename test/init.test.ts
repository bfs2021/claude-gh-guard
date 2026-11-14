import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fakeDeps } from "./helpers.ts";
import { runInit, runUninstall, shellQuote } from "../src/commands/init.ts";

const HOME = "/home/test";
const settings = path.join(HOME, ".claude", "settings.json");
const bin = path.join(HOME, ".claude-gh-guard", "bin", "cli.js");
const orig = path.join(HOME, ".claude-gh-guard", "original-statusline.json");
const self = path.resolve("/pkg/dist/cli.js");
const base = `node "${bin.replace(/\\/g, "/")}"`;

function mk(s?: string) {
  return fakeDeps({ files: { [self]: "#!/usr/bin/env node\nconsole.log(1)\n", ...(s === undefined ? {} : { [settings]: s }) } });
}
const read = (d: ReturnType<typeof mk>) => JSON.parse(d.readFile(settings)!);

test("fresh settings: adds statusLine and hook", () => {
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

test("existing statusLine wrapped byte-exact, extra fields kept", () => {
  const cmd = 'npx -y ccstatusline@latest | tee "x y"';
  const original = { type: "command", command: cmd, padding: 0 };
  const d = mk(JSON.stringify({ statusLine: original }));
  runInit(d, self);
  const j = read(d);
  assert.equal(j.statusLine.command, `${base} statusline --after ${JSON.stringify(cmd)}`);
  assert.ok(j.statusLine.command.endsWith(' statusline --after "npx -y ccstatusline@latest | tee \\"x y\\""'));
  assert.equal(j.statusLine.padding, 0);
  assert.deepEqual(JSON.parse(d.readFile(orig)!), original);
});

test("idempotent: second init leaves one hook entry and no double wrapping", () => {
  const original = { type: "command", command: "echo hi", padding: 2 };
  const d = mk(JSON.stringify({ statusLine: original, hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "x" }] }] } }));
  runInit(d, self);
  const first = d.readFile(settings);
  runInit(d, self);
  assert.equal(d.readFile(settings), first);
  const j = read(d);
  assert.equal(j.hooks.PreToolUse.length, 2);
  assert.equal(j.statusLine.command, `${base} statusline --after "echo hi"`);
  assert.deepEqual(JSON.parse(d.readFile(orig)!), original);
});

test("re-init refreshes base path only (stale hook replaced)", () => {
  const d = mk(JSON.stringify({
    statusLine: { type: "command", command: 'node "/old/.claude-gh-guard/bin/cli.js" statusline --after "echo hi"' },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'node "/old/claude-gh-guard/cli.js" hook' }] }] },
  }));
  runInit(d, self);
  const j = read(d);
  assert.equal(j.statusLine.command, `${base} statusline --after "echo hi"`);
  assert.deepEqual(j.hooks.PreToolUse, [{ matcher: "Bash", hooks: [{ type: "command", command: `${base} hook` }] }]);
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

test("backup written before change", () => {
  const text = '{"model":"opus"}';
  const d = mk(text);
  runInit(d, self);
  assert.equal(d.readFile(settings + ".bak-19700101-000000"), text);
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
  assert.equal(d.readFile(orig), null);
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
