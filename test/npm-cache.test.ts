// npm's cache: the extension's own copies (and those of what it brought along) are found and deleted, nothing else.
// The same cleaner as pi-harness-whatsapp's.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { cacheKeysFor, cleanNpmCache, installedTree } from "../src/cleanup/npm-cache.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-seamless-ssh-cache-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const pkg = (path: string, name: string, version: string, dependencies: Record<string, string> = {}) => {
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "package.json"), JSON.stringify({ name, version, dependencies }));
};
const KEY = "make-fetch-happen:request-cache:https://registry.npmjs.org";

describe("npm cache", () => {
	it("finds the installed dependency tree the way Node does", () => {
		const root = join(dir, "node_modules");
		pkg(join(root, "pi-seamless-ssh"), "pi-seamless-ssh", "0.1.1", { baileys: "7", franc: "6" });
		pkg(join(root, "baileys"), "baileys", "7.0.0-rc14", { "@hapi/boom": "9" });
		pkg(join(root, "@hapi", "boom"), "@hapi/boom", "9.1.4");
		pkg(join(root, "franc"), "franc", "6.2.0", { "trigram-utils": "2" });
		// A nested copy wins over the hoisted one.
		pkg(join(root, "franc", "node_modules", "trigram-utils"), "trigram-utils", "2.0.1");
		pkg(join(root, "trigram-utils"), "trigram-utils", "1.0.0");
		pkg(join(root, "unrelated"), "unrelated", "1.0.0");
		assert.deepEqual(installedTree(join(root, "pi-seamless-ssh")).map((entry) => `${entry.name}@${entry.version}`), [
			"pi-seamless-ssh@0.1.1",
			"baileys@7.0.0-rc14",
			"@hapi/boom@9.1.4",
			"franc@6.2.0",
			"trigram-utils@2.0.1",
		]);
	});

	it("picks only our packages' entries", () => {
		const keys = [
			`${KEY}/pi-seamless-ssh`,
			`${KEY}/pi-seamless-ssh/-/pi-seamless-ssh-0.1.0.tgz`,
			`${KEY}/baileys`,
			`${KEY}/baileys/-/baileys-7.0.0-rc14.tgz`,
			`${KEY}/baileys/-/baileys-6.7.21.tgz`,
			`${KEY}/@hapi%2fboom`,
			`${KEY}/@hapi/boom/-/boom-9.1.4.tgz`,
			`${KEY}/boom`,
			`${KEY}/not-baileys`,
			"something-else:key",
			"pacote:tarball:file:/home/alex/pi-seamless-ssh",
			"pacote:tarball:file:../pkg/pi-seamless-ssh-0.1.1.tgz",
			"pacote:tarball:file:/home/alex/pi-seamless-ssh-fork/x.tgz",
		];
		const packages = [
			{ name: "pi-seamless-ssh", version: "0.1.1" },
			{ name: "baileys", version: "7.0.0-rc14" },
			{ name: "@hapi/boom", version: "9.1.4" },
		];
		assert.deepEqual(cacheKeysFor(keys, packages), keys.slice(0, 4).concat(keys.slice(5, 7), keys.slice(10, 12)));
	});

	it("deletes our entries, their content and their index files, and keeps what others use", async () => {
		const root = join(dir, "node_modules");
		pkg(join(root, "pi-seamless-ssh"), "pi-seamless-ssh", "0.1.1", { franc: "6" });
		pkg(join(root, "franc"), "franc", "6.2.0");
		const cache = join(dir, "npm-cache", "_cacache");
		const integrity = (text: string) => `sha512-${createHash("sha512").update(text).digest("base64")}`;
		const content = (text: string) => {
			const hex = createHash("sha512").update(text).digest("hex");
			return join(cache, "content-v2", "sha512", hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
		};
		const index = (key: string) => {
			const hash = createHash("sha256").update(key).digest("hex");
			return join(cache, "index-v5", hash.slice(0, 2), hash.slice(2, 4), hash.slice(4));
		};
		const entry = (key: string, text: string | null) => {
			mkdirSync(join(index(key), ".."), { recursive: true });
			writeFileSync(index(key), `\nabc\t${JSON.stringify({ key, integrity: text === null ? null : integrity(text) })}\n`, { flag: "a" });
			if (text !== null) {
				mkdirSync(join(content(text), ".."), { recursive: true });
				writeFileSync(content(text), text);
			}
		};
		entry(`${KEY}/franc`, "franc metadata");
		entry(`${KEY}/franc/-/franc-6.2.0.tgz`, "shared bytes");
		entry("pacote:tarball:file:/home/alex/pi-seamless-ssh-0.1.1.tgz", "local copy");
		entry(`${KEY}/other`, "shared bytes");
		entry(`${KEY}/old`, "old bytes");
		entry(`${KEY}/old`, null);

		assert.equal(await cleanNpmCache(join(root, "pi-seamless-ssh"), async () => ({ code: 0, stdout: "", stderr: "" }), join(dir, "npm-cache")), 3);
		assert.equal(existsSync(index(`${KEY}/franc`)), false);
		assert.equal(existsSync(index(`${KEY}/franc/-/franc-6.2.0.tgz`)), false);
		assert.equal(existsSync(index("pacote:tarball:file:/home/alex/pi-seamless-ssh-0.1.1.tgz")), false);
		assert.equal(existsSync(content("franc metadata")), false);
		assert.equal(existsSync(content("local copy")), false);
		// Still used by another entry.
		assert.equal(existsSync(content("shared bytes")), true);
		assert.equal(existsSync(index(`${KEY}/other`)), true);
		assert.equal(existsSync(index(`${KEY}/old`)), true);
	});
});
