import path from "node:path";
import type { Deps } from "./deps.ts";
import { ghConfigDir } from "./paths.ts";

export interface GhHosts {
  active: string | null;
  logins: string[];
  hostsFile: string;
}

const indentOf = (l: string) => l.length - l.trimStart().length;
const clean = (v: string) => v.trim().replace(/^["']|["']$/g, "");

// Line parser for the gh hosts.yml subset only: `host:` at top level, children
// (`user:`, `users:`) one level deeper, login keys one level below `users:`.
export function parseHostsYml(text: string, host: string): { active: string | null; logins: string[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "" && !l.trimStart().startsWith("#"));
  let active: string | null = null;
  let users: string[] | null = null;
  let i = lines.findIndex((l) => indentOf(l) === 0 && l.trim() === `${host}:`);
  if (i < 0) return { active: null, logins: [] };
  i++;
  const childIndent = i < lines.length && indentOf(lines[i]!) > 0 ? indentOf(lines[i]!) : -1;
  for (; i < lines.length && indentOf(lines[i]!) > 0; i++) {
    const line = lines[i]!;
    if (indentOf(line) !== childIndent) continue;
    const t = line.trim();
    if (t === "users:") {
      users = [];
      const userIndent = i + 1 < lines.length ? indentOf(lines[i + 1]!) : 0;
      for (let j = i + 1; j < lines.length && indentOf(lines[j]!) > childIndent; j++) {
        if (indentOf(lines[j]!) !== userIndent) continue;
        const m = /^([^:]+):/.exec(lines[j]!.trim());
        if (m) users.push(clean(m[1]!));
      }
    } else if (t.startsWith("user:")) {
      active = clean(t.slice(5)) || null;
    }
  }
  const logins = users ?? (active ? [active] : []);
  return { active, logins };
}

export function readGhHosts(d: Deps, host = "github.com"): GhHosts | null {
  const hostsFile = path.join(ghConfigDir(d), "hosts.yml");
  const text = d.readFile(hostsFile);
  if (text === null) return null;
  return { ...parseHostsYml(text, host), hostsFile };
}
