// Quoting for the remote POSIX shell. Every remote command is built from these, never by pasting raw text.

/** One shell word, safe for any content: 'it'\''s' style. */
export function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Several shell words. */
export function qs(values: readonly string[]): string {
  return values.map(q).join(" ");
}

/** A UTC timestamp for `TZ=UTC touch -t`, which GNU and BSD touch both read: YYYYMMDDhhmm.SS. */
export function touchStamp(epochSeconds: number): string {
  const d = new Date(Math.floor(epochSeconds) * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}.${p(d.getUTCSeconds())}`;
}
