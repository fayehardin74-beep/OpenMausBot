import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { createSessionBindings, isBoundSession, type BindingStore } from "./session-bindings.ts";
import type { HolderProbe } from "./session-holder.ts";

const THREAD = "019a0000-0000-7000-8000-000000000001";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mausbridge-"));
  const codexHome = join(root, "codex");
  mkdirSync(join(codexHome, "sessions", "2026", "11", "07"), { recursive: true });
  writeFileSync(join(codexHome, "sessions", "2026", "11", "07", `rollout-2026-11-07T00-00-00-${THREAD}.jsonl`), "{}\n");
  const task: { resumeCursors: Record<string, unknown>; lastInstanceId?: string } = { resumeCursors: {} };
  const listeners = new Set<(change: { type: string; botId?: string }) => void>();
  const emit = () => listeners.forEach((l) => l({ type: "bot", botId: "b1" }));
  const store: BindingStore = {
    bot: (id) => id === "b1" ? { id: "b1", threadId: "t1", modelSelection: { instanceId: "codex" } } : null,
    taskByThread: (botId, threadId) => botId === "b1" && threadId === "t1" ? task : null,
    setResumeCursor: (_b, instanceId, cursor) => { task.resumeCursors[instanceId] = cursor; emit(); },
    markTaskDispatched: (_b, _t, instanceId) => { task.lastInstanceId = instanceId; },
    onChange: (l) => { listeners.add(l); return () => listeners.delete(l); },
    appendMessage: (_t, message) => { notices.push(message.tool.name); },
  };
  const notices: string[] = [];
  const holders = { pids: [] as number[] };
  const probe: HolderProbe = { openers: async () => holders.pids, parentOf: async () => undefined };
  const make = () => createSessionBindings({ store, dataDir: join(root, "data"), codexHome, driverKind: (id) => id === "codex" ? "codex" : undefined, busy: () => false, log: () => {},
    probe, waitStepMs: 5, maxWaitMs: 200 });
  const lock = join(codexHome, "thread-writer-locks", `${THREAD}.lock`);
  return { task, emit, make, notices, holders, lock };
}

describe("mausbridge session bindings", () => {
  it("binds an existing Codex thread and pins every turn to it", async () => {
    const { task, make } = fixture();
    const b = make();
    expect(b.bind({ botId: "b1", cursor: THREAD }).live).toBe("bound");
    expect(task.resumeCursors.codex).toBe(THREAD);
    expect(task.lastInstanceId).toBe("codex");
    const pinned = await b.pin("b1", "t1", "codex", { resumeCursor: undefined, sessionReset: true, recoveryText: "replay", handoff: { resumeCursor: undefined } });
    expect(pinned).toMatchObject({ resumeCursor: THREAD, sessionReset: false, recoveryText: undefined, handoff: { resumeCursor: THREAD } });
    await expect(b.pin("b1", "t1", "chatgpt", {})).rejects.toThrow(/不能换到/);
    expect(await b.pin("b1", "other", "codex", { sessionReset: true })).toEqual({ sessionReset: true });
    expect(isBoundSession(THREAD)).toBe(true);
    expect(b.boundThread("b1")).toBe("t1");
    expect(b.boundThread("other")).toBeUndefined();
    b.unbind("b1");
    expect(b.boundThread("b1")).toBeUndefined();
    expect(isBoundSession(THREAD)).toBe(false);
  });

  it("refuses a thread Codex does not have", () => {
    const { make } = fixture();
    expect(() => make().bind({ botId: "b1", cursor: "019a0000-0000-7000-8000-00000000ffff" })).toThrow(/找不到/);
  });

  it("restores a cleared cursor and records a replaced one, across restarts", () => {
    const { task, emit, make } = fixture();
    make().bind({ botId: "b1", cursor: THREAD });
    task.resumeCursors = {};
    emit();
    expect(task.resumeCursors.codex).toBe(THREAD);
    task.resumeCursors.codex = "019a0000-0000-7000-8000-0000000000aa";
    emit();
    expect(task.resumeCursors.codex).toBe(THREAD);
    const reloaded = make();
    expect(reloaded.list()[0]).toMatchObject({ live: "bound", drift: [{ seen: "019a0000-0000-7000-8000-0000000000aa" }] });
  });

  it("waits while another app holds the bound thread, then sends", async () => {
    const { make, notices, holders, lock } = fixture();
    const b = make();
    b.bind({ botId: "b1", cursor: THREAD });
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, "");
    holders.pids = [4242];
    setTimeout(() => { holders.pids = []; }, 30);
    expect(await b.pin("b1", "t1", "codex", {})).toMatchObject({ resumeCursor: THREAD });
    expect(notices).toEqual([expect.stringMatching(/Codex 客户端正占用/), expect.stringMatching(/已释放/)]);
  });

  it("stops waiting when the turn is stopped or the wait runs out", async () => {
    const { make, holders, lock } = fixture();
    const b = make();
    b.bind({ botId: "b1", cursor: THREAD });
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, "");
    holders.pids = [4242];
    await expect(b.pin("b1", "t1", "codex", {}, () => new Error("stopped"))).rejects.toThrow("stopped");
    await expect(b.pin("b1", "t1", "codex", {})).rejects.toThrow(/等待超时/);
  });

  it("does not wait on a lock only this server's own engine holds", async () => {
    const { make, notices, lock } = fixture();
    const b = make();
    b.bind({ botId: "b1", cursor: THREAD });
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, "");
    expect(await b.pin("b1", "t1", "codex", {})).toMatchObject({ resumeCursor: THREAD });
    expect(notices).toEqual([]);
  });
});
