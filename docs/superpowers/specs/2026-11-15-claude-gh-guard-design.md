# claude-gh-guard ??Design

Date: 2026-11-15
Status: Approved 2026-11-15

## 1. Intent

Developers who use several GitHub accounts on one machine (personal + work/client) let Claude Code
run `git commit`, `git push`, and `gh pr create` on their behalf. When the active `gh` account, the
repo's git author email, and the repo's owner don't line up, the agent silently commits or opens PRs
under the wrong identity. Existing tools either only switch accounts manually (gwitch: Python,
macOS/Linux, shell-prompt only, no Claude Code integration) or show unrelated status (ccstatusline).

claude-gh-guard makes the mismatch **visible** (Claude Code status line) and **impossible to act on by
accident** (Claude Code PreToolUse hook that denies the command), with **zero configuration** and
**first-class Windows support**. Goal: be first in this niche.

## 2. Goals / Non-goals / Anti-goals

Goals (MVP)
- Status line segment showing the identity state for the current directory.
- PreToolUse hook that denies `git commit` / `git push` / `gh pr create` when the state is a definite
  mismatch, with a message telling the user (and Claude) exactly how to fix it.
- Zero-config: works with only `gh` logged in to 1+ accounts. Works for org repos via automatic
  learning (see 짠5.3).
- `init` / `uninstall` that register/unregister the status line and hook in `~/.claude/settings.json`,
  composing with an existing status line instead of replacing it.
- `doctor` that prints what was detected and why.
- Windows, macOS, Linux.

Non-goals (MVP)
- `sync` command that switches accounts (Phase 2; gwitch already covers this).
- Claude Code plugin packaging (Phase 2, thin wrapper over this package).
- Shell prompt / Starship integration, git-level hooks for non-Claude git usage.
- SSH host-alias switching, GitHub Enterprise hosts other than github.com (design must not preclude
  GHE, but only github.com is tested).

Anti-goals (failure even if it "works")
- False-positive denials. Blocking legitimate work is worse than missing a mismatch; when unsure, warn,
  don't deny.
- Making Claude Code feel slow.
- Persisting tokens anywhere, or hitting the network on every status line render.

## 3. Constraints

- Node.js >= 18 (global `fetch`). Zero runtime dependencies. Written in TypeScript, shipped as JS.
- Status line: < 100 ms on a warm cache on Windows (Node startup alone is ~40??0 ms there).
- Must read gh config on all OSes:
  `GH_CONFIG_DIR` ??Windows `%APPDATA%\GitHub CLI` ??`$XDG_CONFIG_HOME/gh` ??`~/.config/gh`.
  Tokens may live in the OS keyring (verified on the author's Windows machine: `hosts.yml` has no
  token), so never read tokens from the file; obtain them via `gh auth token --user <login>` only when
  needed and only in memory.

## 4. Approaches considered

1. **Single npm CLI with subcommands (CHOSEN).** `statusline`, `hook`, `init`, `uninstall`,
   `doctor`, and an internal `learn`. One identity engine shared by status line and hook so they never
   disagree. Plugin packaging later wraps the same CLI.
2. Claude Code plugin first. One-command install for hooks, but unclear whether a plugin can set
   `statusLine`; would still need a separate setup step. Deferred to Phase 2 as a wrapper.
3. Bash + PowerShell scripts. No Node needed, but two implementations that will drift; Windows parity
   is the core differentiator, so rejected.

Org-repo handling options: A) automatic learning via GitHub API (CHOSEN), B) require config file,
C) ask on first push and remember (rejected: a wrong answer gets baked in).

When several of the user's accounts can push: A) pick the account with the most recent commits in the
repo (CHOSEN), B) warn-only "ambiguous" state (used as fallback when history doesn't decide),
C) accept any pusher (rejected: no protection when a personal account is also in the work org).

## 5. Design

### 5.1 Inputs gathered (per directory)

- **Logged-in accounts and active account**: parse `hosts.yml` for host `github.com`: keys under
  `users:` = logged-in logins; `user:` = active login. No `gh` subprocess.
- **Repo**: walk up from cwd to find `.git` (directory, or file with `gitdir:` for worktrees /
  submodules). Read `remote.origin.url` and local `user.email` from the repo config file directly.
- **Effective author email**: if local config has `user.email`, use it. Otherwise run
  `git config user.email` once (handles global + `includeIf`) and cache it keyed by mtimes of the repo
  config and `~/.gitconfig`.
