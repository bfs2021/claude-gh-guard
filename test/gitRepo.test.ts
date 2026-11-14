import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fakeDeps } from "./helpers.ts";
import { parseGitConfig, findRepo, effectiveEmail, remoteUrl, pushRemoteName } from "../src/gitRepo.ts";
import type { Repo } from "../src/gitRepo.ts";

const j = path.join;

function mk(files: Record<string, string>, cwd: string) {
  const d = fakeDeps({ files });
  return { d, repo: findRepo(cwd, d)! };
}

test("parses sections, subsections, quoted values", () => {
  const c = parseGitConfig('[remote "origin"]\n\turl = git@github.com:Org/R.git\n[User]\n\tEmail = a@b.c\n[branch "main"]\n\tpushRemote = fork\n');
  assert.deepEqual(c.get("remote.origin.url"), ["git@github.com:Org/R.git"]);
  assert.deepEqual(c.get("user.email"), ["a@b.c"]);
  assert.deepEqual(c.get("branch.main.pushremote"), ["fork"]);
});

test("parses comments, escapes, bare keys, multi-values, old subsection syntax", () => {
  const c = parseGitConfig('# c\n; c\n[core]\n\tbare\n\tname = "a \\"q\\" \\ b"\n\tx = 1 ; trailing\n[remote.up]\n\turl = u1\n\turl = u2\n[Remote "Mixed"]\n\turl = m\n');
  assert.deepEqual(c.get("core.bare"), ["true"]);
  assert.deepEqual(c.get("core.name"), ['a "q" \ b']);
  assert.deepEqual(c.get("core.x"), ["1"]);
  assert.deepEqual(c.get("remote.up.url"), ["u1", "u2"]);
  assert.deepEqual(c.get("remote.Mixed.url"), ["m"]);
});

test("finds repo from nested dir and reads branch", () => {
  const r = path.resolve("/r");
  const { repo } = mk({
    [j(r, ".git", "HEAD")]: "ref: refs/heads/main\n",
    [j(r, ".git", "config")]: '[remote "origin"]\n\turl = u\n',
  }, j(r, "a", "b"));
  assert.equal(repo.workTree, r);
  assert.equal(repo.gitDir, j(r, ".git"));
  assert.equal(repo.branch, "main");
  assert.equal(remoteUrl(repo, "origin"), "u");
  assert.equal(remoteUrl(repo, "nope"), null);
});

test(".git file (worktree) resolves gitdir and commondir config", () => {
  const r = path.resolve("/r"), w = path.resolve("/w");
  const wt = j(r, ".git", "worktrees", "w");
  const { repo } = mk({
    [j(w, ".git")]: `gitdir: ${wt}\n`,
    [j(wt, "commondir")]: "../..\n",
    [j(wt, "HEAD")]: "ref: refs/heads/feat/x\n",
    [j(r, ".git", "config")]: "[user]\n\temail = w@x\n",
  }, w);
  assert.equal(repo.workTree, w);
  assert.equal(repo.gitDir, wt);
  assert.equal(path.normalize(repo.commonDir), j(r, ".git"));
  assert.equal(path.normalize(repo.configFile), j(r, ".git", "config"));
  assert.equal(repo.branch, "feat/x");
  assert.deepEqual(repo.config.get("user.email"), ["w@x"]);
});

test("relative gitdir resolves against the .git file", () => {
  const w = path.resolve("/w");
  const { repo } = mk({
    [j(w, ".git")]: "gitdir: ../mod/.git/modules/w\n",
    [j(w, "..", "mod", ".git", "modules", "w", "HEAD")]: "ref: refs/heads/m\n",
  }, w);
  assert.equal(repo.branch, "m");
  assert.equal(path.normalize(repo.gitDir), path.resolve(w, "..", "mod", ".git", "modules", "w"));
});

test("detached HEAD → branch null, pushRemoteName → origin", () => {
  const r = path.resolve("/r");
  const { repo } = mk({ [j(r, ".git", "HEAD")]: "0123456789abcdef0123456789abcdef01234567\n" }, r);
  assert.equal(repo.branch, null);
  assert.equal(pushRemoteName(repo), "origin");
});

test("pushRemoteName precedence", () => {
  const r = path.resolve("/r");
  const cfg = (s: string) => mk({
    [j(r, ".git", "HEAD")]: "ref: refs/heads/main\n",
    [j(r, ".git", "config")]: s,
  }, r).repo;
  const full = cfg('[branch "main"]\n\tpushRemote = pr\n\tremote = br\n[remote]\n\tpushDefault = pd\n');
  assert.equal(pushRemoteName(full, "ex"), "ex");
  assert.equal(pushRemoteName(full), "pr");
  assert.equal(pushRemoteName(cfg('[branch "main"]\n\tremote = br\n[remote]\n\tpushDefault = pd\n')), "pd");
  assert.equal(pushRemoteName(cfg('[branch "main"]\n\tremote = br\n')), "br");
  assert.equal(pushRemoteName(cfg("")), "origin");
});

test("effectiveEmail: local wins; else git config user.email via exec; else none", () => {
  const r = path.resolve("/r");
  const files = { [j(r, ".git", "HEAD")]: "ref: refs/heads/main\n" };
  const local = mk({ ...files, [j(r, ".git", "config")]: "[user]\n\temail = l@x\n" }, r);
  assert.deepEqual(effectiveEmail(local.repo, local.d), { email: "l@x", source: "local" });

  let call: unknown;
  const d = fakeDeps({ files, exec: (c, a, o) => { call = [c, a, o?.cwd, o?.timeoutMs]; return { code: 0, stdout: "x@y\n", stderr: "" }; } });
  const repo = findRepo(r, d)!;
  assert.deepEqual(effectiveEmail(repo, d), { email: "x@y", source: "git" });
  assert.deepEqual(call, ["git", ["config", "user.email"], r, 2000]);

  const none = mk(files, r);
  assert.deepEqual(effectiveEmail(none.repo, none.d), { email: null, source: "none" });
  const d2 = fakeDeps({ files, exec: () => ({ code: 0, stdout: "\n", stderr: "" }) });
  assert.deepEqual(effectiveEmail(findRepo(r, d2)!, d2), { email: null, source: "none" });
});

test("no repo → null", () => {
  assert.equal(findRepo(path.resolve("/nowhere"), fakeDeps({})), null);
});

test("Repo type is exported", () => {
  const x: Repo | null = null;
  assert.equal(x, null);
});
