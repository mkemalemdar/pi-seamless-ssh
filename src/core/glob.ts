// Glob patterns (as pi's find tool takes them: `*.ts`, `**/*.spec.ts`, `src/{a,b}/*`) as regular expressions.

export function globToRegExp(glob: string): RegExp {
	let re = "";
	let braces = 0;
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i]!;
		if (c === "*") {
			if (glob[i + 1] === "*") {
				// "**/" matches any number of folders, including none; "**" at the end matches everything.
				if (glob[i + 2] === "/") {
					re += "(?:.*/)?";
					i += 2;
				} else {
					re += ".*";
					i += 1;
				}
			} else re += "[^/]*";
		} else if (c === "?") re += "[^/]";
		else if (c === "{") {
			braces++;
			re += "(?:";
		} else if (c === "}" && braces > 0) {
			braces--;
			re += ")";
		} else if (c === "," && braces > 0) re += "|";
		else if ("\\^$.|+()[]".includes(c)) re += `\\${c}`;
		else re += c;
	}
	return new RegExp(`^${re}$`);
}

/**
 * A POSIX extended regex for the pattern's last part, matched against file paths on the remote (`grep -E`), so the
 * remote sends back only files whose name can match instead of every file. It only narrows: the exact match is still
 * done with {@link globToRegExp}. Undefined when the last part has `**` (any depth), where names don't narrow anything.
 */
export function basenameEre(glob: string): string | undefined {
	const last = glob.split("/").at(-1) ?? "";
	if (!last || last.includes("**")) return undefined;
	let re = "";
	let braces = 0;
	for (const c of last) {
		if (c === "*") re += "[^/]*";
		else if (c === "?") re += "[^/]";
		else if (c === "{") {
			braces++;
			re += "(";
		} else if (c === "}" && braces > 0) {
			braces--;
			re += ")";
		} else if (c === "," && braces > 0) re += "|";
		else if ("\\^$.|+()[]{}?*".includes(c)) re += `\\${c}`;
		else re += c;
	}
	return `(^|/)${re}$`;
}
