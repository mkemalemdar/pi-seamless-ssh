// The folders a connection uses outside pi's agent folder: its sockets in /tmp (short paths: a socket path is limited to
// about 100 characters) and short-lived copies in RAM (/dev/shm on Linux). Their name holds the user and a short hash
// of this pi's agent folder, so two pi setups on one computer (or the tests) never share them, and "Remove
// everything" deletes only this setup's.

import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Linux's tmpfs: memory-backed, gone at reboot. */
const TMPFS_MAGIC = 0x01021994;

/** The RAM folder to use, measured: Linux, /dev/shm is tmpfs, and writable. */
export function ramBase(): string | undefined {
	if (process.platform !== "linux") return undefined;
	try {
		if (statfsSync("/dev/shm").type !== TMPFS_MAGIC) return undefined;
		accessSync("/dev/shm", constants.W_OK);
		return "/dev/shm";
	} catch {
		return undefined;
	}
}

export function runtimeName(): string {
	return `pss-${process.getuid?.() ?? "u"}-${createHash("sha256").update(getAgentDir()).digest("hex").slice(0, 8)}`;
}

/** Where the connection's sockets go. */
export const socketBase = (): string => join(existsSync("/tmp") ? "/tmp" : tmpdir(), runtimeName());

/** Where short-lived copies go in RAM, when this computer has a RAM file system. */
export function ramFolder(): string | undefined {
	const base = ramBase();
	return base ? join(base, runtimeName()) : undefined;
}

/** Every such folder of this setup, for "Remove everything". */
export const runtimeFolders = (): string[] => [socketBase(), ...(ramFolder() ? [ramFolder()!] : [])];
