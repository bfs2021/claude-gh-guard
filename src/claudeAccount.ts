import path from "node:path";
import type { Deps } from "./deps.ts";

/** The Claude account Claude Code is logged in with. Display only: never judged, never blocks. */
export interface ClaudeAccount {
  /** Organization name, or the email domain for a personal plan's default organization. */
  label: string;
  /** Plan from organizationType ("claude_max" → "max"), when known. */
  plan: string | null;
  email: string | null;
  org: string | null;
}

/** Claude Code's state file: $CLAUDE_CONFIG_DIR/.claude.json when set, else ~/.claude.json. */
export function claudeStatePath(d: Deps): string {
  if (d.env.CLAUDE_CONFIG_DIR) return path.join(d.env.CLAUDE_CONFIG_DIR, ".claude.json");
  return path.join(d.home, ".claude.json");
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function readClaudeAccount(d: Deps): ClaudeAccount | null {
  let o: Record<string, unknown>;
  try {
    const a = JSON.parse(d.readFile(claudeStatePath(d)) ?? "null")?.oauthAccount;
    if (!a || typeof a !== "object") return null;
    o = a;
  } catch {
    return null;
  }
  const email = str(o.emailAddress);
  const org = str(o.organizationName);
  const plan = str(o.organizationType)?.replace(/^claude_/, "") || null;
  // Personal plans get a default organization named "<email>'s Organization": show the email domain instead.
  const realOrg = org && !/'s Organization$/.test(org) ? org : null;
  const domain = email?.includes("@") ? email.slice(email.lastIndexOf("@") + 1) : null;
  const label = realOrg ?? domain;
  return label ? { label, plan, email, org } : null;
}

export function formatClaudeAccount(a: ClaudeAccount): string {
  return `claude:${a.label}${a.plan ? ` (${a.plan})` : ""}`;
}
