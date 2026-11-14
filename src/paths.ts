import path from "node:path";
import type { Deps } from "./deps.ts";

export function ghConfigDir(d: Deps): string {
  if (d.env.GH_CONFIG_DIR) return d.env.GH_CONFIG_DIR;
  if (d.platform === "win32" && d.env.APPDATA) return path.join(d.env.APPDATA, "GitHub CLI");
  if (d.env.XDG_CONFIG_HOME) return path.join(d.env.XDG_CONFIG_HOME, "gh");
  return path.join(d.home, ".config", "gh");
}

export function stateDir(d: Deps): string {
  return path.join(d.home, ".claude-gh-guard");
}

export function cacheDir(d: Deps): string {
  return path.join(d.tmpdir, "claude-gh-guard");
}
