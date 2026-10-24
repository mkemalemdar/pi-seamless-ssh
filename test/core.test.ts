// The pure logic in src/core: targets, quoting, paths, path candidates, localhost, listings, name rules, compression,
// sweep plans, ssh problems, settings, globs and the folder browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRows, folderNameProblem, parentOf, shortPath } from "../src/core/browser.ts";
import { localAddresses, looksLikePath, pathCandidates, setAt, withPort } from "../src/core/candidates.ts";
import { classifySsh, RECONNECT_DELAYS } from "../src/core/errors.ts";
import { basenameEre, globToRegExp } from "../src/core/glob.ts";
import { applyListing, parseDirsTree, TREE_LIMIT } from "../src/core/listing.ts";
import { EXACT_NAMES, nameKey, resolveClashes } from "../src/core/names.ts";
import { COMPRESS_MIN_BYTES, worthCompressing } from "../src/core/compress.ts";
import { homeToRemote, isSharedRel, remoteToHome, resolveRemote, type Workspace } from "../src/core/paths.ts";
import { planSweep, type HomeState } from "../src/core/plan.ts";
import { addressFor, machineNameProblem, MAX_RECENT, nameFor, normalizeSettings, parsePorts, rememberConnection } from "../src/core/settings.ts";
import { q, touchStamp } from "../src/core/shell.ts";
import { parseTarget, sshConfigHosts } from "../src/core/target.ts";
import { pathsInText, swapNames } from "../src/core/textpaths.ts";

const ws: Workspace = { homeAgent: "/Users/me/.pi/agent", homeHome: "/Users/me", remoteProject: "/home/me/project", remoteHome: "/home/me" };

test("targets: what ssh accepts, a port, and nothing that could be read as an option", () => {
	assert.deepEqual(parseTarget("vm"), { destination: "vm", label: "vm" });
	assert.deepEqual(parseTarget("me@192.168.1.5"), { destination: "me@192.168.1.5", label: "me@192.168.1.5" });
	assert.deepEqual(parseTarget("me@host:2222"), { destination: "me@host", port: 2222, label: "me@host:2222" });
	assert.deepEqual(parseTarget("root@[::1]:22"), { destination: "root@::1", port: 22, label: "root@[::1]:22" });
	for (const bad of ["", "  ", "-oProxyCommand=x", "a b", "host:99999", "host:x", "fe80::1"]) assert.ok("error" in parseTarget(bad), bad);
	assert.deepEqual(sshConfigHosts("Host vm mac\n  HostName 1.2.3.4\nHost *.lan\nhost box\n"), ["vm", "mac", "box"]);
});

test("shell quoting survives quotes; touch stamps are UTC", () => {
	assert.equal(q("it's"), `'it'\\''s'`);
	assert.equal(touchStamp(0), "197001010000.00");
	assert.equal(touchStamp(1761300000.9), "202510241000.00");
});

test("paths: ~ and relative paths are the remote's; agent-folder names map both ways", () => {
	assert.equal(resolveRemote("~", ws), "/home/me");
	assert.equal(resolveRemote("~/x.png", ws), "/home/me/x.png");
	assert.equal(resolveRemote("shots/s.png", ws), "/home/me/project/shots/s.png");
	assert.equal(resolveRemote("/tmp/a", ws), "/tmp/a");
	assert.equal(homeToRemote("/Users/me/.pi/agent/pi-harness-whatsapp/inbox/x.jpg", ws), "/home/me/project/.pi/agent/pi-harness-whatsapp/inbox/x.jpg");
	assert.equal(remoteToHome("/home/me/project/.pi/agent/shots/s.png", ws), "/Users/me/.pi/agent/shots/s.png");
	assert.equal(homeToRemote("/Users/me/other", ws), undefined);
});

test("shared places: extension folders yes; pi's own files and folders never", () => {
	assert.ok(isSharedRel("pi-harness-whatsapp/inbox/x.jpg"));
	assert.ok(isSharedRel("shots/s.png"));
	for (const no of ["settings.json", "auth.json", "AGENTS.md", "sessions/a/b.jsonl", "npm/x/y", "extensions/foo.ts", "pi-seamless-ssh/x/y", "a/../b"]) assert.ok(!isSharedRel(no), no);
});

