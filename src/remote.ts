export interface Remote {
  protocol: "ssh" | "https";
  host: string;
  sshAlias: string | null;
  owner: string;
  repo: string;
}

function globToRegExp(pattern: string): RegExp {
  const src = pattern
    .replace(/[\\^$.+(){}|[\]]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${src}$`, "i");
}

/** HostName of the first matching Host block (exact names and * / ? globs), else the alias. */
export function resolveSshHost(alias: string, sshConfigText: string | null): string {
  if (!sshConfigText) return alias;
  let matching = false;
  for (const raw of sshConfigText.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    const m = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "host") {
      const patterns = value.split(/\s+/).filter(Boolean);
      const negated = patterns.some((p) => p.startsWith("!") && globToRegExp(p.slice(1)).test(alias));
      matching = !negated && patterns.some((p) => !p.startsWith("!") && globToRegExp(p).test(alias));
    } else if (key === "hostname" && matching && value) {
      return value;
    }
  }
  return alias;
}

function ownerRepo(path: string): { owner: string; repo: string } | null {
  const segs = path.split("/").filter(Boolean);
  if (segs.length < 2) return null;
  const repo = segs[1].replace(/\.git$/, "");
  if (!segs[0] || !repo) return null;
  return { owner: segs[0], repo };
}

export function parseRemoteUrl(url: string, sshConfigText: string | null): Remote | null {
  const s = url.trim();
  let protocol: "ssh" | "https";
  let host: string;
  let path: string;

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  if (scheme) {
    const proto = scheme[1].toLowerCase();
    if (proto !== "ssh" && proto !== "https" && proto !== "http") return null;
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return null;
    }
    protocol = proto === "ssh" ? "ssh" : "https";
    host = u.hostname;
    path = u.pathname;
  } else {
    // scp-style: [user@]host:path (host of 2+ chars so "C:/dir" is not a host)
    const m = /^(?:[^@/\s]+@)?([^:/\s]{2,}):(.+)$/.exec(s);
    if (!m) return null;
    protocol = "ssh";
    host = m[1];
    path = m[2];
  }
  if (!host) return null;
  const or = ownerRepo(path);
  if (!or) return null;

  if (protocol === "ssh") {
    const real = resolveSshHost(host, sshConfigText);
    return { protocol, host: real, sshAlias: real.toLowerCase() !== host.toLowerCase() ? host : null, ...or };
  }
  return { protocol, host, sshAlias: null, ...or };
}
