// Where things live while connected.
//   home agent folder     ~/.pi/agent                  (pi's own folder on the machine you type on)
//   remote project        /home/me/project          (the folder picked on the remote)
//   remote agent folder   /home/me/project/.pi/agent   (the project's own copy of pi's file folders)
// A file's place in the remote agent folder is its place under the home agent folder.

import { posix } from "node:path";

export interface Workspace {
	homeAgent: string;
	homeHome: string;
	remoteProject: string;
	remoteHome: string;
}

export const remoteAgent = (ws: Workspace): string => posix.join(ws.remoteProject, ".pi", "agent");

/** Where files from outside pi's folders go on the remote (a browser screenshot in /tmp, etc.). */
export const FROM_HOME = "from-home";

/**
 * pi's own folders and this extension's: never placeholders, never set aside. These are pi's documented layout
 * (sessions, packages, resources), not any extension's.
 */
const PI_OWN = new Set(["sessions", "npm", "install", "bin", "git", "extensions", "skills", "prompts", "themes", "pi-seamless-ssh"]);

/**
 * A path under the agent folder that may hold a placeholder: inside a folder (single files at the top are pi's
 * settings, logins and instructions) and not in one of pi's own folders.
 */
export function isSharedRel(rel: string): boolean {
	const parts = rel.split("/");
	return parts.length >= 2 && !parts.includes("..") && !parts.includes("") && !PI_OWN.has(parts[0]!);
}

/** A remote path as the model gives it: `~` is the remote home, relative paths start in the project. */
export function resolveRemote(path: string, ws: Workspace): string {
	if (path === "~") return ws.remoteHome;
	if (path.startsWith("~/")) return posix.join(ws.remoteHome, path.slice(2));
	return posix.resolve(ws.remoteProject, path);
}

/** `child` relative to `parent` when it is inside it, else undefined. */
export function relInside(parent: string, child: string): string | undefined {
	const base = parent.endsWith("/") ? parent : `${parent}/`;
	return child.startsWith(base) ? child.slice(base.length) : undefined;
}

/** The remote name of a home file in the agent folder. */
export function homeToRemote(homePath: string, ws: Workspace): string | undefined {
	const rel = relInside(ws.homeAgent, homePath);
	return rel === undefined ? undefined : posix.join(remoteAgent(ws), rel);
}

/** The home name of a remote file in the project's agent folder. */
export function remoteToHome(remotePath: string, ws: Workspace): string | undefined {
	const rel = relInside(remoteAgent(ws), remotePath);
	return rel === undefined ? undefined : `${ws.homeAgent}/${rel}`;
}