test("path candidates: things that look like paths, in objects and lists; URLs and flags are not", () => {
	for (const yes of ["/tmp/a.png", "~/x", "./a", "../b", "shot.png", "dir/file", "/path with space/x.png"]) assert.ok(looksLikePath(yes), yes);
	for (const no of ["hello world", "screenshot", "https://x.com/a.png", "--headed", "a\nb", ""]) assert.ok(!looksLikePath(no), no);
	const input = { path: "img.png", to: "15550001234", args: ["screenshot", "/home/me/project/shot.png"], caption: "look at this" };
	const found = pathCandidates(input);
	assert.deepEqual(found.map((c) => c.value), ["img.png", "/home/me/project/shot.png"]);
	setAt(input, found[1]!.slot, "/tmp/out/shot.png");
	assert.equal(input.args[1], "/tmp/out/shot.png");
});

test("localhost addresses: with or without a scheme, and the port swapped", () => {
	const found = localAddresses("open http://localhost:3000/app and ws://127.0.0.1:9229 and localhost:8080 not localhost");
	assert.deepEqual(found.map((a) => a.port), [3000, 9229, 8080]);
	assert.equal(withPort("open http://localhost:3000/app", found[0]!, 53412), "open http://localhost:53412/app");
	assert.deepEqual(localAddresses("http://localhost/x").map((a) => a.port), [80]);
});

test("paths in text: WhatsApp's 'saved at …]' and trailing punctuation; names swapped longest first", () => {
	const text = "[WhatsApp from Ali] [sent a file: a.pdf (application/pdf, 12 KB), saved at /Users/me/.pi/agent/pi-harness-whatsapp/inbox/a.pdf] see /tmp/x.png.";
	assert.deepEqual(pathsInText(text), ["/Users/me/.pi/agent/pi-harness-whatsapp/inbox/a.pdf", "/tmp/x.png"]);
	const names = new Map([["/tmp/x", "/r/x"], ["/tmp/x.png", "/r/y.png"]]);
	assert.equal(swapNames("a /tmp/x.png b /tmp/x", names), "a /r/y.png b /r/x");
});

