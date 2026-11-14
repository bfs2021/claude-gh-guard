# claude-gh-guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A zero-config, cross-platform Node CLI that shows GitHub identity state in the Claude Code status line and denies `git commit` / `git push` / `gh pr create` from Claude when the identity that command will actually use is definitely wrong.

**Architecture:** Small pure modules gather facts (gh hosts, git repo config, remote URL, SSH identity, user config, learned map) → a pure `evaluate()` turns facts into a verdict per command kind → thin commands (`statusline`, `hook`, `init`, `uninstall`, `doctor`, internal `learn`) do I/O around it. Everything with side effects (exec, fetch, fs roots, env, platform) is injected via a `Deps` object so tests run on any OS.

**Tech Stack:** TypeScript (erasable syntax only), Node >= 18 runtime, Node 24 for dev/tests (`node --test` runs `.ts` directly), esbuild bundles `src/cli.ts` → `dist/cli.js`. Dev deps only: `typescript`, `esbuild`, `@types/node`.

**Spec:** `docs/superpowers/specs/2026-11-15-claude-gh-guard-design.md`

## Global Constraints

- Runtime: Node.js >= 18; zero runtime dependencies (`"dependencies": {}`).
- Never write tokens to disk; get them only via `gh auth token --user <login>` in memory.
- Status line warm path < 100 ms on Windows; no network and no `gh` subprocess on the status line path (learning runs detached).
- Only definite MISMATCH denies. AMBIGUOUS / UNKNOWN / UNTRACKED / UNAUTH and any internal error → allow.
- gh config dir order: `GH_CONFIG_DIR` → (win32) `%APPDATA%\GitHub CLI` → `$XDG_CONFIG_HOME/gh` → `~/.config/gh`.
- State dir: `~/.claude-gh-guard/` (`learned.json`, `error.log`, `bin/cli.js`, `learn.lock`). Render cache: `os.tmpdir()/claude-gh-guard/`.
- Learned entries re-check after 7 days (`604800000` ms) or when the sorted logged-in login list changes.
- Learning timeouts: hook synchronous learning 3000 ms total; `ssh -T` 3000 ms.
- ASCII fallback: `--ascii` flag or env `GH_GUARD_ASCII=1` → `[OK]`, `[X]`, `[?]`, `[~]`, `[!]` instead of 🟢 🔴 ⚪ 🟡 ⚠️.
- Imports use explicit `.ts` extensions; no `enum`/`namespace`/parameter properties (`erasableSyntaxOnly`).

## Review Focus

1. **Paths with spaces on Windows** (`C:\Users\First Last\...`): `init` must write a command string that runs from Git Bash and cmd — pinned by a test in Task 11.
2. **Existing status line commands containing quotes/pipes** (e.g. `npx -y ccstatusline@latest | tee x`): `--after` must store and replay them byte-exact — pinned in Task 11 and Task 8.
3. **Old-format `hosts.yml`** (no `users:` map, only `user:` + `oauth_token:`): logins must be `[user]` — pinned in Task 1.
4. **`.git` as a file** (worktrees/submodules, `gitdir: ../.git/worktrees/x`) and **detached HEAD**: repo must still resolve; detached HEAD → push target falls back to `origin` — pinned in Task 2.
5. **`settings.json` that is not valid JSON** (user hand-edited, trailing comma): `init` must refuse and change nothing — pinned in Task 11.

---

### Task 1: Scaffold, deps, paths, gh hosts parsing

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `src/deps.ts`, `src/paths.ts`, `src/ghHosts.ts`
- Test: `test/ghHosts.test.ts`, `test/paths.test.ts`, `test/helpers.ts`

**Interfaces:**
- Produces:
  - `src/deps.ts`: `interface Deps { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; home: string; tmpdir: string; now(): number; readFile(p: string): string | null; writeFile(p: string, s: string): void; mtime(p: string): number | null; exec(cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number; input?: string; env?: NodeJS.ProcessEnv }): { code: number | null; stdout: string; stderr: string }; fetch: typeof fetch; spawnDetached(args: string[]): void }` and `realDeps(): Deps`. `readFile`/`mtime` return `null` when missing.
  - `src/paths.ts`: `ghConfigDir(d: Deps): string`, `stateDir(d: Deps): string`, `cacheDir(d: Deps): string`.
  - `src/ghHosts.ts`: `interface GhHosts { active: string | null; logins: string[]; hostsFile: string }`; `readGhHosts(d: Deps, host = "github.com"): GhHosts | null` (null when file missing); `parseHostsYml(text: string, host: string): { active: string | null; logins: string[] }`.
  - `test/helpers.ts`: `fakeDeps(overrides: Partial<Deps> & { files?: Record<string, string> }): Deps` — in-memory FS keyed by `path.normalize`d paths, `exec` defaults to `{code: 1, stdout: "", stderr: ""}`.