- **Remote owner/repo**: parse https, `ssh://`, and scp-style (`git@host:owner/repo.git`) URLs. If the
  host isn't `github.com`, resolve SSH host aliases (`github.com-work`) by reading `~/.ssh/config`
  `Host`/`HostName`; if it still isn't github.com ??treat as UNTRACKED.

### 5.1a Which identity each command actually uses (per-command checks)

A single "gh account" check is wrong for most commands, and denying on it would be a false positive:

| Command | Identity that matters | How we determine it |
|---|---|---|
| `git commit` | author email only | effective email (짠5.1, incl. inline `-c user.email` overrides) |
| `git push` over HTTPS with `gh auth git-credential` helper | active gh account | `hosts.yml` `user:` |
| `git push` over SSH | the account owning the SSH key used for that host | `ssh -T git@<host or alias>` ??parse `Hi <login>!`; cache per host alias, invalidated by mtime of `~/.ssh/config` and the identity files; 3 s timeout |
| `git push` over HTTPS with any other helper (e.g. Git Credential Manager) | unknown | treat push identity as UNKNOWN (no deny) |
| `gh pr create` (and other `gh` writes) | active gh account | `hosts.yml` `user:` |

Context from the author's Windows machine: remotes use SSH with a single `~/.ssh/id_rsa` and no
`~/.ssh/config`, and global `user.email` is the personal noreply address. So there, `gh auth switch`
does **not** change who pushes ??the status line must reflect that (see 짠5.4).

The status line shows the gh account and flags a separate push identity when it differs, e.g.
`?뵶 gh:alice ??쨌 push(ssh):alice ??bob-work`.

### 5.2 Expected account resolution (in order)

1. User config `~/.gh-guard.json` (optional). Format:
   ```json
   { "profiles": {
       "personal": { "ghUser": "alice", "gitEmail": "personal@example.com", "owners": ["alice"] },
       "work": { "ghUser": "bob-work", "gitEmail": ["a@company.com"], "owners": ["company-org", "other-org/one-repo"] }
   } }
   ```
   `owners` entries are an owner (`company-org`) or an exact `owner/repo`; `owner/repo` beats owner;
   no wildcards. First matching profile wins. `gitEmail` is a string or array of allowed emails.
   A matching profile sets expected = `ghUser` and expected emails = `gitEmail`, and skips learning.
2. Remote owner equals a logged-in login ??expected = that login.
3. Learned map (짠5.3) has an entry for `owner/repo` ??expected = the set of logins with push access.
4. Otherwise UNKNOWN; trigger learning.

### 5.3 Automatic learning (Approach A)

For `owner/repo` not resolvable by 1??: for each logged-in login, get its token via
`gh auth token --user <login>` and call `GET https://api.github.com/repos/{owner}/{repo}`; record
logins whose response has `permissions.push === true`. This works for orgs and collaborator repos
without needing `read:org`.

- Status line never blocks on this: it spawns a detached `learn` process (de-duplicated with a lock
  file) and shows UNKNOWN until the result lands.
- The hook may learn synchronously with a 3 s total timeout, because correctness matters more at
  commit/push time.
- Store results in `~/.claude-gh-guard/learned.json` as `{ "owner/repo": { pushers: [...], checkedAt } }`.
  Re-check after 7 days, or immediately when the set of logged-in logins changes.
- If no login has push access, or the API fails/times out ??UNKNOWN (never MISMATCH).
- **Tie-break when 2+ logins have push access (user decision: commit history).** Call
  `GET /repos/{owner}/{repo}/commits?per_page=50` (default branch) with any pusher's token; count
  commits whose `author.login` is one of the user's logins. Expected = the login with the most
  commits. If none of the user's logins appear (new repo, no history) or there is an exact tie ??  AMBIGUOUS. Store as `{ pushers, expected, basis: "history" | "single" | "ambiguous", checkedAt }`.
- Rule 2 in 짠5.2 (owner == a login) still wins over learning: a repo owned by `alice` expects
  `alice` even if the work account is a collaborator.

### 5.4 States

| State | Condition | Status line | Hook |
|---|---|---|---|
| MATCH | active ??expected, and email check passes or is skipped | ?윟 gh:alice | allow |
| MISMATCH | active ??expected, or email check fails | ?뵶 gh:alice ??bob-work | **deny** |
| AMBIGUOUS | several of the user's logins can push and history doesn't decide | ?윞 gh:alice (ambiguous) | allow + warning; `doctor` prints the `~/.gh-guard.json` line to pin it |
| UNKNOWN | expected not determinable (learning, no access, API error) | ??gh:alice (?) | allow + warning |
| UNTRACKED | not a git repo / no origin / non-GitHub remote | ??gh:alice (no-remote) | allow |
| UNAUTH | no hosts.yml or no active user | ?좑툘 gh:not-logged-in | allow + warning |

