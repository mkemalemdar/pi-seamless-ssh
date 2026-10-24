// Listing the project's agent folder on the remote.
//
// The remote keeps the previous listing in a state file and sends only what changed since (a removed or added line
// per file; a changed file is both). The first listing, and any listing after a failure, sends everything. A listing
// that didn't finish is refused, so it can never look like "the remote is empty".
//
// File names are one per line, so a name with a control character (a line break, a tab, …) can't be carried safely.
// Such files are left out of the listing, counted, and reported.

import { q } from "./shell.ts";

export interface RemoteFile {
	size: number;
	/** Whole seconds. */
	mtime: number;
}

export type RemoteOs = "linux" | "darwin" | "other";

const DONE = "PSS_LIST_DONE";
const ODD = "PSS_ODD ";
const FULL = "PSS_FULL";

/** One line per file, "size mtime ./path", without names holding control characters. GNU find prints them itself; BSD find hands them to stat. */
function records(os: RemoteOs): string {
	const select = `find . -type f ! -path '*[[:cntrl:]]*'`;
	return os === "darwin" ? `${select} -exec stat -f '%z %m %N' {} +` : `${select} -printf '%s %T@ ./%P\\n'`;
}

/**
 * The listing script. `delta`: send only the lines that changed against the state file (or everything, marked
 * PSS_FULL, when there is no state file). The new listing becomes the state file only after it was printed in full.
 */
export function listScript(dir: string, stateFile: string, os: RemoteOs, delta: boolean): string {
	const S = q(stateFile);
	return [
		`if [ -d ${q(dir)} ]; then (cd ${q(dir)} && ${records(os)}) 2>/dev/null | LC_ALL=C sort > ${S}.new; else : > ${S}.new; fi`,
		`odd=0; [ -d ${q(dir)} ] && odd=$(cd ${q(dir)} && find . -type f -path '*[[:cntrl:]]*' -print0 2>/dev/null | tr -dc '\\000' | wc -c | tr -d ' ')`,
		delta ? `if [ -f ${S} ]; then LC_ALL=C comm -3 ${S} ${S}.new; else echo ${FULL}; cat ${S}.new; fi` : `echo ${FULL}; cat ${S}.new`,
		`echo "${ODD}$odd"`,
		`echo ${DONE}`,
		`mv -f ${S}.new ${S}`,
	].join("\n");
}

const RECORD = /^(\d+) (\d+)(?:\.\d+)? \.\/(.+)$/;

function parseRecord(line: string): [string, RemoteFile] | undefined {
	const m = RECORD.exec(line);
	if (!m || m[3]!.endsWith(".pss-part")) return undefined;
	return [m[3]!, { size: Number(m[1]), mtime: Number(m[2]) }];
}

export interface Listing {
	/** The remote agent folder now. */
	files: Map<string, RemoteFile>;
	/** Files left out because their name holds a control character. */
	odd: number;
}

/**
 * Applies a listing's output to the previous view (or to nothing, for a full listing). Throws when the output didn't
 * finish; the caller then drops its view and asks for a full listing next time.
 */
export function applyListing(stdout: string, previous: ReadonlyMap<string, RemoteFile> | undefined): Listing {
	const lines = stdout.split("\n");
	while (lines.length > 0 && lines.at(-1) === "") lines.pop();
	if (lines.at(-1) !== DONE) throw new Error("the remote listing didn't finish");
	const oddLine = lines.at(-2) ?? "";
	if (!oddLine.startsWith(ODD)) throw new Error("the remote listing is incomplete");
	const body = lines.slice(0, -2);
	const odd = Number(oddLine.slice(ODD.length)) || 0;

	if (body[0] === FULL) {
		const files = new Map<string, RemoteFile>();
		for (const line of body.slice(1)) {
			const r = parseRecord(line);
			if (r) files.set(r[0], r[1]);
		}
		return { files, odd };
	}
	if (!previous) throw new Error("a change list came without a previous listing");
	const files = new Map(previous);
	// comm -3: lines only in the old listing come first in each pair; lines only in the new one start with a tab.
	const removed = body.filter((l) => !l.startsWith("\t"));
	const added = body.filter((l) => l.startsWith("\t")).map((l) => l.slice(1));
	// Removals first: a changed file is an old line removed and a new line added.
	for (const line of removed) {
		const r = parseRecord(line);
		if (r) files.delete(r[0]);
	}
	for (const line of added) {
		const r = parseRecord(line);
		if (r) files.set(r[0], r[1]);
	}
	return { files, odd };
}

/** At most this many folders per tree listing; a bigger tree gets its second level fetched when it's opened. */
export const TREE_LIMIT = 4000;

/**
 * Folders in `dir` and one level below them, in one command: the folder browser shows a folder's subfolders at once
 * when it's opened or expanded. Hidden folders are included (the browser decides what to show); names with control
 * characters are left out.
 */
export function dirsTreeScript(dir: string): string {
	return [
		`cd ${q(dir)} || exit 3`,
		`pwd`,
		`find . -mindepth 1 -maxdepth 2 -type d ! -path '*[[:cntrl:]]*' 2>/dev/null | head -n ${TREE_LIMIT + 1}`,
		`echo ${DONE}`,
	].join("\n");
}

export interface DirsTree {
	/** The folder itself, as the remote resolved it. */
	path: string;
	/** Subfolder names of `path`, and of each subfolder (when the listing wasn't cut off). */
	children: Map<string, string[]>;
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

export function parseDirsTree(stdout: string): DirsTree {
	const lines = stdout.split("\n").filter((l) => l !== "");
	if (lines.at(-1) !== DONE || lines.length < 2) throw new Error("the folder listing didn't finish");
	const path = lines[0]!;
	const rels = lines.slice(1, -1).map((l) => (l.startsWith("./") ? l.slice(2) : l));
	const complete = rels.length <= TREE_LIMIT;
	const join = (a: string, b: string) => (a === "/" ? `/${b}` : `${a}/${b}`);
	const children = new Map<string, string[]>([[path, []]]);
	for (const rel of rels.slice(0, TREE_LIMIT)) {
		const parts = rel.split("/");
		if (parts.length === 1) {
			children.get(path)!.push(parts[0]!);
			if (complete && !children.has(join(path, parts[0]!))) children.set(join(path, parts[0]!), []);
		} else if (complete && parts.length === 2) {
			const parent = join(path, parts[0]!);
			if (!children.has(parent)) children.set(parent, []);
			children.get(parent)!.push(parts[1]!);
		}
	}
	for (const names of children.values()) names.sort(byName);
	return { path, children };
}