- [ ] **Step 1: Scaffold.** `package.json`: `"name": "claude-gh-guard"`, `"type": "module"`, `"bin": {"claude-gh-guard": "dist/cli.js"}`, `"engines": {"node": ">=18"}`, `"files": ["dist"]`, scripts `"test": "node --test \"test/**/*.test.ts\""`, `"typecheck": "tsc --noEmit"`, `"build": "esbuild src/cli.ts --bundle --platform=node --target=node18 --format=esm --outfile=dist/cli.js --banner:js=\"#!/usr/bin/env node\""`. `tsconfig.json`: `strict`, `module`/`moduleResolution` `nodenext`, `allowImportingTsExtensions`, `noEmit`, `erasableSyntaxOnly`. Run `npm i -D typescript esbuild @types/node`. `.gitignore`: `node_modules/`, `dist/`.

- [ ] **Step 2: Write failing tests**

```ts
// test/ghHosts.test.ts
test("multi-account hosts.yml", () => {
  const yml = "github.com:\n    git_protocol: ssh\n    users:\n        alice:\n            git_protocol: ssh\n        bob-work:\n    user: alice\n";
  assert.deepEqual(parseHostsYml(yml, "github.com"), { active: "alice", logins: ["alice", "bob-work"] });
});
test("old format without users map", () => {
  const yml = "github.com:\n    oauth_token: gho_x\n    user: alice\n    git_protocol: https\n";
  assert.deepEqual(parseHostsYml(yml, "github.com"), { active: "alice", logins: ["alice"] });
});
test("other host ignored, missing host → empty", () => {
  assert.deepEqual(parseHostsYml("ghe.corp:\n    user: bob\n", "github.com"), { active: null, logins: [] });
});
// test/paths.test.ts
test("GH_CONFIG_DIR wins", () => assert.equal(ghConfigDir(fakeDeps({ env: { GH_CONFIG_DIR: "/x" } })), "/x"));
test("win32 uses APPDATA", () => assert.equal(ghConfigDir(fakeDeps({ platform: "win32", env: { APPDATA: "C:\\A" } })), path.join("C:\\A", "GitHub CLI")));
test("XDG then ~/.config", () => {
  assert.equal(ghConfigDir(fakeDeps({ platform: "linux", env: { XDG_CONFIG_HOME: "/xdg" } })), path.join("/xdg", "gh"));
  assert.equal(ghConfigDir(fakeDeps({ platform: "darwin", env: {}, home: "/h" })), path.join("/h", ".config", "gh"));
});
```

- [ ] **Step 3: Run** `npm test` — Expected: FAIL (modules not found).
- [ ] **Step 4: Implement.** `parseHostsYml` is an indentation-based line parser for this subset only (top-level `host:` keys, 4-space children, `users:` grandchildren); never a general YAML parser. If `users` is absent, `logins = active ? [active] : []`.
- [ ] **Step 5: Run** `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 6: Commit** `feat: scaffold project and parse gh hosts.yml`

---

### Task 2: Git repo discovery and config reading

**Files:**
- Create: `src/gitRepo.ts`
- Test: `test/gitRepo.test.ts`

**Interfaces:**
- Consumes: `Deps`.
- Produces:
  - `type GitConfig = Map<string, string[]>` — keys `section.key` or `section.<subsection>.key`; section and key lowercased, subsection case preserved.
  - `parseGitConfig(text: string): GitConfig`
  - `interface Repo { workTree: string; gitDir: string; commonDir: string; configFile: string; config: GitConfig; branch: string | null }`
  - `findRepo(cwd: string, d: Deps): Repo | null`
  - `effectiveEmail(repo: Repo, d: Deps): { email: string | null; source: "local" | "git" | "none" }`
  - `remoteUrl(repo: Repo, name: string): string | null`
  - `pushRemoteName(repo: Repo, explicit?: string): string` — order: explicit → `branch.<b>.pushRemote` → `remote.pushDefault` → `branch.<b>.remote` → `"origin"`.

- [ ] **Step 1: Write failing tests**

```ts
test("parses sections, subsections, quoted values", () => {
  const c = parseGitConfig('[remote "origin"]\n\turl = git@github.com:Org/R.git\n[User]\n\tEmail = a@b.c\n[branch "main"]\n\tpushRemote = fork\n');
  assert.deepEqual(c.get("remote.origin.url"), ["git@github.com:Org/R.git"]);
  assert.deepEqual(c.get("user.email"), ["a@b.c"]);
  assert.deepEqual(c.get("branch.main.pushremote"), ["fork"]);
});
test("finds repo from nested dir and reads branch", () => { /* files: /r/.git/HEAD "ref: refs/heads/main\n", /r/.git/config; cwd /r/a/b → workTree /r, branch "main" */ });
test(".git file (worktree) resolves gitdir and commondir config", () => { /* /w/.git = "gitdir: /r/.git/worktrees/w\n", /r/.git/worktrees/w/commondir = "../..\n", HEAD there; configFile === /r/.git/config */ });
test("detached HEAD → branch null, pushRemoteName → origin", () => { /* HEAD = sha */ });
test("pushRemoteName precedence", () => { /* explicit > pushRemote > pushDefault > branch remote > origin */ });
test("effectiveEmail: local wins; else git config user.email via exec; else none", () => { /* exec stub returns {code:0, stdout:"x@y\n"} */ });
test("no repo → null", () => { assert.equal(findRepo("/nowhere", fakeDeps({})), null); });
```

- [ ] **Step 2: Run** `npm test` — Expected: FAIL.
- [ ] **Step 3: Implement.** `effectiveEmail` fallback runs `git config user.email` with `cwd: workTree`, 2000 ms timeout. (Caching is Task 8's job, not here.)
- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: read git repo config without spawning git`

