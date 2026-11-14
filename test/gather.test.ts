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
