// Placeholders on home: plain files with the remote file's name, size and date, but empty. They take no disk space
// (the size is set without writing data), so a remote project with many files costs nothing on home.

import { closeSync, existsSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { RemoteFile } from "../core/listing.ts";
import { nameKey, type NameRules } from "../core/names.ts";
import type { HomeState } from "../core/plan.ts";

export function homeState(path: string): HomeState {
	try {
		const st = lstatSync(path);
		if (!st.isFile()) return { kind: "other" };
		return { kind: "file", size: st.size, mtime: Math.floor(st.mtimeMs / 1000) };
	} catch {
		return { kind: "missing" };
	}
}

/** Makes the folders up to `path`, and reports each one it made (so they can be removed again). */
export function makeParents(path: string, made: (dir: string) => void): void {
	const missing: string[] = [];
	for (let dir = dirname(path); ; dir = dirname(dir)) {
		try {
			lstatSync(dir);
			break;
		} catch {
			missing.push(dir);
			if (dirname(dir) === dir) break;
		}
	}
	for (const dir of missing.reverse()) {
		mkdirSync(dir);
		made(dir);
	}
}

/** Writes (or rewrites) an empty placeholder of the remote file's size and date. */
export function writePlaceholder(path: string, file: RemoteFile): void {
	const fd = openSync(path, "w", 0o600);
	try {
		ftruncateSync(fd, file.size);
	} finally {
		closeSync(fd);
	}
	utimesSync(path, file.mtime, file.mtime);
}

/** Puts the real content in a placeholder for a tool call, keeping its date so it still reads as untouched. */
export function fillPlaceholder(path: string, data: Buffer, mtime: number): void {
	writeFileSync(path, data);
	utimesSync(path, mtime, mtime);
}

export function moveAside(from: string, to: string): void {
	mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
	renameSync(from, to);
}

/** Removes folders this session made, deepest first, as long as they're empty. */
export function removeEmptyDirs(dirs: readonly string[]): void {
	for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
		try {
			rmdirSync(dir);
		} catch {
			// Not empty (something else put a file there) or already gone: leave it.
		}
	}
}

/**
 * How home's disk compares names, measured in `dir` with two probe files: does `aB` find `Ab`, does `é` (one
 * character) find `é` (e + accent)? macOS usually folds both, Linux neither; a USB disk or a case-sensitive APFS volume
 * may differ, so the disk is asked, not the OS.
 */
export function detectNameRules(dir: string): NameRules {
	const probe = (written: string, asked: string): boolean => {
		const a = join(dir, written);
		try {
			writeFileSync(a, "");
			return existsSync(join(dir, asked));
		} catch {
			return false;
		} finally {
			rmSync(a, { force: true });
		}
	};
	const tag = `.pss-probe-${process.pid}-${Date.now()}`;
	return {
		foldCase: probe(`${tag}-aB`, `${tag}-Ab`),
		foldForm: probe(`${tag}-é`, `${tag}-é`),
	};
}

/** The name the file at `path` really has on disk (it may differ in case or composition when the disk folds names). */
export function realName(path: string, rules: NameRules): string {
	if (!rules.foldCase && !rules.foldForm) return path;
	const dir = dirname(path);
	const want = nameKey(basename(path), rules);
	try {
		const found = readdirSync(dir).find((entry) => nameKey(entry, rules) === want);
		return found ? join(dir, found) : path;
	} catch {
		return path;
	}
}