---

### Task 3: Remote URL parsing and SSH host alias resolution

**Files:**
- Create: `src/remote.ts`
- Test: `test/remote.test.ts`

**Interfaces:**
- Produces:
  - `interface Remote { protocol: "ssh" | "https"; host: string; sshAlias: string | null; owner: string; repo: string }` (`host` is the real hostname after alias resolution; `sshAlias` is the original ssh host when it differed).
  - `parseRemoteUrl(url: string, sshConfigText: string | null): Remote | null`
  - `resolveSshHost(alias: string, sshConfigText: string | null): string` — `HostName` of first matching `Host` block (exact names and `*`/`?` globs), else alias.

- [ ] **Step 1: Write failing tests**

```ts
test("https", () => assert.deepEqual(parseRemoteUrl("https://github.com/Org/Repo.git", null), { protocol: "https", host: "github.com", sshAlias: null, owner: "Org", repo: "Repo" }));
test("https with user@ and no .git", () => assert.equal(parseRemoteUrl("https://me@github.com/o/r", null)?.owner, "o"));
test("scp-style", () => assert.deepEqual(parseRemoteUrl("git@github.com:o/r.git", null), { protocol: "ssh", host: "github.com", sshAlias: null, owner: "o", repo: "r" }));
test("ssh:// with port", () => assert.equal(parseRemoteUrl("ssh://git@github.com:22/o/r.git", null)?.repo, "r"));
test("alias resolved", () => {
  const cfg = "Host github.com-work\n  HostName github.com\n  IdentityFile ~/.ssh/work\n";
  assert.deepEqual(parseRemoteUrl("git@github.com-work:corp/app.git", cfg), { protocol: "ssh", host: "github.com", sshAlias: "github.com-work", owner: "corp", repo: "app" });
});
test("garbage → null", () => assert.equal(parseRemoteUrl("/local/path/repo", null), null));
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** `npm test && npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat: parse remote URLs and ssh host aliases`

---

### Task 4: Optional user config (`~/.gh-guard.json`)

**Files:**
- Create: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces:
  - `interface Profile { name: string; ghUser: string; gitEmails: string[]; owners: string[] }`
  - `loadConfig(d: Deps): { profiles: Profile[]; error: string | null }` — missing file → `{profiles: [], error: null}`; invalid JSON → `{profiles: [], error: "<message>"}`; `gitEmail` string or array normalized to `gitEmails`.
  - `matchProfile(profiles: Profile[], owner: string, repo: string): Profile | null` — any profile's exact `owner/repo` entry beats any owner-only entry; otherwise first profile in file order whose owners contain the owner. Owner comparison case-insensitive.

- [ ] **Step 1: Write failing tests**

```ts
test("owner/repo beats owner across profiles", () => {
  const p = [{ name: "a", ghUser: "A", gitEmails: [], owners: ["corp"] }, { name: "b", ghUser: "B", gitEmails: [], owners: ["corp/special"] }];
  assert.equal(matchProfile(p, "corp", "special")?.name, "b");
  assert.equal(matchProfile(p, "CORP", "other")?.name, "a");
});
test("gitEmail string normalized", () => { /* {"profiles":{"w":{"ghUser":"x","gitEmail":"e@x","owners":["o"]}}} → gitEmails ["e@x"] */ });
test("invalid JSON reports error, no throw", () => { /* error !== null, profiles [] */ });
```

- [ ] **Step 2–4:** run FAIL → implement → run `npm test && npm run typecheck` PASS.
- [ ] **Step 5: Commit** `feat: optional profile config`

---

### Task 5: Learning via GitHub API, with commit-history tie-break

**Files:**
- Create: `src/learn.ts`
- Test: `test/learn.test.ts`

**Interfaces:**
- Consumes: `Deps` (`exec` for `gh auth token --user <login>`, `fetch`, fs).
- Produces:
  - `interface LearnedEntry { pushers: string[]; expected: string | null; basis: "single" | "history" | "ambiguous" | "none"; checkedAt: number; loginsKey: string }` — `loginsKey` = sorted logins joined by `,`.
  - `learnRepo(owner: string, repo: string, logins: string[], d: Deps, timeoutMs: number): Promise<LearnedEntry | null>` — `null` on any network/API failure or timeout (never throws).
  - `readLearned(d: Deps): Record<string, LearnedEntry>`; `writeLearned(d: Deps, key: string, e: LearnedEntry): void` (read-modify-write of `~/.claude-gh-guard/learned.json`, key `owner/repo` lowercased).
  - `isFresh(e: LearnedEntry, logins: string[], now: number): boolean` — false if older than 604800000 ms or `loginsKey` differs.

Algorithm (spec §5.3): per login, token = `gh auth token --user <login>` stdout trimmed (skip login on non-zero exit); `GET https://api.github.com/repos/{owner}/{repo}` with `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `User-Agent: claude-gh-guard`; pusher if `permissions.push === true`. 0 pushers → `basis "none"`, expected null. 1 → `"single"`. 2+ → `GET /repos/{owner}/{repo}/commits?per_page=50` with a pusher's token, count `author.login` among the user's logins; unique max → `"history"`; zero hits or tie → `"ambiguous"`, expected null. All requests share one `AbortController` deadline of `timeoutMs`.

