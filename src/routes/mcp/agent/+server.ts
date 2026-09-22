import { timingSafeEqual } from 'node:crypto';
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { handleAgentMcpMessage } from '$lib/server/agentMcp';
import { getStore } from '$lib/server/projectApi';

const MAX_BODY = 512 * 1024;
const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };

/** Constant-time bearer check. Returns false when no token is configured, so the
 * route is closed until `OPENPLAN3D_MCP_TOKEN` is set. */
function authorized(request: Request): boolean {
  const expected = env.OPENPLAN3D_MCP_TOKEN?.trim();
  if (!expected) return false;
  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

const rpcError = (code: number, message: string, status: number) =>
  json({ jsonrpc: '2.0', id: null, error: { code, message } }, { status, headers });

/** Streamable HTTP transport, stateless: every POST carries one JSON-RPC message
 * or a batch. Bearer-gated; mcp-server aggregates this endpoint behind the one
 * beercan-mcp front door and injects the token. */
export async function POST({ request }: { request: Request }) {
  const configured = env.OPENPLAN3D_MCP_TOKEN?.trim();
  if (!configured) return rpcError(-32000, 'The project MCP endpoint is not configured.', 503);
  if (!authorized(request)) return rpcError(-32001, 'Unauthorized', 401);
  if (Number(request.headers.get('content-length')) > MAX_BODY) return rpcError(-32600, 'Request too large', 413);

  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) throw new Error('too large');
    body = JSON.parse(text);
  } catch {
    return rpcError(-32700, 'Parse error', 400);
  }

  const deps = { store: await getStore() };
  if (Array.isArray(body)) {
    if (body.length > 20) return rpcError(-32600, 'Batch too large', 400);
    const responses = (await Promise.all(body.map((message) => handleAgentMcpMessage(message, deps)))).filter(Boolean);
    return responses.length ? json(responses, { status: 200, headers }) : new Response(null, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  }
  const response = await handleAgentMcpMessage(body, deps);
  return response ? json(response, { status: 200, headers }) : new Response(null, { status: 202, headers: { 'Cache-Control': 'no-store' } });
}

const notAllowed = () => new Response(null, { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } });
export const GET = notAllowed;
export const DELETE = notAllowed;
