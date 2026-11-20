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
const labels = ["gh config:", "logins:", "active:", "repo:", "remote:", "moved:", "email:", "push identity:", "expected:", "state:", "time:"];

test("doctor prints every label", async () => {
  const d = fakeDeps({ files: repoFiles("git@github.com:alice/x.git") });
  const out = await runDoctor(root, d);
  for (const l of labels) assert.ok(out.split("\n").some((x) => x.startsWith(l)), `${l}\n${out}`);
  assert.match(out, /logins:.*alice.*corpUser/);
  assert.match(out, /email:.*me@x\.com.*local/);
  assert.match(out, /expected:.*alice.*owner/);
  assert.match(out, /state:.*MATCH/);
  assert.match(out, /time:.*\d+ ms/);
});

test("doctor AMBIGUOUS prints pin snippet", async () => {
  const learned = { "corp/app": { pushers: ["alice", "corpUser"], expected: null, basis: "ambiguous", checkedAt: 0, loginsKey: "alice,corpUser" } };
  const d = fakeDeps({ files: { ...repoFiles("https://github.com/corp/app.git"), [path.join("/home/test", ".claude-gh-guard", "learned.json")]: JSON.stringify(learned) } });
  const out = await runDoctor(root, d);
  assert.match(out, /state:.*AMBIGUOUS/);
  assert.match(out, /~\/\.gh-guard\.json/);
  assert.match(out, /"owners": \["corp"\]/);
  assert.match(out, /"ghUser": "alice"/);
});

test("doctor outside a repo", async () => {
  const out = await runDoctor(path.resolve("/nowhere"), fakeDeps({ files: { [hostsPath]: HOSTS } }));
  assert.match(out, /repo:.*not a git repo/);
  assert.match(out, /state:.*UNTRACKED/);
});

const movedPath = path.join("/home/test", ".claude-gh-guard", "moved.json");

test("doctor checks a moved repo live and caches it", async () => {
  const d = fakeDeps({
    files: repoFiles("git@github.com:alice/x.git"),
    now: () => 7,
    exec: (cmd, args) => (cmd === "gh" ? { code: 0, stdout: `tok_${args[3]}`, stderr: "" } : { code: 1, stdout: "", stderr: "" }),
    fetch: (async () => new Response(JSON.stringify({ full_name: "corp/x" }), { status: 200 })) as unknown as typeof fetch,
  });
  const out = await runDoctor(root, d);
  assert.match(out, /moved: yes, now corp\/x - fix: git remote set-url origin git@github\.com:corp\/x\.git/);
  assert.deepEqual(JSON.parse(d.readFile(movedPath)!), { "alice/x": { fullName: "corp/x", checkedAt: 7 } });
});

test("doctor moved states: no, unknown, n/a", async () => {
  const fresh = (fullName: string | null) =>
    fakeDeps({ files: { ...repoFiles("git@github.com:alice/x.git"), [movedPath]: JSON.stringify({ "alice/x": { fullName, checkedAt: 0 } }) } });
  assert.match(await runDoctor(root, fresh("alice/x")), /moved: no$/m);
  assert.match(await runDoctor(root, fresh(null)), /moved: unknown \(no login can see the repo\)/);
  assert.match(await runDoctor(root, fakeDeps({ files: repoFiles("git@github.com:alice/x.git") })), /moved: unknown \(GitHub API check failed\)/);
  assert.match(await runDoctor(root, fakeDeps({ files: repoFiles("git@gitlab.com:alice/x.git") })), /moved: \(n\/a\)/);
});
