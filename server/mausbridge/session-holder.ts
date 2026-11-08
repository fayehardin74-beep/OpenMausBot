// Who else is writing a bound session right now, found read-only: the lock files are never opened,
// created or locked here, only listed with lsof, because taking even a probe lock could make the
// desktop app fail to open the session at that moment.
//   - Codex keeps ~/.codex/thread-writer-locks/<thread>.lock while one writer owns a thread
//     (observed with the ChatGPT desktop app's codex 0.167.0-alpha.3.2; the file goes away on release).
//   - DeepSeek Harness 0.2.2-rc.1 holds a flock on <DSH_HOME>/sessions/<workspace>/<session>/session.lock
//     for every session its desktop core has loaded.
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type Holder = "Codex" | "DeepSeek";

export interface HolderProbe {
  /** Pids that have this file open; empty when none (lsof exits 1 then). */
  openers(path: string): Promise<number[]>;
  parentOf(pid: number): Promise<number | undefined>;
}

export const systemProbe: HolderProbe = {
  async openers(path) {
    try {
      const { stdout } = await run("lsof", ["-t", "--", path]);
      return stdout.split(/\s+/).filter(Boolean).map(Number);
    } catch {
      return [];
    }
  },
  async parentOf(pid) {
    try {
      const { stdout } = await run("ps", ["-o", "ppid=", "-p", String(pid)]);
      const ppid = Number(stdout.trim());
      return ppid > 1 ? ppid : undefined;
    } catch {
      return undefined;
    }
  },
};

export function lockFileFor(driverKind: string | undefined, cursor: string, homes: { codex: string; dsh?: string }): string | null {
  if (driverKind === "codex") {
    const lock = join(homes.codex, "thread-writer-locks", `${cursor}.lock`);
    return existsSync(lock) ? lock : null;
  }
  if (driverKind === "deepseekAgent") {
    const root = join(homes.dsh ?? process.env.DSH_HOME ?? join(homedir(), ".dsh"), "sessions");
    let workspaces: string[];
    try {
      workspaces = readdirSync(root);
    } catch {
      return null;
    }
    for (const workspace of workspaces) {
      const lock = join(root, workspace, cursor, "session.lock");
      if (existsSync(lock)) return lock;
    }
  }
  return null;
}

/** A process outside this server's own process tree holds the lock: an engine this server started is not "someone else". */
export async function heldElsewhere(lock: string, probe: HolderProbe = systemProbe, self = process.pid): Promise<boolean> {
  for (const pid of await probe.openers(lock)) {
    let ancestor: number | undefined = pid;
    let ours = false;
    for (let hops = 0; ancestor !== undefined && hops < 32; hops++) {
      if (ancestor === self) {
        ours = true;
        break;
      }
      ancestor = await probe.parentOf(ancestor);
    }
    if (!ours) return true;
  }
  return false;
}

export function holderName(driverKind: string | undefined): Holder | undefined {
  return driverKind === "codex" ? "Codex" : driverKind === "deepseekAgent" ? "DeepSeek" : undefined;
}
