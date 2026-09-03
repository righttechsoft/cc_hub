import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import type { Logger } from '../types.js';
import type { HubBus } from '../core/bus.js';
import { INSTANCE_NAME_RE, instanceNameFromCwd, resolveExplicitInstanceName } from '../core/identity.js';
import * as instances from '../db/repo/instances.js';
import * as instanceApps from '../db/repo/instanceApps.js';
import * as sessions from '../db/repo/sessions.js';
import * as messages from '../db/repo/messages.js';
import * as kb from '../db/repo/kb.js';
import type { Athen } from '../kb/athen.js';
import type { McpIdentity } from './server.js';

export interface HubToolsContext {
  db: Database.Database;
  bus: HubBus;
  log: Logger;
  athen: Athen;
  getIdentity: () => McpIdentity | undefined;
  bind: (identity: McpIdentity) => void;
  // Optional: nudges the idle chat delivery loop so chat_send reaches idle recipients immediately.
  pokeChatDelivery?: () => void;
}

const NOT_REGISTERED_TEXT = 'Not registered — call hub_register with your cwd first.';

// Mirrors app.ts's NOTICE_TEXT_MAX_CHARS cap on the automatically-captured path, so a URL set
// explicitly via this tool and one captured from cc-attach's output-trigger notice share a limit.
const APP_URL_MAX_LENGTH = 300;
const HTTP_URL_RE = /^https?:\/\//i;

// A session is still considered "active" for chat_peers if it's idle but had activity within
// this window — mirrors the limit watcher's own recency heuristic for interrupted candidates.
const PEER_RECENCY_MS = 5 * 60 * 1000;

// unreadFor() is a paginated inbox query (default limit 20); hub_register just needs an
// approximate unread count, so pass a generous cap instead of adding a dedicated count query.
const UNREAD_COUNT_LIMIT = 10_000;

