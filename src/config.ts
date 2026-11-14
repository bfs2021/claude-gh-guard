import path from "node:path";
import type { Deps } from "./deps.ts";

export interface Profile {
  name: string;
  ghUser: string;
  gitEmails: string[];
  owners: string[];
}

function strings(v: unknown): string[] {
  const arr = typeof v === "string" ? [v] : Array.isArray(v) ? v : [];
  return arr.filter((x): x is string => typeof x === "string");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function loadConfig(d: Deps): { profiles: Profile[]; error: string | null } {
  try {
    const text = d.readFile(path.join(d.home, ".gh-guard.json"));
    if (text === null) return { profiles: [], error: null };
    const json: unknown = JSON.parse(text);
    if (!isObject(json)) return { profiles: [], error: "config must be a JSON object" };
    const raw = json.profiles;
    if (raw === undefined) return { profiles: [], error: null };
    if (!isObject(raw)) return { profiles: [], error: '"profiles" must be an object' };
    const profiles: Profile[] = [];
    for (const [name, v] of Object.entries(raw)) {
      if (!isObject(v) || typeof v.ghUser !== "string" || v.ghUser === "") continue;
      profiles.push({ name, ghUser: v.ghUser, gitEmails: strings(v.gitEmail), owners: strings(v.owners) });
    }
    return { profiles, error: null };
  } catch (e) {
    return { profiles: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export function matchProfile(profiles: Profile[], owner: string, repo: string): Profile | null {
  const full = `${owner}/${repo}`.toLowerCase();
  const o = owner.toLowerCase();
  const has = (p: Profile, key: string) => p.owners.some((x) => x.toLowerCase() === key);
  return profiles.find((p) => has(p, full)) ?? profiles.find((p) => has(p, o)) ?? null;
}
