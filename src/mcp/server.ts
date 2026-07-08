import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type Database from 'better-sqlite3';
import type { Logger } from '../types.js';
import type { HubBus } from '../core/bus.js';
import { registerHubTools } from './tools.js';

const HUB_SERVER_VERSION = '0.1.0';

// Identity bound to one MCP (Streamable HTTP) session, established by the hub_register tool.
export interface McpIdentity {
  instanceName: string;
  cwd: string;
  ccSessionId?: string;
}

export interface McpGatewayDeps {
  db: Database.Database;
  bus: HubBus;
  log: Logger;
}

// Bridges Hono's Node HTTP bindings to the MCP SDK's Streamable HTTP transport, one transport
// per Mcp-Session-Id, and tracks which hub instance identity each session has registered as.
export class McpGateway {
  private readonly transports = new Map<string, StreamableHTTPServerTransport>();
  private readonly bindings = new Map<string, McpIdentity>();
  private readonly db: Database.Database;
  private readonly bus: HubBus;
  private readonly log: Logger;

  constructor(deps: McpGatewayDeps) {
    this.db = deps.db;
    this.bus = deps.bus;
    this.log = deps.log;
  }

  identityFor(mcpSessionId: string | undefined): McpIdentity | undefined {
    if (!mcpSessionId) return undefined;
    return this.bindings.get(mcpSessionId);
  }

  async handle(c: Context<{ Bindings: HttpBindings }>): Promise<Response> {
    const method = c.req.method;
    const sessionIdHeader = c.req.header('mcp-session-id');

    let transport = sessionIdHeader ? this.transports.get(sessionIdHeader) : undefined;

    // Read+parse the body once here (POST only) so we can inspect it for isInitializeRequest,
    // then hand the already-parsed value to transport.handleRequest so it doesn't try to
    // re-read the (already consumed) raw Node request stream.
    let parsedBody: unknown;
    if (method === 'POST') {
      try {
        parsedBody = await c.req.json<unknown>();
      } catch {
        parsedBody = undefined;
      }
    }

    if (!transport) {
      if (sessionIdHeader) {
        return c.json(
          { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null },
          404
        );
      }

      if (method !== 'POST' || !isInitializeRequest(parsedBody)) {
        return c.json(
          {
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
            id: null,
          },
          400
        );
      }

      transport = await this.createTransport();
    }

    await transport.handleRequest(c.env.incoming, c.env.outgoing, parsedBody);
    return RESPONSE_ALREADY_SENT;
  }

  private async createTransport(): Promise<StreamableHTTPServerTransport> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (sessionId) => {
        this.transports.set(sessionId, transport);
      },
      onsessionclosed: (sessionId) => {
        this.transports.delete(sessionId);
        this.bindings.delete(sessionId);
      },
    });

    const server = new McpServer({ name: 'cc-hub', version: HUB_SERVER_VERSION });

    registerHubTools(server, {
      db: this.db,
      bus: this.bus,
      log: this.log,
      getIdentity: () => this.identityFor(transport.sessionId),
      bind: (identity) => {
        if (transport.sessionId) this.bindings.set(transport.sessionId, identity);
      },
    });

    await server.connect(transport);

    return transport;
  }
}
