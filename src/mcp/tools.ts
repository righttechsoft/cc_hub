import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import type { Logger } from '../types.js';
import type { HubBus } from '../core/bus.js';
import { instanceNameFromCwd } from '../core/identity.js';
import * as instances from '../db/repo/instances.js';
import * as sessions from '../db/repo/sessions.js';
import * as messages from '../db/repo/messages.js';
import * as kb from '../db/repo/kb.js';
import type { McpIdentity } from './server.js';

export interface HubToolsContext {
  db: Database.Database;
  bus: HubBus;
  log: Logger;
  getIdentity: () => McpIdentity | undefined;
  bind: (identity: McpIdentity) => void;
}

const NOT_REGISTERED_TEXT = 'Not registered — call hub_register with your cwd first.';

// A session is still considered "active" for chat_peers if it's idle but had activity within
// this window — mirrors the limit watcher's own recency heuristic for interrupted candidates.
const PEER_RECENCY_MS = 5 * 60 * 1000;

// unreadFor() is a paginated inbox query (default limit 20); hub_register just needs an
// approximate unread count, so pass a generous cap instead of adding a dedicated count query.
const UNREAD_COUNT_LIMIT = 10_000;

function notRegistered() {
  return { isError: true as const, content: [{ type: 'text' as const, text: NOT_REGISTERED_TEXT }] };
}

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

