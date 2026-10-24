// pi's grep tool on the remote. pi's own grep runs ripgrep on home, so the search itself is done here: the remote's
// ripgrep when it has one, its grep otherwise. The output looks like pi's: "path:line: text", one match per line.

import { q } from "../core/shell.ts";
import type { Remote } from "../ssh/remote.ts";

export interface GrepParams {
	pattern: string;
	path?: string;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
	context?: number;
	limit?: number;
}

const MAX_LINE = 500;
const MAX_BYTES = 50 * 1024;

export function grepScript(p: GrepParams, searchPath: string, hasRg: boolean): string {
	const limit = Math.max(1, Math.min(p.limit ?? 100, 10_000));
	const context = Math.max(0, Math.min(p.context ?? 0, 50));
	if (hasRg) {
		const flags = ["--line-number", "--no-heading", "--color=never", "--hidden", "--glob", "!.git"];
		if (p.ignoreCase) flags.push("--ignore-case");
		if (p.literal) flags.push("--fixed-strings");
		if (context) flags.push("--context", String(context));
		if (p.glob) flags.push("--glob", p.glob);
		return `rg ${flags.map(q).join(" ")} -e ${q(p.pattern)} -- ${q(searchPath)} 2>&1 | head -n ${limit * (1 + 2 * context) + limit}`;
	}
	const flags = ["-rnI", p.literal ? "-F" : "-E"];
	if (p.ignoreCase) flags.push("-i");
	if (context) flags.push(`-C${context}`);
	if (p.glob) flags.push(`--include=${p.glob}`);
	return `grep ${flags.map(q).join(" ")} --exclude-dir=.git -e ${q(p.pattern)} -- ${q(searchPath)} 2>&1 | head -n ${limit * (1 + 2 * context) + limit}`;
}

export async function remoteGrep(remote: Remote, p: GrepParams, searchPath: string): Promise<string> {
	const r = await remote.conn.run(grepScript(p, searchPath, remote.info.hasRg));
	let out = r.stdout.toString("utf8");
	if (!out.trim()) return "No matches found";
	const lines = out.split("\n").map((l) => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}… [line truncated]` : l));
	out = lines.join("\n").trimEnd();
	if (out.length > MAX_BYTES) out = `${out.slice(0, MAX_BYTES)}\n\n[Output truncated at ${MAX_BYTES / 1024}KB]`;
	return out;
}
