// Saved passwords, in this computer's own keychain:
//   macOS   the Keychain (`security`)
//   Linux   the desktop keyring (Secret Service, `secret-tool`), when one is running
//   else    a file only you can read (~/.pi/agent/pi-seamless-ssh/passwords.json, mode 600), and the menu says so
// A password is handed to these tools on their input, never as an argument, so it can't be seen in the process list.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { saveJson } from "../store.ts";

const SERVICE = "pi-seamless-ssh";

export interface PasswordStore {
  /** Where saved passwords go, for the screen: "the macOS Keychain", … */
  where: string;
  get(account: string): Promise<string | undefined>;
  set(account: string, password: string): Promise<void>;
  remove(account: string): Promise<void>;
}

function run(cmd: string, args: string[], input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.once("error", () => resolve({ code: null, stdout, stderr }));
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

const onPath = (tool: string) => (process.env.PATH ?? "").split(":").some((dir) => existsSync(join(dir, tool)));

/** The macOS Keychain. `security -i` reads its command from input; the password goes as hex, so nothing needs quoting. */
const keychain: PasswordStore = {
  where: "the macOS Keychain",
  async get(account) {
    const r = await run("security", ["find-generic-password", "-a", account, "-s", SERVICE, "-w"]);
    return r.code === 0 ? r.stdout.replace(/\n$/, "") : undefined;
  },
  async set(account, password) {
    const hex = Buffer.from(password, "utf8").toString("hex");
    const r = await run("security", ["-i"], `add-generic-password -U -a ${account} -s ${SERVICE} -X ${hex}\n`);
    // A locked Keychain (pi running over SSH on the Mac, not in its desktop session) refuses without asking.
    if (/User interaction is not allowed/i.test(r.stderr)) throw new Error("the macOS Keychain is locked (pi isn't running in your Mac's desktop session), so the password wasn't saved");
    if (r.code !== 0 || /returned -\d+|error/i.test(r.stderr)) throw new Error(r.stderr.trim() || "the Keychain refused it");
  },
  async remove(account) {
    await run("security", ["delete-generic-password", "-a", account, "-s", SERVICE]);
  },
};

/** The Linux desktop keyring through `secret-tool` (libsecret); the password goes on its input. */
const secretService: PasswordStore = {
  where: "this computer's keyring",
  async get(account) {
    const r = await run("secret-tool", ["lookup", "service", SERVICE, "account", account]);
    return r.code === 0 && r.stdout ? r.stdout.replace(/\n$/, "") : undefined;
  },
  async set(account, password) {
    const r = await run("secret-tool", ["store", `--label=${SERVICE} ${account}`, "service", SERVICE, "account", account], password);
    if (r.code !== 0) throw new Error(r.stderr.trim() || "the keyring refused it");
  },
  async remove(account) {
    await run("secret-tool", ["clear", "service", SERVICE, "account", account]);
  },
};

/** No keychain: a file only this user can read. */
export function fileStore(dir: string): PasswordStore {
  const path = join(dir, "passwords.json");
  const read = (): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  };
  return {
    where: "a private file (no keychain here)",
    get: async (account) => read()[account],
    set: async (account, password) => saveJson(path, { ...read(), [account]: password }),
    remove: async (account) => {
      const all = read();
      delete all[account];
      saveJson(path, all);
    },
  };
}

/** The best place this computer has, checked by asking it: a keyring that answers, or the file. */
export async function passwordStore(dir: string): Promise<PasswordStore> {
  if (process.platform === "darwin" && onPath("security")) return keychain;
  if (process.platform === "linux" && onPath("secret-tool")) {
    // Exit 0 (found) or 1 (nothing found) means a keyring answered; anything else (no D-Bus, no keyring) doesn't.
    const r = await run("secret-tool", ["lookup", "service", SERVICE, "account", "pi-seamless-ssh-probe"]);
    if (r.code === 0 || (r.code === 1 && !r.stderr.trim())) return secretService;
  }
  return fileStore(dir);
}

/** Whether the macOS Keychain can be used right now (it's locked outside the desktop session, e.g. over SSH). */
export async function keychainUnlocked(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  return (await run("security", ["show-keychain-info"])).code === 0;
}
