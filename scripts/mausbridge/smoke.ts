// mausbridge smoke test, run after every upstream merge: bind → send → wait for completion on a
// disposable fixture server with the repository's fake ACP engine. It never touches ~/.openmausbot,
// Codex or DeepSeek. Exit 0 means the bound conversation resumed its bound session and stayed bound.
//   node --experimental-strip-types scripts/mausbridge/smoke.ts
import { launchVerificationServer, runControlOmb } from "../control-omb.ts";
import { fixtureApi } from "../testing/preview-fixture.ts";

const CURSOR = "mausbridge-smoke-session";
const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, ["customAcp"]);
const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures.push(what); };
try {
  const api = fixtureApi(fixture.info.url);
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]);

  const { instances } = await api("GET", "/api/instances");
  const acp = instances.find((instance: { instanceId: string }) => instance.instanceId === "myAgent");
  const { bot } = await api("POST", "/api/bots", { name: "Bound", modelSelection: { instanceId: "myAgent", model: acp.models.options[0].id } });

  const { binding } = await api("POST", "/api/mausbridge/bindings", { botId: bot.id, cursor: CURSOR });
  check(binding?.live === "bound", "bind: the conversation is bound");

  await control(["send", "--bot", bot.id, "--text", "smoke ping"]);
  await control(["wait", "--bot", bot.id, "--timeout", "60"]);
  const { messages } = await api("GET", `/api/threads/${bot.threadId}/messages?limit=20`);
  check(messages.some((m: { role?: string; kind?: string }) => m.role === "bot" && m.kind === "text"), "send/wait: the turn completed with a reply");

  const { bindings } = await api("GET", "/api/mausbridge/bindings");
  const after = bindings.find((b: { botId: string }) => b.botId === bot.id);
  check(after?.live === "bound", "resume: still bound after the turn");
  check(after?.drift?.length === 0, "resume: the engine kept the bound session (no replacement recorded)");
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
  console.log(`FAIL ${failures.at(-1)}`);
} finally {
  await fixture.close();
}
console.log(failures.length ? `mausbridge smoke: ${failures.length} failure(s); server log ${fixture.info.logPath}` : "mausbridge smoke: passed");
process.exit(failures.length ? 1 : 0);
