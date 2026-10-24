// The extension's own settings (~/.pi/agent/pi-seamless-ssh/settings.json). Anything invalid is replaced by the
// default, so a hand-edited file can't break the extension.

/** What happens when a chat that was connected is opened again (resumed, forked). */
export type ReopenMode = "reconnect" | "ask" | "home";
export const REOPEN_MODES: ReopenMode[] = ["ask", "reconnect", "home"];
export const REOPEN_TEXT: Record<ReopenMode, string> = {
  ask: "ask me",
  reconnect: "reconnect automatically",
  home: "don't reconnect",
};

/**
 * How a password login is kept for next time: the password saved in this computer's keychain, or key login set up on
 * the machine (no password at all). At most one of the two.
 */
export type Keep = "password" | "key";
export const KEEP_TEXT: Record<Keep | "ask", string> = {
  ask: "ask for the password",
  password: "save the password",
  key: "set up key login",
};

/** A machine saved under a name you chose. */
export interface SavedMachine {
  name: string;
  /** What ssh is given: me@192.168.1.5, me@host:2222, or a name from ~/.ssh/config. */
  address: string;
  /** What to do when it asks for a password: pre-ticked on the password screen. Absent: just ask. */
  keep?: Keep;
}

/** A connection made before: the machine and the project folder, reopened in one step. */
export interface RecentConnection {
  /** The address (or ~/.ssh/config name) that was connected to. */
  address: string;
  project: string;
}

export interface Settings {
  reopen: ReopenMode;
  /** The machine and project in pi's status line while connected. */
  statusLine: boolean;
  /** The model may connect to saved machines and disconnect by itself (tools ssh_machines, ssh_connect, ssh_disconnect). */
  modelTools: boolean;
  /** Ports kept local: a tool on this computer that opens localhost on one of these is never sent to the remote. */
  localPorts: number[];
  /** Keep the sudo password given once until disconnecting (off: every sudo asks, showing the command). */
  sudoRemember: boolean;
  machines: SavedMachine[];
  /** Newest first. */
  recent: RecentConnection[];
  /** Addresses with a password saved in this computer's keychain (so "Remove everything" can find them all). */
  savedPasswords: string[];
}

export const MAX_RECENT = 8;

export const defaultSettings = (): Settings => ({ reopen: "ask", statusLine: true, modelTools: false, localPorts: [], sudoRemember: false, machines: [], recent: [], savedPasswords: [] });

const isPort = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 65535;
const isText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

export function normalizeSettings(raw: unknown): Settings {
  const s = defaultSettings();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return s;
  const r = raw as Record<string, unknown>;
  if (REOPEN_MODES.includes(r.reopen as ReopenMode)) s.reopen = r.reopen as ReopenMode;
  if (typeof r.statusLine === "boolean") s.statusLine = r.statusLine;
  if (typeof r.modelTools === "boolean") s.modelTools = r.modelTools;
  if (typeof r.sudoRemember === "boolean") s.sudoRemember = r.sudoRemember;
  if (Array.isArray(r.localPorts)) s.localPorts = [...new Set(r.localPorts.filter(isPort))].sort((a, b) => a - b);
  if (Array.isArray(r.machines)) {
    for (const m of r.machines as Record<string, unknown>[]) {
      if (m && isText(m.name) && isText(m.address) && !s.machines.some((x) => x.name === m.name)) {
        s.machines.push({ name: m.name.trim(), address: m.address.trim(), ...(m.keep === "password" || m.keep === "key" ? { keep: m.keep } : {}) });
      }
    }
  }
  if (Array.isArray(r.recent)) {
    for (const c of r.recent as Record<string, unknown>[]) {
      if (c && isText(c.address) && typeof c.project === "string" && c.project.startsWith("/") && !s.recent.some((x) => x.address === c.address && x.project === c.project)) {
        s.recent.push({ address: c.address, project: c.project });
      }
    }
    s.recent = s.recent.slice(0, MAX_RECENT);
  }
  if (Array.isArray(r.savedPasswords)) s.savedPasswords = [...new Set(r.savedPasswords.filter(isText))];
  return s;
}

/** "3000, 8080" → [3000, 8080]; an error text for anything else. Empty → []. */
export function parsePorts(text: string): number[] | string {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  const ports = parts.map(Number);
  const bad = parts.filter((_, i) => !isPort(ports[i]));
  if (bad.length) return `not a port: ${bad.join(", ")}`;
  return [...new Set(ports)].sort((a, b) => a - b);
}

/** Puts a connection first in the recent list. */
export function rememberConnection(s: Settings, address: string, project: string): void {
  s.recent = [{ address, project }, ...s.recent.filter((c) => !(c.address === address && c.project === project))].slice(0, MAX_RECENT);
}

/** The address a name typed after /ssh stands for: a saved machine's name, or the text itself. */
export const addressFor = (s: Settings, text: string): string => s.machines.find((m) => m.name === text)?.address ?? text;

/** The saved name of an address, if it has one. */
export const nameFor = (s: Settings, address: string): string | undefined => s.machines.find((m) => m.address === address)?.name;

/** A problem with a saved machine's name, or undefined. Names are what you type after /ssh: one word, unique. */
export function machineNameProblem(s: Settings, name: string, except?: string): string | undefined {
  const n = name.trim();
  if (!n) return "Type a name";
  if (/\s/.test(n)) return "One word, without spaces (it's what you type after /ssh)";
  if (n === "off" || n === "status") return `"${n}" is a /ssh command`;
  if (s.machines.some((m) => m.name === n && m.name !== except)) return `"${n}" is already saved`;
  return undefined;
}
