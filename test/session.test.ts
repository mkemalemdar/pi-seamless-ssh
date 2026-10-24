// The session end to end, with this machine standing in for both sides: "home" and "remote" are two temp folders.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workspace } from "../src/core/paths.ts";
import type { Connection } from "../src/ssh/connection.ts";
import { detectNameRules, realName } from "../src/sync/home.ts";
import { undoHomeChanges } from "../src/sync/session.ts";
import { makeSession, removeTestSessions } from "./session-kit.ts";
import { localRemote } from "./local-remote.ts";

const made: string[] = [];
after(() => {
	removeTestSessions();
	made.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function setup() {
	const root = mkdtempSync(join(tmpdir(), "pss-session-"));
	made.push(root);
	const homeAgent = join(root, "home", ".pi", "agent");
	const project = join(root, "remote", "project");
	mkdirSync(homeAgent, { recursive: true });
	mkdirSync(join(project, ".pi", "agent"), { recursive: true });
	const ws: Workspace = { homeAgent, homeHome: join(root, "home"), remoteProject: project, remoteHome: join(root, "remote") };
	const { conn, remote } = await localRemote();
	const { session, store, notes } = makeSession(conn as unknown as Connection, remote, ws);
	const remoteAgent = join(project, ".pi", "agent");
	return { root, ws, homeAgent, project, remoteAgent, session, store, notes, conn };
}

const write = (path: string, data: string, mtime?: number) => {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, data);
	if (mtime) utimesSync(path, mtime, mtime);
};

test("remote files show up on home as empty placeholders with their size and date, next to home's own files", async () => {
	const t = await setup();
	write(join(t.remoteAgent, "pi-harness-whatsapp", "inbox", "old.jpg"), "remote-photo", 1700000000);
	write(join(t.homeAgent, "pi-harness-whatsapp", "inbox", "mine.jpg"), "home-photo");
	write(join(t.homeAgent, "pi-harness-whatsapp", "auth", "creds.json"), "secret");
	await t.session.sweep();
	const ph = join(t.homeAgent, "pi-harness-whatsapp", "inbox", "old.jpg");
	const st = statSync(ph);
	assert.equal(st.size, 12);
	assert.equal(Math.floor(st.mtimeMs / 1000), 1700000000);
	assert.ok(readFileSync(ph).every((b) => b === 0), "empty: no remote data on home");
	assert.equal(readFileSync(join(t.homeAgent, "pi-harness-whatsapp", "inbox", "mine.jpg"), "utf8"), "home-photo", "home's own files untouched");
	assert.equal(readFileSync(join(t.homeAgent, "pi-harness-whatsapp", "auth", "creds.json"), "utf8"), "secret");
});

test("an extension deleting a placeholder (WhatsApp's 7-day cleanup) deletes the remote file", async () => {
	const t = await setup();
	write(join(t.remoteAgent, "x", "old.jpg"), "data", 1700000000);
	await t.session.sweep();
	unlinkSync(join(t.homeAgent, "x", "old.jpg"));
	await t.session.sweep();
	assert.ok(!existsSync(join(t.remoteAgent, "x", "old.jpg")));
});

test("a file an extension saved and mentioned (a WhatsApp photo) moves to the remote; a placeholder stays; the model sees the remote name", async () => {
	const t = await setup();
	const photo = join(t.homeAgent, "pi-harness-whatsapp", "inbox", "new.jpg");
	write(photo, "fresh-photo");
	await t.session.moveMentioned(`[WhatsApp from Ali] [sent a file: new.jpg (image/jpeg, 1 KB), saved at ${photo}]`);
	const onRemote = join(t.remoteAgent, "pi-harness-whatsapp", "inbox", "new.jpg");
	assert.equal(readFileSync(onRemote, "utf8"), "fresh-photo");
	assert.equal(statSync(photo).size, 11);
	assert.ok(readFileSync(photo).every((b) => b === 0), "the home copy is a placeholder now");
	assert.equal(t.session.names().get(photo), onRemote);
});

test("pi's own files are never moved, even when mentioned", async () => {
	const t = await setup();
	write(join(t.homeAgent, "auth.json"), "{}");
	write(join(t.homeAgent, "sessions", "a", "s.jsonl"), "chat");
	await t.session.moveMentioned(`${join(t.homeAgent, "auth.json")} ${join(t.homeAgent, "sessions", "a", "s.jsonl")}`);
	assert.equal(readFileSync(join(t.homeAgent, "auth.json"), "utf8"), "{}");
	assert.ok(!existsSync(join(t.remoteAgent, "auth.json")));
});

test("sending a remote file with a home tool: fetched for the call, gone afterwards; a placeholder is filled then emptied", async () => {
	const t = await setup();
	write(join(t.project, "shot.png"), "png-bytes");
	write(join(t.remoteAgent, "shots", "s.png"), "agent-png", 1700000000);
	await t.session.sweep();
	const input: Record<string, unknown> = { path: "shot.png", to: "15550001234" };
	assert.equal(await t.session.prepareCall("c1", input), undefined);
	const local = input.path as string;
	assert.notEqual(local, "shot.png");
	assert.equal(readFileSync(local, "utf8"), "png-bytes", "the tool reads the real file on home");
	await t.session.finishCall("c1", "sent");
	assert.ok(!existsSync(local), "the copy is gone");

	const input2: Record<string, unknown> = { path: ".pi/agent/shots/s.png" };
	await t.session.prepareCall("c2", input2);
	const ph = join(t.homeAgent, "shots", "s.png");
	assert.equal(input2.path, ph);
	assert.equal(readFileSync(ph, "utf8"), "agent-png", "filled for the call");
	await t.session.finishCall("c2", "sent");
	assert.ok(readFileSync(ph).every((b) => b === 0), "empty again");
});

test("a home tool told to save at a remote path saves on home, and the file lands at that remote path", async () => {
	const t = await setup();
	const input = { args: ["screenshot", join(t.project, "out", "page.png")] };
	mkdirSync(join(t.project, "out"));
	await t.session.prepareCall("c3", input);
	const local = input.args[1]!;
	assert.ok(!local.startsWith(t.project));
	writeFileSync(local, "screenshot-bytes");
	await t.session.finishCall("c3", `saved ${local}`);
	assert.equal(readFileSync(join(t.project, "out", "page.png"), "utf8"), "screenshot-bytes");
	assert.equal(t.session.names().get(local), join(t.project, "out", "page.png"), "the model sees the remote path in the reply");
});

test("a file a home tool made elsewhere and reported goes to the project's .pi/agent/from-home", async () => {
	const t = await setup();
	const elsewhere = join(t.root, "home", "tmp-shot.png");
	write(elsewhere, "browser-shot");
	await t.session.finishCall("c4", `Screenshot saved to ${elsewhere}`);
	assert.ok(!existsSync(elsewhere));
	const remote = t.session.names().get(elsewhere)!;
	assert.match(remote, /\.pi\/agent\/from-home\/.+-tmp-shot\.png$/);
	assert.equal(readFileSync(remote, "utf8"), "browser-shot");
});

test("a placeholder an extension wrote into goes back to the remote", async () => {
	const t = await setup();
	write(join(t.remoteAgent, "notes", "n.txt"), "old", 1700000000);
	await t.session.sweep();
	write(join(t.homeAgent, "notes", "n.txt"), "new content", 1700000500);
	await t.session.sweep();
	assert.equal(readFileSync(join(t.remoteAgent, "notes", "n.txt"), "utf8"), "new content");
});

test("a home file with a remote file's name is set aside while connected and comes back on disconnect", async () => {
	const t = await setup();
	write(join(t.remoteAgent, "x", "same.txt"), "remote");
	write(join(t.homeAgent, "x", "same.txt"), "home");
	await t.session.sweep();
	assert.ok(readFileSync(join(t.homeAgent, "x", "same.txt")).every((b) => b === 0), "the remote's (placeholder) is shown");
	await t.session.close();
	assert.equal(readFileSync(join(t.homeAgent, "x", "same.txt"), "utf8"), "home");
});

test("disconnect: placeholders and the folders made for them are removed; home is as before; the remote keeps its files", async () => {
	const t = await setup();
	write(join(t.remoteAgent, "a", "b", "c.txt"), "keep");
	await t.session.sweep();
	assert.ok(existsSync(join(t.homeAgent, "a", "b", "c.txt")));
	await t.session.close();
	assert.ok(!existsSync(join(t.homeAgent, "a")));
	assert.equal(readFileSync(join(t.remoteAgent, "a", "b", "c.txt"), "utf8"), "keep");
	assert.ok(!existsSync(t.store.path), "the session record is gone");
});

test("a failed remote listing deletes nothing", async () => {
	const t = await setup();
	write(join(t.remoteAgent, "x", "f.txt"), "data");
	await t.session.sweep();
	t.conn.alive = false;
	await t.session.sweep();
	assert.ok(existsSync(join(t.homeAgent, "x", "f.txt")));
	t.conn.alive = true;
	await t.session.sweep();
	assert.ok(existsSync(join(t.remoteAgent, "x", "f.txt")));
});

test("after a crash: untouched placeholders go, a written one is kept, set-aside files come back", async () => {
	const t = await setup();
	write(join(t.remoteAgent, "x", "a.txt"), "1", 1700000000);
	write(join(t.remoteAgent, "x", "b.txt"), "2", 1700000000);
	write(join(t.remoteAgent, "y", "c.txt"), "3");
	write(join(t.homeAgent, "y", "c.txt"), "home-c");
	await t.session.sweep();
	write(join(t.homeAgent, "x", "b.txt"), "written-after", 1700000999);
	const kept: string[] = [];
	const left = undoHomeChanges(t.store.record!, t.homeAgent, (rel) => kept.push(rel));
	assert.deepEqual(left, []);
	assert.deepEqual(kept, ["x/b.txt"]);
	assert.ok(!existsSync(join(t.homeAgent, "x", "a.txt")));
	assert.equal(readFileSync(join(t.homeAgent, "x", "b.txt"), "utf8"), "written-after");
	assert.equal(readFileSync(join(t.homeAgent, "y", "c.txt"), "utf8"), "home-c");
});

test("a disk that folds names: of two remote files differing only in case, one placeholder is made and the clash is reported", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pss-session-"));
	made.push(root);
	// The stand-in "remote" lives on this machine's disk: it can only hold both names if this disk tells them apart.
	if (detectNameRules(root).foldCase) return t.skip("this disk ignores case, so it can't play a remote holding Photo.png and photo.png");
	const homeAgent = join(root, "home", ".pi", "agent");
	const project = join(root, "remote", "project");
	mkdirSync(homeAgent, { recursive: true });
	mkdirSync(join(project, ".pi", "agent", "x"), { recursive: true });
	writeFileSync(join(project, ".pi", "agent", "x", "Photo.png"), "A");
	writeFileSync(join(project, ".pi", "agent", "x", "photo.png"), "B");
	const ws: Workspace = { homeAgent, homeHome: join(root, "home"), remoteProject: project, remoteHome: join(root, "remote") };
	const { conn, remote } = await localRemote();
	const { session, notes } = makeSession(conn as unknown as Connection, remote, ws, { names: { foldCase: true, foldForm: true } });
	await session.sweep();
	// The folder's real entries (existsSync would itself fold names on a folding disk).
	assert.deepEqual(readdirSync(join(homeAgent, "x")), ["Photo.png"], "only one of the two");
	assert.ok(notes.some((n) => n.includes("doesn't tell apart") && n.includes("photo.png")), notes.join(" | "));
});

test("realName finds a file's own spelling on a disk that folds names", () => {
	const dir = mkdtempSync(join(tmpdir(), "pss-session-"));
	made.push(dir);
	writeFileSync(join(dir, "Photo.PNG"), "x");
	assert.equal(realName(join(dir, "photo.png"), { foldCase: true, foldForm: true }), join(dir, "Photo.PNG"));
	assert.equal(realName(join(dir, "photo.png"), { foldCase: false, foldForm: false }), join(dir, "photo.png"));
});

test("the home disk's name rules are measured: a probe file found under another spelling means the disk folds names", () => {
	const dir = mkdtempSync(join(tmpdir(), "pss-session-"));
	made.push(dir);
	const rules = detectNameRules(dir);
	writeFileSync(join(dir, "CaseProbe"), "");
	assert.equal(rules.foldCase, existsSync(join(dir, "caseprobe")));
	assert.deepEqual(readdirSync(dir), ["CaseProbe"], "the probe files are gone");
});
