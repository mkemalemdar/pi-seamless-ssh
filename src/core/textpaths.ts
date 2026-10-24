// Absolute paths in free text (a reply, a WhatsApp message), and swapping known paths for their other names.

const PATH_RE = /(?:^|[\s"'`(<\[=:,])((?:\/|~\/)[^\s"'`<>|]*[^\s"'`<>|.,;:!?)\]])/g;

/** Absolute paths mentioned in `text`, without trailing punctuation, each once. */
export function pathsInText(text: string): string[] {
	const found = new Set<string>();
	for (const m of text.matchAll(PATH_RE)) found.add(m[1]!);
	return [...found];
}

/** Replaces every key of `names` with its value, longest first so a path never matches inside a longer one. */
export function swapNames(text: string, names: ReadonlyMap<string, string>): string {
	if (names.size === 0 || !text) return text;
	let out = text;
	for (const from of [...names.keys()].sort((a, b) => b.length - a.length)) {
		if (out.includes(from)) out = out.split(from).join(names.get(from)!);
	}
	return out;
}
