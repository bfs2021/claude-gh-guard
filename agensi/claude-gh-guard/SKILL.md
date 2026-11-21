---
name: claude-gh-guard
description: Installs, checks and troubleshoots claude-gh-guard, which stops Claude Code from running git commit, git push or gh pr create with the wrong GitHub account (for example your personal account in a work repo). Use when the user has several GitHub accounts, asks which account a repo will use, or wants to set up, debug or remove the guard.
summary: Stop Claude Code from committing to your work repo with your personal GitHub account. Free and open source (MIT).
version: 0.3.0
tags: [claude-code, github, git, gh, security, hooks, statusline]
keywords: [wrong github account, multiple github accounts, gh auth switch, work and personal account, git author email, pre-commit guard]
use_cases:
  - Block commits and pushes made with the wrong GitHub account
  - See which GitHub and Claude account is active for the current repo
  - Map work and personal GitHub accounts to repo owners
docs_url: https://github.com/seuthootDev/claude-gh-guard#readme
---

# claude-gh-guard

claude-gh-guard is a free, open-source (MIT) npm CLI for **Claude Code only**. It adds:

- a **status line segment** showing which GitHub account is in play for the current repo, plus the Claude account in use
- a **`PreToolUse` hook** that blocks `git commit`, `git push` and `gh pr create` when the identity is **definitely** wrong

Only a definite mismatch blocks. Ambiguous, unknown or error states always let the command through.

Source: https://github.com/seuthootDev/claude-gh-guard

It relies on Claude Code hooks and the status line, so it does not work in Cursor, Copilot or other agents. If the user is not using Claude Code, say so and stop.

## Install

1. Check the prerequisites, and tell the user what is missing:
   - `node --version` must be 18 or newer
   - `gh auth status` should show at least one logged-in account (the guard reads gh's accounts)
2. Tell the user that `init` edits their Claude Code `settings.json`: it backs it up, sets the status line (an existing one is kept and wrapped), and adds a `PreToolUse` hook with matcher `Bash`. **Ask before running it.**
3. Run:
   ```sh
   npx claude-gh-guard init
   ```
   If the user keeps settings somewhere else, add `--settings <path>`. `$CLAUDE_CONFIG_DIR/settings.json` is used when that variable is set.
4. Tell the user to restart Claude Code so the hook and status line load.
5. In a GitHub repo, run `npx claude-gh-guard doctor` and summarize the result (see below).

## Read the result of `doctor`

`doctor` prints the gh logins, active account, remote, whether the repo was transferred or renamed (`moved:`, with the `git remote set-url` fix), effective commit email, push identity, the expected account and why, and the resulting state.

| State | Meaning | Blocks? | What to tell the user |
|---|---|---|---|
| MATCH | Active account is the expected one | no | All good. |
| MISMATCH | Wrong active account, or wrong author email | **yes** | Switch with `gh auth switch -u <expected>` or fix `git config user.email`, as `doctor` shows. |
| AMBIGUOUS | Several of the user's accounts can push and history doesn't decide | no | Add a profile (below). `doctor` prints a ready-to-paste snippet. |
| UNKNOWN | Expected account can't be determined yet | no | Usually still learning, no access, or an API error. Re-run later or add a profile. |
| UNTRACKED | Not a git repo, no origin, or not github.com | no | Nothing to check here. |
| UNAUTH | `gh` has no active login | no | Run `gh auth login`. |

## Optional profiles

To pin which account belongs to which owner, write `~/.gh-guard.json`. Ask the user for their logins, emails and orgs instead of guessing:

```json
{
  "profiles": {
    "personal": {
      "ghUser": "personal-login",
      "gitEmail": "me@example.com",
      "owners": ["personal-login"]
    },
    "work": {
      "ghUser": "work-login",
      "gitEmail": ["me@company.com"],
      "owners": ["company-org", "other-org/one-repo"]
    }
  }
}
```

`owners` entries are an owner or an exact `owner/repo` (the exact repo wins, no wildcards). The first matching profile wins. Run `doctor` again afterwards to confirm.

## When a command is blocked

The hook's message names the expected account and the fix. Don't work around it by changing the email inline or with environment variables. Tell the user what is wrong and let them switch accounts.

## Display options

If emoji don't render, set `GH_GUARD_ASCII=1` (or pass `--ascii`). `NO_COLOR` disables colors.

## Uninstall

```sh
npx claude-gh-guard uninstall
```

This removes the hook and restores the original status line.

## Known limits (never blocks, only limits checking)

- Only `github.com` is tracked. GitHub Enterprise is untracked.
- Commands inside subshells or behind `env` / `command` prefixes are not inspected.
- Custom SSH commands and non-gh HTTPS credential helpers make the push identity unknown.
- The status line shows the SSH push identity only after `doctor` or the hook has probed it once.

## Issues and feedback

Report bugs or ask for features at https://github.com/seuthootDev/claude-gh-guard/issues
