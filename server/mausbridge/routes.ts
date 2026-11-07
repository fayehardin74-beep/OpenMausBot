// /api/mausbridge/bindings: list (GET), bind (POST {botId, threadId?, instanceId?, cursor}),
// unbind (DELETE /api/mausbridge/bindings/<botId>[/<threadId>]). Loopback callers only: a binding
// names a provider session id, which upstream never lets leave this computer.
import { z } from "zod";

import { PASS, type RouteHandler } from "../routes/table.ts";
import { BindingError, type SessionBindings } from "./session-bindings.ts";

const bindBody = z.object({
  botId: z.string().min(1).max(200),
  threadId: z.string().min(1).max(200).optional(),
  instanceId: z.string().min(1).max(200).optional(),
  cursor: z.string().min(1).max(400),
}).strict();

export function createMausbridgeRoutes(bindings: () => SessionBindings | undefined): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (!path.startsWith("/api/mausbridge/")) return PASS;
    if (auth.kind !== "loopback") return json(res, 403, { error: "只有本机上的 OpenMausBot 能管理会话绑定" });
    const service = bindings();
    if (!service) return json(res, 503, { error: "mausbridge 还没启动" });
    try {
      if (path === "/api/mausbridge/bindings" && method === "GET") return json(res, 200, { bindings: service.list() });
      if (path === "/api/mausbridge/bindings" && method === "POST") {
        const checked = bindBody.safeParse(await readBody(req));
        if (!checked.success) return json(res, 400, { error: checked.error.message });
        return json(res, 200, { binding: service.bind(checked.data) });
      }
      const m = path.match(/^\/api\/mausbridge\/bindings\/([\w-]+)(?:\/([\w-]+))?$/);
      if (m && method === "DELETE") { const removed = service.unbind(m[1]!, m[2]); return json(res, removed ? 200 : 404, { removed }); }
      return json(res, 404, { error: "no such mausbridge route" });
    } catch (error) {
      if (error instanceof BindingError) return json(res, error.status, { error: error.message });
      throw error;
    }
  };
}
