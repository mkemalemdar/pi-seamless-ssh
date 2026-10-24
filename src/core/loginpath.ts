// The remote's PATH as your login gives it. Commands over SSH skip the login setup (~/.profile, ~/.bashrc,
// ~/.zprofile…), so programs installed into your own folders (~/.local/bin, nvm, cargo, brew…) aren't found. Once per
// connection your login shell is started the way a terminal starts it, and its PATH is kept; every script the
// extension runs there (the model's commands included) then starts with it. The command text is never changed.

import { q } from "./shell.ts";

const START = "PSS_PATH_START";
const END = "PSS_PATH_END";
const NO_SHELL = "PSS_NO_SHELL";
const TIMEOUT = "PSS_TIMEOUT";
const PLAIN = "PSS_PLAIN=";

/** Runs the login shell (interactive too: Ubuntu's ~/.bashrc stops early otherwise), at most `seconds`. */
export function loginPathScript(seconds = 10): string {
	// printenv, not $PATH in the shell's own syntax: it prints the exported, colon-separated PATH in any shell (fish too).
	const inner = `echo; echo ${START}; printenv PATH; echo ${END}`;
	return [
		`printf '${PLAIN}%s\\n' "$PATH"`,
		`s=\${SHELL:-}`,
		`[ -n "$s" ] && [ -x "$s" ] || { echo ${NO_SHELL}; exit 0; }`,
		`o=$(mktemp "\${TMPDIR:-/tmp}/pss-path.XXXXXX") || exit 1`,
		`"$s" -l -i -c ${q(inner)} < /dev/null > "$o" 2> /dev/null &`,
		`p=$!; i=0`,
		`while kill -0 "$p" 2>/dev/null; do`,
		`  if [ "$i" -ge ${seconds * 10} ]; then kill "$p" 2>/dev/null; echo ${TIMEOUT}; break; fi`,
		`  sleep 0.1; i=$((i + 1))`,
		`done`,
		`wait "$p" 2>/dev/null`,
		`cat "$o"; rm -f "$o"`,
	].join("\n");
}

/**
 * The PATH: your login's, then any folder of the plain one it lacks (so the basic tools are always found), each folder
 * once. Or why there is none. Whatever the startup files print around it is ignored.
 */
export function parseLoginPath(out: string, seconds = 10): { path: string } | { problem: string } {
	const lines = out.split("\n");
	if (lines.includes(NO_SHELL)) return { problem: "your login shell ($SHELL) isn't set or isn't there" };
	if (lines.includes(TIMEOUT)) return { problem: `your shell's startup didn't finish within ${seconds} s` };
	const at = lines.indexOf(START);
	const path = at >= 0 && lines[at + 2] === END ? lines[at + 1]!.trim() : "";
	if (!path) return { problem: "your shell's startup didn't give a PATH" };
	const plain = lines.find((l) => l.startsWith(PLAIN))?.slice(PLAIN.length) ?? "";
	return { path: [...new Set([...path.split(":"), ...plain.split(":")].filter(Boolean))].join(":") };
}

/** A script that starts with the login PATH. */
export const withLoginPath = (script: string, path: string | undefined): string => (path ? `PATH=${q(path)}; export PATH\n${script}` : script);
