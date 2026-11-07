// mausbridge: pin an OpenMausBot conversation to a provider session that already exists outside it
// (a Codex thread id, an ACP session id). Kept out of upstream files on purpose; index.ts holds two
// one-line hooks (the route module and `pin` before sendTurn). See docs/mausbridge/README.md.
//
// Guarantees for a bound conversation:
//   - every turn resumes the bound session: no sessionReset, no recoveryText, so a provider that
//     can't resume it fails the turn instead of quietly starting a new native session;
//   - a cursor the host clears (external update, rewind) is put back; a cursor the host replaces
//     with another session is recorded as drift and put back too, so the next turn returns home;
//   - a turn on a different engine than the bound one is refused.
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";

export interface Binding {
  botId: string;
  threadId: string;
  instanceId: string;
  cursor: string;
  boundAt: string;
  /** Cursors the host put in place of the bound one; each was reverted. */
  drift: Array<{ seen: string; at: string }>;
}

/** Just the Store surface this module touches, so upstream refactors of Store rarely reach here. */
export interface BindingStore {
  bot(id: string): { id: string; threadId: string; modelSelection: { instanceId: string } } | null | undefined;
  taskByThread(botId: string, threadId: string): { resumeCursors: Record<string, unknown>; lastInstanceId?: string } | null | undefined;
  setResumeCursor(botId: string, instanceId: string, cursor: unknown, threadId?: string): void;
  markTaskDispatched(botId: string, threadId: string, instanceId: string): void;
  onChange(listener: (change: { type: string; botId?: string }) => void): () => void;
}

export interface BindingDeps {
  store: BindingStore;
  dataDir: string;
  /** driverKind of a registered instance, undefined when there is none. */
  driverKind(instanceId: string): string | undefined;
  busy(botId: string, threadId: string): boolean;
  codexHome?: string;
  log?: (line: string) => void;
}

/** Every bound session id in this process, for drivers that must refuse to replace one (acp/core.ts). */
const boundSessions = new Set<string>();
export function isBoundSession(sessionId: string): boolean {
  return boundSessions.has(sessionId);
}