test("listings: full, then only changes; an unfinished one is refused (never read as empty)", () => {
	const full = applyListing("PSS_FULL\n12 1700000000.52 ./pi-harness-whatsapp/inbox/a b.jpg\n7 1700000001 ./shots/s.png\n3 1 ./x.pss-part\nPSS_ODD 0\nPSS_LIST_DONE\n", undefined);
	assert.deepEqual(Object.fromEntries(full.files), { "pi-harness-whatsapp/inbox/a b.jpg": { size: 12, mtime: 1700000000 }, "shots/s.png": { size: 7, mtime: 1700000001 } });
	// comm -3: removed lines plain, added lines after a tab; a changed file is both.
	const delta = applyListing("7 1700000001 ./shots/s.png\n\t9 1700000050 ./shots/s.png\n\t1 5 ./new/n.txt\n12 1700000000.52 ./pi-harness-whatsapp/inbox/a b.jpg\nPSS_ODD 2\nPSS_LIST_DONE\n", full.files);
	assert.deepEqual(Object.fromEntries(delta.files), { "shots/s.png": { size: 9, mtime: 1700000050 }, "new/n.txt": { size: 1, mtime: 5 } });
	assert.equal(delta.odd, 2);
	assert.throws(() => applyListing("PSS_FULL\n12 1 ./a/b\n", undefined), /didn't finish/);
	assert.throws(() => applyListing("\t1 1 ./a/b\nPSS_ODD 0\nPSS_LIST_DONE\n", undefined), /without a previous listing/);
	assert.equal(applyListing("PSS_FULL\nPSS_ODD 0\nPSS_LIST_DONE\n", undefined).files.size, 0);
	const tree = parseDirsTree("/home/me\n./b\n./A\n./A/x\n./.cache\n./b/y\n./b/X\nPSS_LIST_DONE\n");
	assert.equal(tree.path, "/home/me");
	assert.deepEqual(tree.children.get("/home/me"), [".cache", "A", "b"]);
	assert.deepEqual(tree.children.get("/home/me/b"), ["X", "y"]);
	assert.deepEqual(tree.children.get("/home/me/.cache"), [], "a subfolder listed with nothing below is known to be empty");
	const big = parseDirsTree(`/r\n${Array.from({ length: TREE_LIMIT + 1 }, (_, i) => `./d${i}`).join("\n")}\nPSS_LIST_DONE\n`);
	assert.equal(big.children.size, 1, "a cut-off listing claims nothing about the level below");
});

test("names on a disk that folds case and composition: one is shown, the others reported", () => {
	const folding = { foldCase: true, foldForm: true };
	assert.equal(nameKey("Photo.PNG", folding), "photo.png");
	assert.equal(nameKey("caf\u0065\u0301.txt", folding), nameKey("caf\u00e9.txt", folding));
	const { shown, hidden } = resolveClashes(["x/Photo.png", "x/photo.png", "x/other.png", "x/caf\u00e9", "x/cafe\u0301"], folding);
	// The first of each group in sorted order is shown: "Photo" before "photo", "e + accent" before "é".
	assert.deepEqual([...shown].sort(), ["x/Photo.png", "x/cafe\u0301", "x/other.png"].sort());
	assert.deepEqual(hidden.get("x/Photo.png"), ["x/photo.png"]);
	assert.deepEqual(hidden.get("x/cafe\u0301"), ["x/caf\u00e9"]);
	assert.equal(resolveClashes(["x/A", "x/a"], EXACT_NAMES).shown.size, 2, "an exact disk shows both");
});

test("compression: only big transfers of data that compresses", () => {
	assert.equal(worthCompressing([{ name: "log.txt", size: COMPRESS_MIN_BYTES - 1 }]), false);
	assert.equal(worthCompressing([{ name: "log.txt", size: COMPRESS_MIN_BYTES * 3 }]), true);
	assert.equal(worthCompressing([{ name: "clip.mp4", size: COMPRESS_MIN_BYTES * 50 }, { name: "a.txt", size: COMPRESS_MIN_BYTES }]), false);
});

test("sweep plan: every case", () => {
	const f = (size: number, mtime: number) => ({ size, mtime });
	const remote = new Map([
		["new/a", f(1, 1)],
		["clash/b", f(2, 2)],
		["kept/c", f(3, 3)],
		["changed/d", f(4, 40)],
		["deleted-home/e", f(5, 5)],
		["written/f", f(6, 6)],
	]);
	const made = new Map([
		["kept/c", f(3, 3)],
		["changed/d", f(4, 4)],
		["deleted-home/e", f(5, 5)],
		["written/f", f(6, 6)],
		["gone-remote/g", f(7, 7)],
		["gone-both/h", f(8, 8)],
		["gone-remote-written/i", f(9, 9)],
	]);
	const home: Record<string, HomeState> = {
		"new/a": { kind: "missing" },
		"clash/b": { kind: "file", size: 99, mtime: 99 },
		"kept/c": { kind: "file", size: 3, mtime: 3 },
		"changed/d": { kind: "file", size: 4, mtime: 4 },
		"deleted-home/e": { kind: "missing" },
		"written/f": { kind: "file", size: 60, mtime: 61 },
		"gone-remote/g": { kind: "file", size: 7, mtime: 7 },
		"gone-both/h": { kind: "missing" },
		"gone-remote-written/i": { kind: "file", size: 90, mtime: 91 },
	};
	const actions = planSweep(remote, made, (rel) => home[rel]!);
	assert.deepEqual(
		actions.map((a) => `${a.do} ${a.rel}`).sort(),
		["create new/a", "delete-remote deleted-home/e", "forget gone-both/h", "refresh changed/d", "remove gone-remote/g", "set-aside clash/b", "upload gone-remote-written/i", "upload written/f"].sort(),
	);
});

test("ssh problems in plain words; a changed host key is never something to retry", () => {
	assert.equal(classifySsh("@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@", "vm").retry, false);
	assert.match(classifySsh("me@vm: Permission denied (publickey,password).", "vm").message, /refused the login/);
	assert.match(classifySsh("ssh: connect to host 10.0.0.9 port 22: Connection refused", "vm").message, /nothing accepts SSH/);
	assert.match(classifySsh("ssh: Could not resolve hostname nope: Name or service not known", "nope").message, /isn't a known machine/);
	assert.equal(classifySsh("ssh: connect to host x port 22: Operation timed out", "x").retry, true);
	assert.ok(RECONNECT_DELAYS.reduce((a, b) => a + b, 0) >= 100);
});

test("settings: junk becomes defaults; ports parse; saved machines and recent connections", () => {
	assert.deepEqual(normalizeSettings({ reopen: "loud", statusLine: "yes", sudoRemember: "yes", localPorts: [3000, 3000, 0, "x"], machines: [{ name: "vm", address: "me@1.2.3.4" }, { name: "vm", address: "x" }, { name: "" }], recent: [{ address: "vm", project: "/p" }, { address: "vm", project: "rel" }] }), {
		reopen: "ask",
		statusLine: true,
		modelTools: false,
		localPorts: [3000],
		sudoRemember: false,
		machines: [{ name: "vm", address: "me@1.2.3.4" }],
		recent: [{ address: "vm", project: "/p" }],
		savedPasswords: [],
	});
	assert.equal(normalizeSettings({ sudoRemember: true }).sudoRemember, true);
	assert.deepEqual(parsePorts("8080, 3000 3000"), [3000, 8080]);
	assert.equal(parsePorts("3000, abc"), "not a port: abc");
	const s = normalizeSettings({ machines: [{ name: "vm", address: "me@192.168.1.20" }] });
	assert.equal(addressFor(s, "vm"), "me@192.168.1.20");
	assert.equal(addressFor(s, "root@x"), "root@x");
	assert.equal(nameFor(s, "me@192.168.1.20"), "vm");
	assert.equal(machineNameProblem(s, "vm"), '"vm" is already saved');
	assert.equal(machineNameProblem(s, "vm", "vm"), undefined, "renaming to its own name is fine");
	assert.match(machineNameProblem(s, "my vm")!, /One word/);
	assert.match(machineNameProblem(s, "off")!, /command/);
	for (let i = 0; i < MAX_RECENT + 2; i++) rememberConnection(s, "vm", `/p${i}`);
	rememberConnection(s, "vm", "/p3");
	assert.equal(s.recent.length, MAX_RECENT);
	assert.deepEqual(s.recent[0], { address: "vm", project: "/p3" }, "reconnecting moves it to the top, once");
});

test("find's remote narrowing: a name filter that never drops a real match", () => {
	const ere = (g: string) => new RegExp(basenameEre(g)!);
	assert.ok(ere("**/*.spec.ts").test("src/x/a.spec.ts"));
	assert.ok(!ere("**/*.spec.ts").test("src/x/a.ts"));
	assert.ok(ere("src/{a,b}.md").test("src/b.md"));
	assert.ok(ere("*.ts").test("deep/er/x.ts"), "a pattern without / matches names at any depth");
	assert.equal(basenameEre("src/**"), undefined, "** at the end narrows nothing");
});

test("globs as pi's find takes them", () => {
	assert.ok(globToRegExp("*.ts").test("a.ts"));
	assert.ok(!globToRegExp("*.ts").test("src/a.ts"));
	assert.ok(globToRegExp("**/*.spec.ts").test("a.spec.ts"));
	assert.ok(globToRegExp("**/*.spec.ts").test("src/x/a.spec.ts"));
	assert.ok(globToRegExp("src/{a,b}/*.md").test("src/b/x.md"));
	assert.ok(!globToRegExp("a?.txt").test("a/b.txt"));
});

test("folder browser rows: expanded folders show their subfolders indented", () => {
	const children = new Map<string, string[] | "loading">([
		["/home/me", ["a", "b"]],
		["/home/me/a", ["x"]],
		["/home/me/b", "loading"],
	]);
	const rows = buildRows("/home/me", new Set(["/home/me/a", "/home/me/b"]), children);
	assert.deepEqual(rows.map((r) => `${"  ".repeat(r.depth)}${r.name}${r.note ? ` (${r.note})` : ""}`), ["a", "  x", "b (loading…)"]);
	const withDots = new Map([["/h", [".cache", "Desktop", ".npm", "proj"]]]);
	assert.deepEqual(buildRows("/h", new Set(), withDots, false).map((r) => r.name), ["Desktop", "proj"], "hidden folders left out");
	assert.deepEqual(buildRows("/h", new Set(), withDots, true).map((r) => r.name), [".cache", "Desktop", ".npm", "proj"]);
	assert.equal(parentOf("/"), "/");
	assert.equal(parentOf("/home/me"), "/home");
	assert.equal(shortPath("/home/me/p", "/home/me"), "~/p");
	assert.equal(folderNameProblem("a/b"), "One folder name, without /");
	assert.equal(folderNameProblem("new"), undefined);
});