- [ ] **Step 1: Write failing tests** (stub `fetch` keyed by URL + token; stub `exec` for tokens)

```ts
test("single pusher", async () => { /* A push:true, B push:false → {pushers:["A"], expected:"A", basis:"single"} */ });
test("two pushers, history picks B", async () => { /* commits: 3×B, 1×A, 2×stranger → expected "B", basis "history" */ });
test("two pushers, no history → ambiguous", async () => { /* commits [] → expected null, basis "ambiguous" */ });
test("two pushers, tie → ambiguous", async () => {});
test("404 for both → none", async () => { /* basis "none", pushers [] */ });
test("network error → null", async () => { /* fetch rejects → null */ });
test("timeout → null", async () => { /* fetch never resolves, timeoutMs 50 → null within ~200ms */ });
test("token never written to disk", async () => { /* after writeLearned, no written file contains "gho_" */ });
test("isFresh: age and login-set change", () => {});
```

- [ ] **Step 2–4:** run FAIL → implement → run `npm test && npm run typecheck` PASS.
- [ ] **Step 5: Commit** `feat: learn expected account from push permissions and commit history`

---

### Task 6: Push identity (credential path + SSH key owner)

**Files:**
- Create: `src/pushIdentity.ts`
- Test: `test/pushIdentity.test.ts`

**Interfaces:**
- Consumes: `Remote` (Task 3), `Repo` (Task 2), `GhHosts` (Task 1), `Deps`.
- Produces:
  - `type PushIdentity = { via: "ssh"; login: string | null } | { via: "gh"; login: string | null } | { via: "unknown" }`
  - `pushIdentity(remote: Remote, repo: Repo, hosts: GhHosts | null, d: Deps, opts: { allowSpawn: boolean }): PushIdentity`
  - `parseSshHello(stderr: string): string | null` — `/Hi ([A-Za-z0-9-]+)!/`.

Rules: `remote.protocol === "ssh"` → if `allowSpawn`, run `ssh -T -o BatchMode=yes -o ConnectTimeout=3 git@<sshAlias ?? host>` (3000 ms timeout; GitHub exits 1 on success and greets on stderr) and cache the login in `~/.claude-gh-guard/ssh.json` keyed by alias with the max mtime of `~/.ssh/config` and `~/.ssh/id_*` files; if not allowed and no fresh cache → `{via:"ssh", login:null}`. HTTPS → `git config --get-all credential.https://github.com.helper` then `credential.helper` (via exec, cwd workTree); if any value contains `gh auth git-credential` → `{via:"gh", login: hosts.active}`; else `{via:"unknown"}`.

- [ ] **Step 1: Write failing tests**

```ts
test("parseSshHello", () => assert.equal(parseSshHello("Hi alice! You've successfully authenticated, but GitHub does not provide shell access."), "alice"));
test("ssh remote spawns ssh -T on alias and caches", () => { /* exec called once with args incl "git@github.com-work"; second call uses cache, exec not called */ });
test("ssh cache invalidated when ~/.ssh/config mtime changes", () => {});
test("allowSpawn false + no cache → login null", () => {});
test("https + gh helper → via gh, active login", () => {});
test("https + manager helper → unknown", () => {});
```

