/** The read-only HTTP surface, mounted as Vite middleware so \`vite\` and
 * \`vite preview\` serve the same API the UI polls. There is no write route. */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getState } from "./state.ts";
import { readLaneMessages } from "./rooms.ts";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-length", Buffer.byteLength(payload));
  res.end(payload);
}

export function apiMiddleware() {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) {
      next();
      return;
    }
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "read-only API" });
      return;
    }
    const refresh = url.searchParams.get("refresh") === "1";
    if (url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, service: "fleet-graph", read_only: true });
      return;
    }
    if (url.pathname === "/api/state") {
      getState({ refresh })
        .then((state) => sendJson(res, 200, state))
        .catch((error) => sendJson(res, 503, { error: String(error?.message ?? error) }));
      return;
    }
    const laneMatch = /^\/api\/lane\/([^/]+)\/messages$/.exec(url.pathname);
    if (laneMatch) {
      const lane = decodeURIComponent(laneMatch[1]);
      const result = readLaneMessages(lane, { limit: Number(url.searchParams.get("limit") ?? 500) });
      sendJson(res, 200, { lane, operator: process.env.FLEET_GRAPH_OPERATOR ?? "operator", ...result });
      return;
    }
    sendJson(res, 404, { error: "no such route", read_only: true });
  };
}