export class BindingError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** The rollout file Codex keeps for a thread, or null; Codex names them `rollout-<time>-<thread id>.jsonl`. */
export function findCodexRollout(codexHome: string, threadId: string): string | null {
  if (!/^[0-9a-f-]{36}$/i.test(threadId)) return null;
  const suffix = `-${threadId.toLowerCase()}.jsonl`;
  const walk = (dir: string, depth: number): string | null => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase().endsWith(suffix)) return path;
      if (entry.isDirectory() && depth < 4) {
        const found = walk(path, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(join(codexHome, "sessions"), 0) ?? walk(join(codexHome, "archived_sessions"), 0);
}

export function createSessionBindings(deps: BindingDeps) {
  const file = join(deps.dataDir, "mausbridge", "bindings.json");
  const log = deps.log ?? ((line: string) => console.log(`mausbridge: ${line}`));
  const codexHome = deps.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  let bindings: Binding[] = load();
  let reconciling = false;
  const indexBound = () => {
    boundSessions.clear();
    for (const binding of bindings) boundSessions.add(binding.cursor);
  };
  indexBound();

  function load(): Binding[] {
    if (!existsSync(file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      return Array.isArray(parsed?.bindings) ? parsed.bindings : [];
    } catch (error) {
      log(`could not read ${file}: ${String(error)}`);
      return [];
    }
  }

  function save() {
    indexBound();
    mkdirSync(dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify({ version: 1, bindings }, null, 2) + "\n");
  }

  const find = (botId: string, threadId: string) => bindings.find((b) => b.botId === botId && b.threadId === threadId);

  function status(binding: Binding) {
    const task = deps.store.taskByThread(binding.botId, binding.threadId);
    const current = task?.resumeCursors[binding.instanceId];
    return {
      ...binding,
      live: task ? current === binding.cursor ? "bound" : current === undefined ? "cleared" : "drifted" : "missing-conversation",
      busy: task ? deps.busy(binding.botId, binding.threadId) : false,
    };
  }

  /** Put the bound cursor back. An external-context marker in lastInstanceId is left alone: it makes
   * the next turn carry the update into the bound session, which `pin` still resumes. */
  function reconcile(binding: Binding) {
    const task = deps.store.taskByThread(binding.botId, binding.threadId);
    if (!task) return;
    const current = task.resumeCursors[binding.instanceId];
    if (current !== binding.cursor) {
      if (current !== undefined) {
        binding.drift.push({ seen: String(current), at: new Date().toISOString() });
        save();
        log(`bot ${binding.botId} thread ${binding.threadId}: host moved the session to ${String(current)}; restoring ${binding.cursor}`);
      }
      deps.store.setResumeCursor(binding.botId, binding.instanceId, binding.cursor, binding.threadId);
    }
    if (task.lastInstanceId === undefined) deps.store.markTaskDispatched(binding.botId, binding.threadId, binding.instanceId);
  }

  function reconcileAll(botId?: string) {
    if (reconciling) return;
    reconciling = true;
    try {
      for (const binding of bindings) if (!botId || binding.botId === botId) reconcile(binding);
    } finally {
      reconciling = false;
    }
  }

  const unsubscribe = deps.store.onChange((change) => {
    if (change.type === "bot" && change.botId && bindings.some((b) => b.botId === change.botId)) reconcileAll(change.botId);
  });
  reconcileAll();

  return {
    list: () => bindings.map(status),

    bind(input: { botId: string; threadId?: string; instanceId?: string; cursor: string }) {
      const bot = deps.store.bot(input.botId);
      if (!bot) throw new BindingError("没有这个 Bot", 404);
      const threadId = input.threadId ?? bot.threadId;
      if (!deps.store.taskByThread(bot.id, threadId)) throw new BindingError("这个 Bot 没有这个对话", 404);
      const instanceId = input.instanceId ?? bot.modelSelection.instanceId;
      const kind = deps.driverKind(instanceId);
      if (!kind) throw new BindingError(`没有名为 ${instanceId} 的引擎`, 404);
      if (deps.busy(bot.id, threadId)) throw new BindingError("这个对话正在运行，等它结束再绑定", 409);
      const cursor = input.cursor.trim();
      if (!cursor) throw new BindingError("缺少要绑定的会话 ID");
      if (kind === "codex" && !findCodexRollout(codexHome, cursor)) {
        throw new BindingError(`在 ${codexHome} 里找不到 Codex 线程 ${cursor}`, 404);
      }
      const taken = bindings.find((b) => b.instanceId === instanceId && b.cursor === cursor && !(b.botId === bot.id && b.threadId === threadId));
      if (taken) throw new BindingError(`这个会话已经绑定给 Bot ${taken.botId}，一个会话只能有一个写入者`, 409);
      bindings = bindings.filter((b) => !(b.botId === bot.id && b.threadId === threadId));
      const binding: Binding = { botId: bot.id, threadId, instanceId, cursor, boundAt: new Date().toISOString(), drift: [] };
      bindings.push(binding);
      save();
      reconcileAll(bot.id);
      log(`bound bot ${bot.id} thread ${threadId} to ${instanceId} session ${cursor}`);
      return status(binding);
    },

    unbind(botId: string, threadId?: string) {
      const before = bindings.length;
      bindings = bindings.filter((b) => !(b.botId === botId && (threadId === undefined || b.threadId === threadId)));
      if (bindings.length === before) return false;
      save();
      return true;
    },

    /** Called on the dispatch context right before sendTurn. Unbound conversations pass through untouched. */
    pin<T extends { resumeCursor?: unknown; sessionReset?: boolean; recoveryText?: string; handoff?: unknown }>(
      botId: string, threadId: string, instanceId: string, context: T,
    ): T {
      const binding = find(botId, threadId);
      if (!binding) return context;
      if (binding.instanceId !== instanceId) {
        throw new BindingError(`这个对话绑定在引擎 ${binding.instanceId} 的已有会话上，不能换到 ${instanceId}；要换请先解除绑定`, 409);
      }
      const handoff = context.handoff && typeof context.handoff === "object"
        ? { ...(context.handoff as Record<string, unknown>), resumeCursor: binding.cursor }
        : context.handoff;
      return { ...context, resumeCursor: binding.cursor, sessionReset: false, recoveryText: undefined, handoff };
    },

    dispose: unsubscribe,
  };
}

export type SessionBindings = ReturnType<typeof createSessionBindings>;
