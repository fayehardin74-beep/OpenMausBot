import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { GrokAgentDriver } from "../drivers/acp/grok.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { createSessionBindings, type BindingStore } from "./session-bindings.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-acp-cli.ts");
const BOUND = "bound-acp-session";

describe("mausbridge ACP guard (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let dispose: () => void;

  beforeEach(async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const task = { resumeCursors: {} as Record<string, unknown> };
    const store: BindingStore = {
      bot: (id) => id === "b1" ? { id: "b1", threadId: "t1", modelSelection: { instanceId: "acp-test" } } : null,
      taskByThread: (botId, threadId) => botId === "b1" && threadId === "t1" ? task : null,
      setResumeCursor: (_b, instanceId, cursor) => { task.resumeCursors[instanceId] = cursor; },
      markTaskDispatched: () => {},
      onChange: () => () => {},
      appendMessage: () => {},
    };
    const bindings = createSessionBindings({ store, dataDir: mkdtempSync(join(tmpdir(), "mausbridge-acp-")), driverKind: () => "grokAgent", busy: () => false, log: () => {} });
    bindings.bind({ botId: "b1", cursor: BOUND });
    dispose = () => { bindings.unbind("b1"); bindings.dispose(); };
    instance = await GrokAgentDriver.create({ instanceId: "acp-test", displayName: "ACP Test", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
  });

  afterEach(async () => {
    delete process.env.FAKE_ACP_LOAD_NULL;
    dispose();
    recorder.stop();
    await instance.dispose();
  });

  it("resumes the bound session", async () => {
    await instance.adapter.sendTurn({ threadId: "t1", text: "go", resumeCursor: BOUND });
    expect(await recorder.until((e) => e.type === "session.started")).toMatchObject({ sessionId: BOUND });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
  });

  it("fails the turn instead of opening a new session when the bound one will not resume", async () => {
    process.env.FAKE_ACP_LOAD_NULL = "1";
    await instance.adapter.sendTurn({ threadId: "t1", text: "go", resumeCursor: BOUND }).catch(() => {});
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: false });
    expect(recorder.events.some((e) => e.type === "session.started")).toBe(false);
  });
});
