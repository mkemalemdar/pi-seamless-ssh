// Finding the values in a home tool's input that may be file paths, and the localhost addresses.
// A value found here is only a candidate: it is treated as a path only if a real file or folder on the remote backs
// it (checked over SSH), so plain text is never changed.

export type Slot = (string | number)[];

export interface Candidate {
  slot: Slot;
  value: string;
}

const MAX_DEPTH = 6;
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Could this string be a path? Starts like one, or is a single word with a "/" or a file extension. */
export function looksLikePath(value: string): boolean {
  if (!value || value.length > 4096 || value.includes("\n") || value.includes("\0")) return false;
  if (URL_RE.test(value) || value.startsWith("-")) return false;
  if (value === "~" || value.startsWith("/") || value.startsWith("~/") || value.startsWith("./") || value.startsWith("../")) return true;
  if (/\s/.test(value)) return false;
  return value.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(value);
}

/** Every string in the input (in objects and lists), with where it sits. */
export function strings(input: unknown, slot: Slot = [], depth = 0, out: Candidate[] = []): Candidate[] {
  if (depth > MAX_DEPTH) return out;
  if (typeof input === "string") out.push({ slot, value: input });
  else if (Array.isArray(input)) input.forEach((item, i) => strings(item, [...slot, i], depth + 1, out));
  else if (input && typeof input === "object") {
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) strings(value, [...slot, key], depth + 1, out);
  }
  return out;
}

export const pathCandidates = (input: unknown): Candidate[] => strings(input).filter((c) => looksLikePath(c.value));

/** Replaces the value at `slot` (the input object is changed in place, as pi's tool_call hook expects). */
export function setAt(input: unknown, slot: Slot, value: string): void {
  if (slot.length === 0) return;
  let node = input as Record<string | number, unknown>;
  for (const key of slot.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  node[slot.at(-1)!] = value;
}

// ------------------------------------------------------------------ localhost

export interface LocalAddress {
  /** The whole match, e.g. "http://localhost:3000". */
  text: string;
  host: string;
  port: number;
}

const LOCAL_RE = /\b((?:https?|wss?):\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::(\d{1,5}))?(?=[/?#\s"'`)\]]|$)/gi;

/** localhost addresses in a string. A URL without a port gets its scheme's default (80/443). */
export function localAddresses(value: string): LocalAddress[] {
  const found: LocalAddress[] = [];
  for (const m of value.matchAll(LOCAL_RE)) {
    const scheme = m[1]?.toLowerCase();
    const port = m[3] ? Number(m[3]) : scheme ? (scheme.startsWith("https") || scheme.startsWith("wss") ? 443 : 80) : undefined;
    // A bare "localhost" with no scheme and no port says nothing about a port.
    if (port === undefined || port < 1 || port > 65535) continue;
    found.push({ text: m[0], host: m[2]!, port });
  }
  return found;
}

/** The string with one localhost address pointed at another port. */
export function withPort(value: string, address: LocalAddress, port: number): string {
  const scheme = /^[a-z]+:\/\//i.exec(address.text)?.[0] ?? "";
  return value.split(address.text).join(`${scheme}${address.host}:${port}`);
}