export function registerHubTools(server: McpServer, ctx: HubToolsContext): void {
  server.registerTool(
    'hub_register',
    {
      description:
        'Register this Claude Code instance with cc-hub. Call this once at the start of a session, before ' +
        'using any other cc-hub tool (chat_send, chat_inbox, chat_peers, kb_add, kb_search, kb_get) — those ' +
        'tools will error until you do. Binds this MCP connection to an instance identity derived from your ' +
        'working directory (or an explicit name if you supply one), so the hub knows who is asking. Returns ' +
        'your resolved instance name, how many unread messages are waiting for you, and the list of other ' +
        'known peer instances. Cheap to call again after a hub restart.',
      inputSchema: {
        cwd: z.string().min(1).describe("Absolute path of this Claude Code instance's working directory."),
        name: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe('Optional explicit instance name. When omitted, a name is derived from cwd.'),
        session_id: z
          .string()
          .min(1)
          .optional()
          .describe(
            'The Claude Code session id for this conversation (as seen in hook payloads). Supplying it links ' +
              "this MCP connection to the hub's session tracking so remote prompts/messages route correctly."
          ),
      },
    },
    (args, extra) => {
      const instanceName = args.name ?? instanceNameFromCwd(ctx.db, args.cwd);
      instances.upsert(ctx.db, { name: instanceName, cwd: args.cwd, now: Date.now() });

      if (args.session_id && extra.sessionId) {
        sessions.bindMcp(ctx.db, args.session_id, extra.sessionId);
      }

      ctx.bind({ instanceName, cwd: args.cwd, ccSessionId: args.session_id });

      const unreadCount = messages.unreadFor(ctx.db, instanceName, UNREAD_COUNT_LIMIT).length;
      const peers = instances.list(ctx.db).map((i) => ({ name: i.name, cwd: i.cwd }));

      return jsonResult({ instanceName, unreadCount, peers });
    }
  );

  server.registerTool(
    'chat_send',
    {
      description:
        'Send a chat message to another Claude Code instance, or broadcast to every registered instance by ' +
        'omitting "to". Use this to coordinate work across projects — e.g. tell another instance you changed ' +
        'a shared API, ask it to pull latest, or hand off a task. Requires hub_register to have been called ' +
        'first this session.',
      inputSchema: {
        to: z
          .string()
          .min(1)
          .optional()
          .describe('Recipient instance name. Omit to broadcast to every registered instance.'),
        message: z.string().min(1).max(8000).describe('Message body, up to 8000 characters.'),
        urgent: z
          .boolean()
          .default(false)
          .describe('Mark as urgent — urgent messages can interrupt the recipient between turns.'),
      },
    },
    (args) => {
      const identity = ctx.getIdentity();
      if (!identity) return notRegistered();

      if (args.to) {
        const target = instances.byName(ctx.db, args.to);
        if (!target) {
          const known = instances.list(ctx.db).map((i) => i.name);
          return {
            isError: true as const,
            content: [
              {
                type: 'text' as const,
                text: `Unknown recipient "${args.to}". Known peers: ${
                  known.length ? known.join(', ') : '(none registered yet)'
                }`,
              },
            ],
          };
        }
      }

      const message = messages.send(ctx.db, {
        from: identity.instanceName,
        to: args.to ?? null,
        body: args.message,
        urgent: args.urgent,
        now: Date.now(),
      });

      ctx.bus.emit({ type: 'message', message });

      return jsonResult(message);
    }
  );

  server.registerTool(
    'chat_inbox',
    {
      description:
        'Read messages sent directly to this instance, or broadcast to everyone, that have not been read yet. ' +
        'Call this at the start of a session and whenever cc-hub tells you unread messages are waiting. By ' +
        'default marks the returned messages as read so they will not show up again.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .positive()
          .max(200)
          .default(20)
          .describe('Maximum number of messages to return.'),
        mark_read: z
          .boolean()
          .default(true)
          .describe('Whether to mark the returned messages as read for this instance.'),
      },
    },
    (args) => {
      const identity = ctx.getIdentity();
      if (!identity) return notRegistered();

      const unread = messages.unreadFor(ctx.db, identity.instanceName, args.limit);

      if (args.mark_read && unread.length > 0) {
        messages.markRead(
          ctx.db,
          unread.map((m) => m.id),
          identity.instanceName,
          Date.now()
        );
      }

      return jsonResult({ messages: unread, count: unread.length });
    }
  );

  server.registerTool(
    'chat_peers',
    {
      description:
        'List all Claude Code instances known to cc-hub: their name, working directory, last-seen time, and ' +
        'whether they currently look active (a running session, or one idle for less than a few minutes).',
      inputSchema: {},
    },
    () => {
      const identity = ctx.getIdentity();
      if (!identity) return notRegistered();

      const now = Date.now();
      const joined = sessions.listJoined(ctx.db);

      const peers = instances.list(ctx.db).map((i) => {
        const instanceSessions = joined.filter((s) => s.instance_name === i.name);
        const active = instanceSessions.some(
          (s) => s.status === 'active' || (s.status === 'idle' && now - s.last_event_at < PEER_RECENCY_MS)
        );
        return { name: i.name, cwd: i.cwd, lastSeenAt: i.last_seen_at, active };
      });

      return jsonResult({ peers });
    }
  );

  server.registerTool(
    'kb_add',
    {
      description:
        'Add a note to the shared knowledge base for other Claude Code instances — in other projects — to ' +
        'find later. Use this to record setup steps, config gotchas, commands, file paths, or anything you ' +
        'figured out the hard way that a different instance working on a different project might hit too.',
      inputSchema: {
        title: z.string().min(1).max(200).describe('Short descriptive title, up to 200 characters.'),
        body: z.string().min(1).max(50000).describe('Full note body, up to 50000 characters.'),
        tags: z
          .string()
          .max(500)
          .default('')
          .describe('Space-separated tags to help others find this note.'),
      },
    },
    (args) => {
      const identity = ctx.getIdentity();
      if (!identity) return notRegistered();

      const note = kb.add(ctx.db, {
        title: args.title,
        body: args.body,
        tags: args.tags,
        author: identity.instanceName,
        now: Date.now(),
      });

      return jsonResult(note);
    }
  );

  server.registerTool(
    'kb_search',
    {
      description:
        'Search the shared knowledge base. ALWAYS try this before solving a setup, configuration, or tooling ' +
        'problem from scratch — another instance may have already solved it and left a note. Full-text search ' +
        'over titles, bodies, and tags.',
      inputSchema: {
        query: z.string().min(1).describe('Search query (full-text; matches title, body, and tags).'),
        limit: z.number().int().positive().max(50).default(5).describe('Maximum number of results to return.'),
      },
    },
    (args) => {
      const identity = ctx.getIdentity();
      if (!identity) return notRegistered();

      const results = kb.search(ctx.db, args.query, args.limit);

      return jsonResult({ results, count: results.length });
    }
  );

  server.registerTool(
    'kb_get',
    {
      description: 'Fetch the full body of a knowledge base note by id (from kb_search results).',
      inputSchema: {
        id: z.number().int().positive().describe('Note id, as returned by kb_search.'),
      },
    },
    (args) => {
      const identity = ctx.getIdentity();
      if (!identity) return notRegistered();

      const note = kb.get(ctx.db, args.id);
      if (!note) {
        return {
          isError: true as const,
          content: [{ type: 'text' as const, text: `No knowledge base note with id ${args.id}.` }],
        };
      }

      return jsonResult(note);
    }
  );
}
