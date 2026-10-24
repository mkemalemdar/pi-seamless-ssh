// The remote's instructions (AGENTS.md / CLAUDE.md by pi's rules), the git branch, and transfer progress.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { branchCommand, contextDirs, contextScript, parseContext } from "../src/core/context.ts";
import { transferBar } from "../src/controller.ts";
import { uploadMany } from "../src/ssh/transfer.ts";
import { Scratch } from "../src/sync/scratch.ts";
import { localRemote } from "./local-remote.ts";

const made: string[] = [];
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), "pss-ctx-"));
	made.push(d);
	return d;
};
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

test("context folders in pi's order: the agent folder, then / down to the project", () => {
	assert.deepEqual(contextDirs("/p/.pi/agent", "/home/me/p"), ["/p/.pi/agent", "/", "/home", "/home/me", "/home/me/p"]);
});

test("context files read by pi's rules: one per folder (override first), any content intact, plus the git branch", async () => {
	const { remote } = await localRemote();
	const root = tmp();
	const agent = join(root, "proj", ".pi", "agent");
	mkdirSync(agent, { recursive: true });
	writeFileSync(join(agent, "AGENTS.md"), "global copy\nPSS_CTX 999 /fake\nwith a fake marker line");
	writeFileSync(join(root, "AGENTS.md"), "parent folder");
	writeFileSync(join(root, "proj", "CLAUDE.md"), "project claude");
	writeFileSync(join(root, "proj", "AGENTS.override.md"), "project override wins");
	const out = await remote.sh(contextScript(contextDirs(agent, join(root, "proj")), join(root, "proj")));
	const { files, branch } = parseContext(out);
	const mine = files.filter((f) => f.path.startsWith(root));
	assert.deepEqual(mine.map((f) => [f.path, f.content]), [
		[join(agent, "AGENTS.md"), "global copy\nPSS_CTX 999 /fake\nwith a fake marker line"],
		[join(root, "AGENTS.md"), "parent folder"],
		[join(root, "proj", "AGENTS.override.md"), "project override wins"],
	]);
	assert.equal(branch, undefined, "not a git repository");
	assert.throws(() => parseContext(Buffer.from("PSS_CTX 5 /x\nab")), /completely/);
});

test("the git branch: before the first commit, after it, with no branch checked out", async () => {
	const { remote } = await localRemote();
	const repo = tmp();
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
	const branch = async () => parseContext(await remote.sh(contextScript([], repo))).branch;
	const direct = async () => (await remote.sh(branchCommand(repo)).catch(() => Buffer.from(""))).toString("utf8").trim();
	git("init", "-q");
	git("checkout", "-q", "-b", "fresh");
	assert.equal(await branch(), "fresh", "a new repository with no commits yet");
	git("commit", "-q", "--allow-empty", "-m", "one");
	assert.equal(await branch(), "fresh");
	git("checkout", "-q", "--detach");
	assert.equal(await branch(), git("rev-parse", "--short", "HEAD"), "detached: the commit");
	assert.equal(await direct(), await branch(), "the same command after a bash call");
});

test("the status line's progress bar", () => {
	assert.equal(transferBar({ direction: "up", done: 6 * 1024 * 1024, total: 10 * 1024 * 1024 }), "↑ ▕██████░░░░▏ 60% 6.0/10.0 MB");
	assert.equal(transferBar({ direction: "down", done: 0, total: 0 }), "↓ ▕░░░░░░░░░░▏ 0% 0.0/0.0 MB");
});

test("transfers report their progress up to the total", async () => {
	const { remote } = await localRemote();
	const dir = tmp();
	const scratch = new Scratch(`p${Date.now()}`, join(dir, "scratch"));
	const seen: number[] = [];
	const data = Buffer.alloc(2 * 1024 * 1024, 7);
	await uploadMany(remote, [{ from: { data }, to: join(dir, "big.bin"), mtime: 1700000000 }], scratch, (done, total) => {
		assert.equal(total, data.length);
		seen.push(done);
	});
	assert.ok(seen.length > 1, "several updates");
	assert.equal(seen.at(-1), data.length, "ends at the total");
	scratch.remove();
});