// Reserved recipient names with no backing `instances` row. 'overlord' is the admin page's AI
// Overlord ask-mode sender (src/overlord/overlord.ts + POST /api/v1/admin/overlord-send in
// apiRoutes.ts) — it messages live instances directly and expects replies back to itself, so
// chat_send's normal "unknown recipient" rejection must not apply to it. This is safe: chatDelivery
// (src/chat/chatDelivery.ts) only ever iterates instancesRepo.list(), so a message addressed to a
// name with no instance row is naturally inert there — nothing tries to spawn/inject a turn for it.
const RESERVED_RECIPIENTS = new Set(['overlord']);

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
        'using any other cc-hub tool (chat_send, chat_inbox, chat_peers, athen_save, athen_search, athen_get) — ' +
        'those tools will error until you do. Binds this MCP connection to an instance identity: an explicit ' +
        '`name` wins if you supply one; otherwise pass `session_id` (from hook payloads) so a named terminal\'s ' +
        "agent binds to its own task identity instead of its folder's default; otherwise identity is derived " +
        'from your working directory. Returns your resolved instance name, how many unread messages are ' +
        'waiting for you, and the list of other known peer instances. Cheap to call again after a hub restart.',
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
              "this MCP connection to the hub's session tracking so remote prompts/messages route correctly, " +
              'and — when that session is already bound to a named instance (a named terminal) — binds this ' +
              'connection to that same named instance instead of the cwd default.'
          ),
      },
    },
    (args, extra) => {
      let instanceName: string;
      let resolvedVia: 'name' | 'session' | 'active-named-session' | 'cwd';

      if (args.name) {
        const requested = args.name.toLowerCase();
        if (!INSTANCE_NAME_RE.test(requested)) {
          return {
            isError: true as const,
            content: [
              {
                type: 'text' as const,
                text: `Invalid name "${args.name}" — must match ${INSTANCE_NAME_RE.source} (after lowercasing).`,
              },
            ],
          };
        }
        const resolved = resolveExplicitInstanceName(ctx.db, requested, args.cwd);
        if (resolved.collided) {
          ctx.log.warn('hub_register: instance name collision, disambiguated', {
            requested,
            resolved: resolved.name,
            cwd: args.cwd,
          });
        }
        instanceName = resolved.name;
        instances.upsertNamed(ctx.db, { name: instanceName, cwd: args.cwd, now: Date.now() });
        resolvedVia = 'name';
      } else {
        // A session already bound to an instance (by SessionStart, via CC_HUB_NAME) is
        // authoritative for THAT session's identity — a named terminal's session is bound to its
        // named instance there, and re-deriving from cwd here would collapse it back into the
        // folder's default instance (see CLAUDE.md's Identity model bug writeup).
        const boundInstanceName = args.session_id
          ? sessions.getJoined(ctx.db, args.session_id)?.instance_name ?? undefined
          : undefined;

        if (boundInstanceName) {
          instanceName = boundInstanceName;
          resolvedVia = 'session';
        } else {
          // Tier 3: the sole active session in this cwd bound to a NAMED instance (see
          // sessions.soleActiveNamedInstanceForCwd's doc comment / CLAUDE.md's Identity model) —
          // covers a dispatched agent that calls hub_register with only cwd, without relying on
          // the model to cooperate by passing session_id/name. Ambiguous (0 or >1 match) falls
          // through to the cwd default below.
          const soleActive = sessions.soleActiveNamedInstanceForCwd(ctx.db, args.cwd);
          if (soleActive) {
            instanceName = soleActive.name;
            resolvedVia = 'active-named-session';
          } else {
            instanceName = instanceNameFromCwd(ctx.db, args.cwd);
            instances.upsert(ctx.db, { name: instanceName, cwd: args.cwd, now: Date.now() });
            resolvedVia = 'cwd';
          }
        }
      }

      if (args.session_id && extra.sessionId) {
        sessions.bindMcp(ctx.db, args.session_id, extra.sessionId);
      }

      ctx.bind({ instanceName, cwd: args.cwd, ccSessionId: args.session_id });
      ctx.log.debug(`hub_register: bound via ${resolvedVia}`, {
        instanceName,
        cwd: args.cwd,
        session_id: args.session_id,
      });

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

      if (args.to && !RESERVED_RECIPIENTS.has(args.to)) {
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
      ctx.pokeChatDelivery?.();

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
    'hub_set_url',
    {
      description:
        "Tell the hub the URL of the app/dev server this instance is running — it's shown in the hub's admin " +
        'UI. Call it whenever you start or change a local server (e.g. after `npm run dev` prints ' +
        '"Local: http://localhost:5173/"). Requires hub_register to have been called first this session. ' +
        'For an instance running multiple apps (several web servers, or a mix of web + desktop apps), use ' +
        'hub_set_apps instead.',
      inputSchema: {
        url: z
          .string()
          .min(1)
          .max(APP_URL_MAX_LENGTH)
          .describe('Full URL of the running app/dev server, e.g. http://localhost:5173'),
      },
    },
    (args) => {
      const identity = ctx.getIdentity();
      if (!identity) return notRegistered();

      if (!HTTP_URL_RE.test(args.url)) {
        return {
          isError: true as const,
          content: [{ type: 'text' as const, text: 'url must start with http:// or https://' }],
        };
      }

      // Looked up by the identity's resolved name, not cwd — several instances can share a cwd
      // (named per-task agents), and byName is the one that always finds THIS caller's own row.
      const instance = instances.byName(ctx.db, identity.instanceName);
      if (!instance) return notRegistered();

      const now = Date.now();
      instances.setAppUrl(ctx.db, instance.id, args.url, now);
      instanceApps.upsert(ctx.db, instance.id, instanceApps.labelFromUrl(args.url), args.url, now);

      return jsonResult({ ok: true, url: args.url });
    }
  );

  server.registerTool(
    'hub_set_apps',
    {
      description:
        'Declare the apps/servers this instance is currently running (web apps with url, desktop apps ' +
        "label-only) — shown in the hub admin footer and the user's statusline. Call with the full current " +
        'list whenever it changes; call with [] when they stop. Replaces this instance\'s whole list — it ' +
        'is not additive. Requires hub_register to have been called first this session.',
      inputSchema: {
        apps: z
          .array(
            z.object({
              label: z.string().min(1).max(60).describe('Short name for the app, e.g. "localhost:5173" or "desktop app".'),
              url: z
                .string()
                .max(APP_URL_MAX_LENGTH)
                .optional()
                .describe('Full URL (must start with http:// or https://), for a web app. Omit for a desktop app.'),
            })
          )
          .max(10)
          .describe('The complete current list of running apps — pass [] to clear.'),
      },
    },
    (args) => {
      const identity = ctx.getIdentity();
      if (!identity) return notRegistered();

      const badUrl = args.apps.find((a) => a.url !== undefined && !HTTP_URL_RE.test(a.url));
      if (badUrl) {
        return {
          isError: true as const,
          content: [
            { type: 'text' as const, text: `url must start with http:// or https:// (got "${badUrl.label}")` },
          ],
        };
      }

      const instance = instances.byName(ctx.db, identity.instanceName);
      if (!instance) return notRegistered();

      instanceApps.replaceAll(ctx.db, instance.id, args.apps, Date.now());

      return jsonResult({ ok: true, apps: args.apps });
    }
  );

  server.registerTool(
    'athen_save',
    {
      description:
        'Save a note to Athen — the shared know-how store all Claude Code instances can search. Use this ' +
        'when told to "save this to athen", and after figuring out anything reusable the hard way: setup ' +
        'steps, config gotchas, commands, file paths, how-to instructions. Notes are embedded for semantic ' +
        'search, so other instances find them by meaning, not exact words.',
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
    async (args) => {
      const identity = ctx.getIdentity();
      if (!identity) return notRegistered();

      const note = await ctx.athen.save({
        title: args.title,
        body: args.body,
        tags: args.tags,
        author: identity.instanceName,
      });

      return jsonResult(note);
    }
  );

  server.registerTool(
    'athen_search',
    {
      description:
        'Search Athen, the shared know-how store — semantic: finds notes by meaning, not exact words. Use ' +
        'this when asked "does athen know about X", and ALWAYS before solving a setup, configuration, or ' +
        'tooling problem from scratch — another instance may have already solved it and left a note.',
      inputSchema: {
        query: z.string().min(1).describe('What to look for — plain language; matched by meaning and by keywords.'),
        limit: z.number().int().positive().max(50).default(5).describe('Maximum number of results to return.'),
      },
    },
    async (args) => {
      const identity = ctx.getIdentity();
      if (!identity) return notRegistered();

      const results = await ctx.athen.search(args.query, args.limit);

      return jsonResult({ results, count: results.length });
    }
  );

  server.registerTool(
    'athen_get',
    {
      description: 'Fetch the full body of an Athen note by id (from athen_search results).',
      inputSchema: {
        id: z.number().int().positive().describe('Note id, as returned by athen_search.'),
      },
    },
    (args) => {
      const identity = ctx.getIdentity();
      if (!identity) return notRegistered();

      const note = kb.get(ctx.db, args.id);
      if (!note) {
        return {
          isError: true as const,
          content: [{ type: 'text' as const, text: `No Athen note with id ${args.id}.` }],
        };
      }

      return jsonResult(note);
    }
  );
}
