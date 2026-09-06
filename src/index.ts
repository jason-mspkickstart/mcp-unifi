import { authenticate, unauthorised } from "./auth";
import type { Env } from "./env";
import { toolsFor } from "./tools";
import { UnifiClient, UnifiError } from "./unifi";

const PROTOCOL_VERSION = "2024-11-05";

interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, any>;
}

function result(id: unknown, value: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: value }), {
    headers: { "content-type": "application/json" },
  });
}

function rpcError(id: unknown, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    headers: { "content-type": "application/json" },
  });
}

/** Tool failures are reported as results with isError, not as JSON-RPC errors, so the model can read and act on them. */
function toolFailure(id: unknown, message: string): Response {
  return result(id, { content: [{ type: "text", text: message }], isError: true });
}

async function handleRpc(req: JsonRpcRequest, env: Env, apiKey: string): Promise<Response> {
  const { id, method, params } = req;

  if (method.startsWith("notifications/")) {
    // Notifications carry no id and expect no body.
    return new Response(null, { status: 202 });
  }

  switch (method) {
    case "initialize":
      return result(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: "mcp-unifi", version: "0.1.0" },
      });

    case "ping":
      return result(id, {});

    case "resources/list":
      return result(id, { resources: [] });

    case "prompts/list":
      return result(id, { prompts: [] });

    case "tools/list":
      return result(id, {
        tools: toolsFor(env).map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });

    case "tools/call": {
      const name = params?.name;
      const tool = toolsFor(env).find((t) => t.name === name);
      if (!tool) return toolFailure(id, `Unknown tool: ${name}. Call tools/list to see what is available.`);

      try {
        const value = await tool.handler(params?.arguments ?? {}, {
          client: new UnifiClient(apiKey, env),
          env,
          apiKey,
        });
        return result(id, { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
      } catch (err) {
        if (err instanceof UnifiError) return toolFailure(id, err.message);
        return toolFailure(id, `Unexpected failure in ${name}: ${String(err)}`);
      }
    }

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }

    // URL fallback for clients that cannot set custom headers at all.
    const tokenMatch = url.pathname.match(/^\/mcp\/t\/([^/]+)$/);
    const isMcp = url.pathname === "/mcp" || tokenMatch !== null;
    if (!isMcp) return new Response("Not found", { status: 404 });

    if (request.method !== "POST") {
      return new Response("Method not allowed. POST JSON-RPC to /mcp.", { status: 405 });
    }

    const auth = authenticate(request, env, tokenMatch ? decodeURIComponent(tokenMatch[1]) : null);
    if (!auth.ok) return unauthorised(auth.status ?? 401, auth.message ?? "Unauthorised");

    let body: JsonRpcRequest;
    try {
      body = (await request.json()) as JsonRpcRequest;
    } catch {
      return rpcError(null, -32700, "Request body was not valid JSON.");
    }

    if (!body?.method) return rpcError(body?.id ?? null, -32600, "Missing method.");

    return handleRpc(body, env, auth.upstreamKey!);
  },
};