- [ ] **Step 2–4:** run FAIL → implement → run PASS.
- [ ] **Step 5: Commit** `feat: determine which account a push will actually use`

---

### Task 7: Expected-account resolution and verdict engine

**Files:**
- Create: `src/evaluate.ts`
- Test: `test/evaluate.test.ts`

**Interfaces:**
- Consumes: types from Tasks 1–6 (pure; no Deps).
- Produces:
  - `type State = "MATCH" | "MISMATCH" | "AMBIGUOUS" | "UNKNOWN" | "UNTRACKED" | "UNAUTH"`
  - `type Kind = "status" | "commit" | "push" | "pr"`
  - `interface Expected { login: string | null; source: "profile" | "owner" | "learned" | "none"; ambiguous: boolean; emails: string[] }`
  - `resolveExpected(remote: Remote, logins: string[], profiles: Profile[], learned: LearnedEntry | undefined): Expected` — order: profile → owner equals a login (case-insensitive, returns the login's canonical casing) → learned (`ambiguous` when `basis === "ambiguous"`) → none.
  - `interface Facts { hosts: GhHosts | null; remote: Remote | null; email: string | null; push: PushIdentity | null; expected: Expected | null }`
  - `interface Verdict { state: State; active: string | null; expected: string | null; problems: string[]; fixes: string[] }`
  - `evaluate(kind: Kind, f: Facts): Verdict`
  - `noreplyLogin(email: string): string | null` — matches `^(?:\d+\+)?([A-Za-z0-9-]+)@users\.noreply\.github\.com$`.

Per-kind checks (spec §5.1a; order of precedence for the final state: UNAUTH (no hosts / no active, kinds `status`/`pr` only) → UNTRACKED (no remote or host ≠ github.com) → MISMATCH (any failed check) → AMBIGUOUS → UNKNOWN (expected.login null) → MATCH):
- email check (`commit`, `status`): if `expected.emails` non-empty → email must be in it (case-insensitive); else if `noreplyLogin(email)` → must equal expected login; else skipped.
- gh check (`pr`, `status`): `hosts.active` must equal expected login.
- push check (`push`, `status`): `via "gh"|"ssh"` with non-null login → must equal expected login; `via "unknown"` or null login → skipped.
- `fixes` strings (exact): gh → `gh auth switch --user <expected>`; email → `git config user.email <expected.emails[0] or "<id>+<expected>@users.noreply.github.com">` ; ssh → `Configure an SSH key for <expected> (e.g. a Host alias in ~/.ssh/config) and set the remote: git remote set-url <remote> git@<alias>:<owner>/<repo>.git`.

- [ ] **Step 1: Write failing tests** (table-driven)

```ts
const remote = { protocol: "ssh", host: "github.com", sshAlias: null, owner: "corp", repo: "app" } as const;
const hosts = { active: "alice", logins: ["alice", "bob-work"], hostsFile: "" };
const exp = (login: string | null, extra = {}) => ({ login, source: "learned", ambiguous: false, emails: [], ...extra }) as Expected;
test("pr with wrong gh account → MISMATCH with gh fix", () => {
  const v = evaluate("pr", { hosts, remote, email: null, push: null, expected: exp("bob-work") });
  assert.equal(v.state, "MISMATCH"); assert.ok(v.fixes.includes("gh auth switch --user bob-work"));
});
test("commit ignores gh account; checks noreply email", () => {
  assert.equal(evaluate("commit", { hosts, remote, email: "12345+alice@users.noreply.github.com", push: null, expected: exp("bob-work") }).state, "MISMATCH");
  assert.equal(evaluate("commit", { hosts, remote, email: "me@company.com", push: null, expected: exp("bob-work") }).state, "MATCH");
});
test("push over ssh uses key owner, not gh account", () => {
  assert.equal(evaluate("push", { hosts: { ...hosts, active: "bob-work" }, remote, email: null, push: { via: "ssh", login: "alice" }, expected: exp("bob-work") }).state, "MISMATCH");
});
test("push via unknown helper → not MISMATCH", () => {});
test("ambiguous expected → AMBIGUOUS, never MISMATCH", () => {});
test("expected null → UNKNOWN", () => {});
test("no remote → UNTRACKED; no hosts on pr → UNAUTH; commit without hosts still evaluates email", () => {});
test("resolveExpected: owner==login beats learned; profile beats owner; case-insensitive owner", () => {});
```

- [ ] **Step 2–4:** run FAIL → implement → run PASS.
- [ ] **Step 5: Commit** `feat: per-command verdict engine`

---

### Task 8: Fact gathering, render, `statusline` command, detached `learn`

**Files:**
- Create: `src/gather.ts`, `src/render.ts`, `src/commands/statusline.ts`, `src/commands/learn.ts`, `src/cli.ts`
- Test: `test/gather.test.ts`, `test/render.test.ts`, `test/statusline.test.ts`

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces:
  - `gatherFacts(cwd: string, d: Deps, opts: { allowSpawn: boolean; remoteName?: string }): { facts: Facts; repo: Repo | null; needsLearn: { owner: string; repo: string } | null }` — `needsLearn` set when resolution fell through to learned and the entry is missing or not fresh.
  - `render(v: Verdict, push: PushIdentity | null, opts: { ascii: boolean; color: boolean }): string`
  - `runStatusline(stdin: string, argv: string[], d: Deps): string` (returns the line; `cli.ts` prints it)
  - `runLearn(argv: string[], d: Deps): Promise<void>` — `learn <owner> <repo>`; holds `~/.claude-gh-guard/learn.lock` (create-exclusive; stale after 60000 ms); writes the entry; always exits 0.
  - `src/cli.ts`: `main(argv: string[]): Promise<number>` dispatching `statusline | hook | init | uninstall | doctor | learn`; top-level try/catch appends to `error.log` and returns 0.

Render formats (exact, color via ANSI 32/31/33/37 when `color`):
- MATCH `🟢 gh:<active>`; MISMATCH `🔴 gh:<active> ≠ <expected>`; AMBIGUOUS `🟡 gh:<active> (ambiguous)`; UNKNOWN `⚪ gh:<active> (?)`; UNTRACKED `⚪ gh:<active> (no-remote)`; UNAUTH `⚠️ gh:not-logged-in`.
- When `push` is ssh/gh with a login ≠ `active`, append ` · push(<via>):<login>`.

Statusline behavior: parse stdin JSON; cwd = `workspace.current_dir` ?? `cwd` ?? `process.cwd()`. Cache file `cacheDir/<sha1(workTree or cwd)>.json` storing `{key, line}` where key = joined mtimes of hosts.yml, repo config file, `~/.gitconfig`, `~/.gh-guard.json`, `learned.json`, `ssh.json`; hit → reuse line. `allowSpawn: false`. If `needsLearn`, call `d.spawnDetached(["learn", owner, repo])`. `--after "<cmd>"`: run cmd through the platform shell (`d.exec` with `shell` semantics: win32 `cmd.exe /d /s /c`, else `/bin/sh -c`) with the same stdin, 2000 ms timeout; output `<their trimmed stdout> | <ours>`, or ours alone if theirs failed/empty. `--ascii` / `GH_GUARD_ASCII=1` → ascii; color off when `NO_COLOR` set.

- [ ] **Step 1: Write failing tests**

```ts
test("render MATCH emoji and ascii", () => {
  assert.equal(render({ state: "MATCH", active: "alice", expected: "alice", problems: [], fixes: [] }, null, { ascii: false, color: false }), "🟢 gh:alice");
  assert.equal(render({ state: "MISMATCH", active: "a", expected: "b", problems: [], fixes: [] }, null, { ascii: true, color: false }), "[X] gh:a ≠ b");
});
test("render appends differing push identity", () => { /* "… · push(ssh):alice" */ });
test("statusline uses workspace.current_dir and caches", () => { /* second call with unchanged mtimes doesn't call readFile for repo config */ });
test("statusline spawns learn for unknown org, does not fetch", () => { /* spawnDetached called with ["learn","corp","app"]; fetch never called */ });
test("--after prepends existing output byte-exact, including quotes and pipes", () => { /* stub exec returns "Ctx 48% | out 374tok"; result "Ctx 48% | out 374tok | 🟢 gh:alice" */ });
test("--after failure → ours alone", () => {});
test("learn lock prevents concurrent runs; stale lock reclaimed", async () => {});
```

- [ ] **Step 2–4:** run FAIL → implement → run PASS.
- [ ] **Step 5: Perf check.** `npm run build`, then in this repo run (PowerShell) `Measure-Command { '{"workspace":{"current_dir":"."}}' | node dist/cli.js statusline }` twice. Expected: second run < 100 ms on Windows. Record the number in the commit message.
- [ ] **Step 6: Commit** `feat: status line command with cache and background learning`

---

### Task 9: Hook command parser

**Files:**
- Create: `src/hook/parse.ts`
- Test: `test/hookParse.test.ts`

**Interfaces:**
- Produces:
  - `interface Guarded { kind: "commit" | "push" | "pr"; cwd: string; remoteName?: string; remoteUrl?: string; ghRepo?: string; emailOverride?: string }`
  - `parseCommand(command: string, baseCwd: string): Guarded[]`

Rules (spec §5.6): split on `&&`, `||`, `;`, `|`, newlines, respecting single/double quotes. Track a running cwd: a segment `cd <path>` updates it (relative to the current one) for later segments. Leading `VAR=value` assignments are allowed; `GIT_AUTHOR_EMAIL=<x>` → `emailOverride`. `git` global options before the subcommand: `-C <path>` (adjusts cwd for that segment), `-c user.email=<x>` → `emailOverride`, `-c <other>` ignored. Subcommand `commit` → commit; `push` → push with first non-option arg as `remoteName` (or `remoteUrl` if it contains `://` or `@` or `:`). `gh pr create` → pr, `--repo`/`-R <owner/repo>` → `ghRepo`. Everything else ignored.

- [ ] **Step 1: Write failing tests**

```ts
test("plain commit", () => assert.deepEqual(parseCommand('git commit -m "a && b"', "/r"), [{ kind: "commit", cwd: "/r" }]));
test("chained add+commit+push upstream", () => {
  assert.deepEqual(parseCommand("git add . && git commit -m x && git push upstream main", "/r").map(g => [g.kind, g.remoteName]), [["commit", undefined], ["push", "upstream"]]);
});
test("cd then git -C", () => { /* "cd sub && git -C ../other push" from /r → cwd path.resolve("/r","sub","../other") */ });
test("inline email overrides", () => {
  assert.equal(parseCommand("git -c user.email=me@p.com commit -m x", "/r")[0].emailOverride, "me@p.com");
  assert.equal(parseCommand("GIT_AUTHOR_EMAIL=me@p.com git commit -m x", "/r")[0].emailOverride, "me@p.com");
});
test("gh pr create --repo", () => assert.equal(parseCommand("gh pr create -R corp/app --fill", "/r")[0].ghRepo, "corp/app"));
test("push to raw URL", () => assert.equal(parseCommand("git push git@github.com:o/r.git", "/r")[0].remoteUrl, "git@github.com:o/r.git"));
test("non-guarded commands → []", () => assert.deepEqual(parseCommand("git status; echo 'git push'", "/r"), []));
```

- [ ] **Step 2–4:** run FAIL → implement → run PASS.
- [ ] **Step 5: Commit** `feat: parse guarded git/gh commands from Bash tool input`

---

### Task 10: `hook` command

**Files:**
- Create: `src/commands/hook.ts`
- Test: `test/hook.test.ts`

**Interfaces:**
- Consumes: `parseCommand`, `gatherFacts`, `evaluate`, `learnRepo`/`writeLearned`/`isFresh`.
- Produces: `runHook(stdin: string, d: Deps): Promise<{ stdout: string; exitCode: 0 }>`

Behavior: input JSON `{ tool_name, tool_input: { command }, cwd }`; non-`Bash` tool or no guarded segments → empty stdout. For each guarded segment: `gatherFacts(seg.cwd, d, { allowSpawn: true, remoteName })`; `remoteUrl` → parse it directly as the remote; `ghRepo` → remote with that owner/repo; for `pr` without `ghRepo` use remote `gh-resolved` config if any `remote.<n>.gh-resolved` is set, else `upstream` if present, else `origin`. If learning is needed, run `learnRepo` synchronously with the remaining part of a 3000 ms budget and persist it. `emailOverride` replaces `facts.email` for that segment. First MISMATCH → output

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"claude-gh-guard: <problems joined by '; '>. Fix: <fixes joined by ' && '>"}}
```

Otherwise, if any AMBIGUOUS/UNKNOWN/UNAUTH → `{"systemMessage":"claude-gh-guard: <state> for <owner>/<repo> — not blocked. Run claude-gh-guard doctor."}`. Any thrown error → empty stdout + `error.log` line. Before implementing, confirm the PreToolUse JSON output fields against the current Claude Code hooks docs (https://docs.claude.com/en/docs/claude-code/hooks) and adjust the two shapes above if they changed.

- [ ] **Step 1: Write failing tests**

```ts
test("work repo, personal ssh key → deny push with fix", async () => { /* learned corp/app expected bob-work; ssh greets alice → permissionDecision "deny", reason contains "git remote set-url" */ });
test("pr with wrong gh account → deny with gh auth switch", async () => {});
test("commit with -c personal noreply in work repo → deny", async () => {});
test("unknown org, API timeout → allow with systemMessage", async () => {});
test("non-Bash tool → empty", async () => {});
test("internal error → empty stdout, error logged", async () => {});
```

- [ ] **Step 2–4:** run FAIL → implement → run PASS.
- [ ] **Step 5: Commit** `feat: PreToolUse hook denies definite identity mismatches`

---

### Task 11: `init`, `uninstall`, `doctor`

**Files:**
- Create: `src/commands/init.ts`, `src/commands/doctor.ts`
- Test: `test/init.test.ts`, `test/doctor.test.ts`

**Interfaces:**
- Produces:
  - `runInit(d: Deps, selfPath: string): string` (returns a human summary), `runUninstall(d: Deps): string`, `runDoctor(cwd: string, d: Deps): string`.
  - `shellQuote(p: string): string` — wraps in double quotes and converts backslashes to forward slashes (works in Git Bash and cmd on Windows; unchanged semantics on POSIX).

init (spec §5.7): settings path `~/.claude/settings.json` (create `{}` if missing). Parse with `JSON.parse`; on failure → return an error message and write nothing. Back up to `settings.json.bak-<YYYYMMDD-HHmmss>`. Copy `selfPath` to `~/.claude-gh-guard/bin/cli.js`. Command base = `node ` + `shellQuote(<that path>)`. `statusLine`: if absent → `{ "type": "command", "command": "<base> statusline" }`; if present and not already ours → store the original object under `~/.claude-gh-guard/original-statusline.json` and set command to `<base> statusline --after <JSON.stringify(original.command)>`; if already ours → refresh base only. Hooks: ensure exactly one entry `{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "<base> hook" }] }` in `hooks.PreToolUse`, identified by command containing `claude-gh-guard` (replace on re-run). Preserve all other keys and their order. Write with 2-space indent.

uninstall: remove our hook entry (drop empty arrays/objects we emptied), restore original status line from the saved file or delete `statusLine` if we created it, delete `~/.claude-gh-guard/bin/`.

doctor: multi-line report with exactly these labels: `gh config:`, `logins:`, `active:`, `repo:`, `remote:`, `email:` (with source), `push identity:`, `expected:` (with source / learned basis), `state:`, `time:` (ms). For AMBIGUOUS, print a ready-to-paste `~/.gh-guard.json` snippet pinning `owner` to a login.

- [ ] **Step 1: Write failing tests**

```ts
test("fresh settings: adds statusLine and hook", () => {});
test("path with spaces quoted and slashes normalized", () => {
  assert.equal(shellQuote("C:\\Users\\First Last\\.claude-gh-guard\\bin\\cli.js"), '"C:/Users/First Last/.claude-gh-guard/bin/cli.js"');
});
test("existing statusLine wrapped byte-exact", () => {
  /* original command `npx -y ccstatusline@latest | tee "x y"` → new command ends with ' statusline --after "npx -y ccstatusline@latest | tee \\"x y\\""' and original saved */
});
test("idempotent: second init leaves one hook entry and no double wrapping", () => {});
test("invalid JSON settings → error, file unchanged, no backup", () => {});
test("other keys preserved", () => { /* {"model":"opus","permissions":{...}} survive */ });
test("uninstall restores original statusLine and removes hook", () => {});
test("doctor AMBIGUOUS prints pin snippet", () => {});
```

- [ ] **Step 2–4:** run FAIL → implement → run PASS.
- [ ] **Step 5: Manual verification on this machine.** `npm run build`, then `node dist/cli.js init`; open Claude Code in a personal repo → `🟢 gh:alice`; in a `bob-work`-owned or org repo → verify the expected state and that asking Claude to `git push` is denied with the fix text; run `node dist/cli.js uninstall` and confirm settings restored (diff against backup).
- [ ] **Step 6: Commit** `feat: init, uninstall, and doctor commands`

---

### Task 12: CI matrix, README, publish readiness

**Files:**
- Create: `.github/workflows/ci.yml`, `README.md`, `LICENSE` (MIT)
- Modify: `package.json` (`"prepublishOnly": "npm run typecheck && npm test && npm run build"`, `repository`, `keywords`)

- [ ] **Step 1: CI.** Matrix `os: [ubuntu-latest, macos-latest, windows-latest]`, Node 24: `npm ci`, `npm run typecheck`, `npm test`, `npm run build`. Extra job on Node 18 (all three OSes): `npm ci && npm run build && echo '{}' | node dist/cli.js statusline` must exit 0 (proves the bundle runs on the floor version).
- [ ] **Step 2: README.** One-line pitch ("Stop Claude Code from committing to your work repo with your personal GitHub account"), install (`npx claude-gh-guard init`), states table from spec §5.4, per-command identity table from spec §5.1a, optional `~/.gh-guard.json` example, `doctor`, `uninstall`, Windows notes (gh config path, ASCII fallback), placeholder for the demo GIF.
- [ ] **Step 3: Verify.** `npm pack --dry-run` lists only `dist/cli.js`, `package.json`, `README.md`, `LICENSE`. `npm run prepublishOnly` passes.
- [ ] **Step 4: Commit** `chore: CI matrix, README, packaging`
