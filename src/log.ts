// The debug log, for finding out what went wrong: off unless PI_SEAMLESS_SSH_DEBUG=1, then ~/.pi/agent/pi-seamless-ssh/debug.log
// (always in the extension's own folder, so "Remove everything" deletes it). It records what the extension does
// (connections, remote commands by their first line, transfers, sweeps, problems), never passwords or file contents.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isRemoved } from "./removed.ts";

let target: string | null | undefined;

function file(): string | null {
	if (target !== undefined) return target;
	const v = process.env.PI_SEAMLESS_SSH_DEBUG;
	target = v === "1" ? join(getAgentDir(), "pi-seamless-ssh", "debug.log") : null;
	if (target) {
		try {
			mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
		} catch {
			target = null;
		}
	}
	return target;
}

/** One line in the debug log (when it's on). */
export function log(area: string, message: string): void {
	if (isRemoved()) return;
	const path = file();
	if (!path) return;
	try {
		appendFileSync(path, `${new Date().toISOString()} [${area}] ${message.replace(/\s*\n\s*/g, " ⏎ ")}\n`, { mode: 0o600 });
	} catch {
		// A log that can't be written must never break anything.
	}
}

/** A script's first line, shortened: enough to recognize it, never the data sent with it. */
export const firstLine = (script: string): string => {
	const line = script.split("\n").find((l) => l.trim()) ?? "";
	return line.length > 160 ? `${line.slice(0, 160)}…` : line;
};