Email check: run only when the expected email is known ??from a config profile, or when the author
email is a GitHub noreply address (`<id>+<login>@users.noreply.github.com` or
`<login>@users.noreply.github.com`), in which case `<login>` must be in the expected set. Otherwise
skipped (gh's default token scopes can't list account emails).

Output: ANSI colors + emoji by default; ASCII fallback (`[OK]`, `[X]`, `[?]`, `[!]`) via
`--ascii` or env `GH_GUARD_ASCII=1`.

### 5.5 Status line command

`claude-gh-guard statusline [--after "<cmd>"]`
- Reads Claude Code's status line JSON from stdin; uses its current-directory field (fallback: process
  cwd).
- `--after`: runs the user's pre-existing status line command with the same stdin and prints
  `<their output> | <our segment>`. If theirs fails, print ours alone.
- Cache of the computed state in `os.tmpdir()/claude-gh-guard/` keyed by repo path, invalidated by
  mtimes of `hosts.yml`, repo config, `~/.gitconfig`, `~/.gh-guard.json`, `learned.json`.

### 5.6 Hook command

`claude-gh-guard hook` registered as PreToolUse with matcher `Bash`.
- Reads hook JSON from stdin; inspects `tool_input.command`.
- Split on `&&`, `||`, `;`, `|`, newlines; a segment is guarded if it is `git ??commit`, `git ??push`,
  or `gh pr create`. Honor `git -C <path>` and a leading `cd <path> &&` for the working directory;
  otherwise use the hook's `cwd`.
- Target repo per segment: `git push <remote>` uses that remote's URL; bare `git push` uses
  `branch.<cur>.pushRemote` ??`remote.pushDefault` ??`branch.<cur>.remote` ??`origin`.
  `gh pr create --repo X` uses X; otherwise the gh-resolved base repo (`gh-resolved` remote config
  if set, else `upstream` if present, else `origin`). A raw URL target or anything unresolvable ??  UNKNOWN for that segment (no deny).
- Honor inline overrides `git -c user.email=<x>` / `GIT_AUTHOR_EMAIL=<x>` as the effective email for
  that segment (the known failure where an agent injects a personal email).
- MISMATCH ??deny with a reason that includes the fix, e.g.
  `Active gh account is alice but bob-work/??expects bob-work. Run: gh auth switch --user bob-work`
  (plus `git config user.email ?? when the email is wrong).
- Anything else ??allow; UNKNOWN/UNAUTH add a non-blocking warning.
- Any internal error ??allow (fail open) and log to `~/.claude-gh-guard/error.log`.

### 5.7 init / uninstall / doctor

- `init`: back up `~/.claude/settings.json` to `settings.json.bak-<timestamp>`; set `statusLine`
  to `node "<absolute path to installed cli>" statusline`, wrapping any existing status line via
  `--after`; add the PreToolUse hook entry. Idempotent. Paths JSON-escaped for Windows backslashes.
  The CLI ships as a single bundled JS file. `init` (whether run via `npx` or a global install) copies
  it to `~/.claude-gh-guard/bin/cli.js` and points settings there, so the npx cache disappearing never
  breaks Claude Code. Re-running `init` upgrades the copy; `uninstall` deletes it.
- `uninstall`: remove only our entries, restore the wrapped status line command.
- `doctor`: print gh config path, logged-in/active logins, repo, remote owner, effective email and its
  source, expected set and its source, final state, timing.

## 6. Left to the builder

- Module layout, TypeScript build setup, test structure (`node:test`).
- Exact YAML subset parsing for `hosts.yml` (no dependency; the file format is simple).
- Exact hook output format (exit code 2 vs JSON `permissionDecision`) ??whichever current Claude Code
  docs specify; verify against docs.
- Lock-file mechanics for de-duplicating `learn`.

## 7. Success criteria

- On the author's Windows machine (accounts `alice`, `bob-work`): personal repo ???윟;
  work org repo with personal account active ???뵶 and Claude's `git push` is denied with a fix message;
  after `gh auth switch` ???윟 and push allowed.
- Same behavior on macOS and Linux (CI matrix).
- Warm status line < 100 ms on Windows.
- No denial ever produced from UNKNOWN.
