import type { GhHosts } from "./ghHosts.ts";
import type { Remote } from "./remote.ts";
import type { Profile } from "./config.ts";
import { matchProfile } from "./config.ts";
import type { LearnedEntry } from "./learn.ts";
import type { PushIdentity } from "./pushIdentity.ts";

export type State = "MATCH" | "MISMATCH" | "AMBIGUOUS" | "UNKNOWN" | "UNTRACKED" | "UNAUTH";
export type Kind = "status" | "commit" | "push" | "pr";

export interface Expected {
  login: string | null;
  source: "profile" | "owner" | "learned" | "none";
  ambiguous: boolean;
  emails: string[];
}

export interface Facts {
  hosts: GhHosts | null;
  remote: Remote | null;
  email: string | null;
  push: PushIdentity | null;
  expected: Expected | null;
  remoteName: string;
}

export interface Verdict {
  state: State;
  active: string | null;
  expected: string | null;
  problems: string[];
  fixes: string[];
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function noreplyLogin(email: string): string | null {
  return /^(?:\d+\+)?([A-Za-z0-9-]+)@users\.noreply\.github\.com$/.exec(email)?.[1] ?? null;
}

export function resolveExpected(
  remote: Remote,
  logins: string[],
  profiles: Profile[],
  learned: LearnedEntry | undefined,
): Expected {
  const canon = (l: string) => logins.find((x) => eq(x, l)) ?? l;
  const p = matchProfile(profiles, remote.owner, remote.repo);
  if (p) return { login: canon(p.ghUser), source: "profile", ambiguous: false, emails: p.gitEmails };
  const owned = logins.find((l) => eq(l, remote.owner));
  if (owned) return { login: owned, source: "owner", ambiguous: false, emails: [] };
  if (learned) {
    if (learned.basis === "ambiguous") return { login: null, source: "learned", ambiguous: true, emails: [] };
    if (learned.expected) return { login: canon(learned.expected), source: "learned", ambiguous: false, emails: [] };
  }
  return { login: null, source: "none", ambiguous: false, emails: [] };
}

export function evaluate(kind: Kind, f: Facts): Verdict {
  const exp = f.expected;
  const expLogin = exp?.login ?? null;
  const active = f.hosts?.active ?? null;
  const base = { active, expected: expLogin, problems: [] as string[], fixes: [] as string[] };

  if ((kind === "status" || kind === "pr") && !active) return { state: "UNAUTH", ...base };
  if (!f.remote || f.remote.host.toLowerCase() !== "github.com") return { state: "UNTRACKED", ...base };

  const problems: string[] = [];
  const fixes: string[] = [];
  const fix = (s: string) => {
    if (!fixes.includes(s)) fixes.push(s);
  };

  if (kind === "pr" || kind === "status") {
    if (expLogin && active && !eq(active, expLogin)) {
      problems.push(`gh account is ${active}, expected ${expLogin}`);
      fix(`gh auth switch --user ${expLogin}`);
    }
  }

  if ((kind === "commit" || kind === "status") && f.email && exp) {
    const emailFix = () =>
      fix(`git config user.email ${exp.emails[0] ?? `<id>+${expLogin}@users.noreply.github.com`}`);
    if (exp.emails.length > 0) {
      if (!exp.emails.some((e) => eq(e, f.email!))) {
        problems.push(`author email ${f.email} is not one of ${exp.emails.join(", ")} (expected ${expLogin ?? "profile"})`);
        emailFix();
      }
    } else if (expLogin) {
      const nl = noreplyLogin(f.email);
      if (nl && !eq(nl, expLogin)) {
        problems.push(`author email ${f.email} belongs to ${nl}, expected ${expLogin}`);
        emailFix();
      }
    }
  }

  if ((kind === "push" || kind === "status") && expLogin && f.push && f.push.via !== "unknown" && f.push.login) {
    if (!eq(f.push.login, expLogin)) {
      if (f.push.via === "ssh") {
        problems.push(`push over ssh uses ${f.push.login}'s key, expected ${expLogin}`);
        const target = `git@<alias>:${f.remote.owner}/${f.remote.repo}.git`;
        fix(
          f.remoteName === ""
            ? `Configure an SSH key for ${expLogin} (e.g. a Host alias in ~/.ssh/config) and push to ${target}`
            : `Configure an SSH key for ${expLogin} (e.g. a Host alias in ~/.ssh/config) and set the remote: git remote set-url ${f.remoteName} ${target}`,
        );
      } else {
        problems.push(`push over gh credentials uses ${f.push.login}, expected ${expLogin}`);
        fix(`gh auth switch --user ${expLogin}`);
      }
    }
  }

  if (problems.length > 0) return { state: "MISMATCH", ...base, problems, fixes };
  if (exp?.ambiguous) return { state: "AMBIGUOUS", ...base };
  if (!expLogin) return { state: "UNKNOWN", ...base };
  return { state: "MATCH", ...base };
}
