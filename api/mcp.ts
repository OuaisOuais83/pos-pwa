// Point d'entrée Vercel : https://<projet>.vercel.app/<CLE_CONNECTEUR>/mcp
// La clé secrète dans l'adresse protège le coffre : sans elle, 404.
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "../lib/server.js";

export const config = { maxDuration: 300 };

function keyOk(given: string | undefined): boolean {
  const expected = process.env.CONNECTOR_KEY;
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req: IncomingMessage & { body?: unknown; query?: Record<string, string | string[]> }, res: ServerResponse) {
  const k = req.query?.k;
  if (!keyOk(Array.isArray(k) ? k[0] : k)) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }
  if (req.method === "GET" || req.method === "DELETE") {
    // Mode sans session : pas de flux SSE persistant.
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }));
    return;
  }
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
