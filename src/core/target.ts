// What `/ssh <target>` accepts: what ssh itself accepts as a destination, plus an optional port.
//   vm                   a Host from ~/.ssh/config
//   me@192.168.1.5    user and address
//   me@host:2222      another port
//   [::1]:2222           an IPv6 address with a port

export interface Target {
  /** Handed to ssh as the destination. */
  destination: string;
  port?: number;
  /** As the user typed it; used as the machine's name in menus and settings. */
  label: string;
}

export function parseTarget(raw: string): Target | { error: string } {
  const label = raw.trim();
  if (!label) return { error: "Give a machine, e.g. /ssh me@192.168.1.5 or /ssh vm" };
  if (/\s/.test(label)) return { error: `"${label}" has a space in it` };
  if (label.startsWith("-")) return { error: `"${label}" can't start with "-"` };

  let rest = label;
  let port: number | undefined;
  const at = rest.lastIndexOf("@");
  const user = at >= 0 ? rest.slice(0, at + 1) : "";
  let host = at >= 0 ? rest.slice(at + 1) : rest;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end < 0) return { error: `"${label}": missing "]"` };
    const after = host.slice(end + 1);
    if (after && !/^:\d{1,5}$/.test(after)) return { error: `"${label}": unexpected "${after}"` };
    if (after) port = Number(after.slice(1));
    host = host.slice(1, end);
  } else {
    const parts = host.split(":");
    if (parts.length > 2) return { error: `"${label}": an IPv6 address needs brackets, e.g. [::1]:22` };
    if (parts.length === 2) {
      if (!/^\d{1,5}$/.test(parts[1]!)) return { error: `"${label}": the port must be a number` };
      port = Number(parts[1]);
      host = parts[0]!;
    }
  }
  if (!host) return { error: `"${label}": no machine name` };
  if (port !== undefined && (port < 1 || port > 65535)) return { error: `"${label}": the port must be 1–65535` };
  rest = `${user}${host}`;
  return { destination: rest, ...(port !== undefined ? { port } : {}), label };
}

/** Host names from ~/.ssh/config, for the menu. Patterns (`*`, `?`, `!`) are skipped. */
export function sshConfigHosts(config: string): string[] {
  const hosts: string[] = [];
  for (const line of config.split(/\r?\n/)) {
    const match = /^\s*Host\s+(.+)$/i.exec(line);
    if (!match) continue;
    for (const name of match[1]!.trim().split(/\s+/)) {
      if (!/[*?!]/.test(name) && !hosts.includes(name)) hosts.push(name);
    }
  }
  return hosts;
}
