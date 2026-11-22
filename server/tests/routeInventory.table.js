// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The route inventory: every route that reaches a run, an interaction or a
 * chat, with the access check it makes, the intent it passes and the status
 * each of five callers gets.
 *
 * `routeInventory.test.js` reads the routes the server registers and fails
 * when one below {@link INVENTORY_PREFIXES} has no row here, and when a route
 * of a module in {@link RUN_ACCESS_ROUTE_FILES} has none, whatever its path.
 * So a new route cannot go in without somebody deciding who may call it. Add
 * the row in the pull request that adds the route.
 *
 * Not in the inventory, and not decided through `services/loop/runAccess.js`:
 * the workflow execution routes (`/api/workflows/executions/...`, a frozen
 * legacy file). They keep their own owner-or-admin checks; see
 * docs/run-ledger.md, "Routes with their own check".
 *
 * The five callers (the columns of `expect`):
 *
 * - `owner`: a signed-in user who owns the run or the chat.
 * - `otherUser`: a signed-in user who owns nothing of it.
 * - `admin`: an administrator who is not the owner.
 * - `guestWithCookie`: an anonymous visitor in the browser session that owns
 *   the run's chat (the guest cookie), asking for that run or chat.
 * - `idHolder`: an anonymous caller who holds the id of that visitor's run or
 *   chat and nothing else.
 *
 * `expect` is the status when the request is otherwise valid. A row with
 * `probe` is asked of the real route by the test, caller by caller; a row
 * with `declared` states what the code does and names the suite that tests it.
 *
 * @module tests/routeInventory.table
 */

/** The callers, in the order of the status columns. */
export const CALLERS = Object.freeze([
  'owner',
  'otherUser',
  'admin',
  'guestWithCookie',
  'idHolder'
]);

/** Every registered route whose path starts with one of these needs a row. */
export const INVENTORY_PREFIXES = Object.freeze([
  '/api/runs',
  '/api/chats',
  '/api/interactions',
  '/api/apps/:appId/chat'
]);

/**
 * The route modules that decide through `services/loop/runAccess.js`. A module
 * that starts to import it is listed here, and every route it registers gets a
 * row, also one that reaches no run: the test registers each module alone and
 * compares. A row is then the place where somebody wrote down that the new
 * route of such a module was looked at.
 */
export const RUN_ACCESS_ROUTE_FILES = Object.freeze([
  'server/routes/chat/feedbackRoutes.js',
  'server/routes/chat/sessionRoutes.js',
  'server/routes/mcpAppRoutes.js',
  'server/routes/runs.js'
]);

/**
 * One status per caller.
 *
 * @param {number} owner
 * @param {number} otherUser
 * @param {number} admin
 * @param {number} guestWithCookie
 * @param {number} idHolder
 * @returns {Readonly<Record<string, number>>}
 */
function statuses(owner, otherUser, admin, guestWithCookie, idHolder) {
  return Object.freeze({ owner, otherUser, admin, guestWithCookie, idHolder });
}

// Run intents (`authorizeRun`): 403 for a run the caller knows and may not use.
const RUN_READ = statuses(200, 403, 200, 200, 200);
const RUN_STOP = statuses(200, 403, 200, 200, 403);
const RUN_DELETE = statuses(200, 403, 200, 200, 403);
const RUN_OWNER_ONLY = statuses(200, 403, 403, 200, 403);

// Chat intents (`authorizeChat`): 404 for a chat that is not the caller's.
const CHAT_READ = statuses(200, 404, 200, 200, 404);
const CHAT_OWNER_READ = statuses(200, 404, 404, 404, 404);

// A route of a run access module that reaches no run, no interaction and no
// chat: what it answers depends on the app, the tool or the model, and never
// on who owns a run. The status is the one of a caller who may use those.
const NOT_BY_RUN = 'none: no run, interaction or chat is reached';
const MCP_APP_SUITE =
  'the caller needs the app and its tool (resolveMcpApp, server/tests/mcp/mcpAppRoutes.test.js)';

const CHAT_SUITES =
  'authorizeChat decides (server/tests/chat-persistence-routes.test.js, chatSessionRoutesErrors.test.js)';

/**
 * A row.
 *
 * @typedef {Object} InventoryRow
 * @property {string} route - `METHOD /path`, as the router registers it
 * @property {Array<InventoryCase>} cases - one per intent the route passes
 */

/**
 * @typedef {Object} InventoryCase
 * @property {string} check - the function that decides
 * @property {string} intent - the intent the route passes to it
 * @property {string} [when] - which requests of the route this case is about
 * @property {Readonly<Record<string, number>>} expect - the status per caller
 * @property {Object} [probe] - how the test asks the real route
 * @property {Object} [probe.body] - the request body
 * @property {boolean} [probe.interaction] - the route addresses a pending approval
 * @property {boolean} [probe.queuedMessage] - the route addresses a message the run's owner
 *   queued for the running answer (`:id`)
 * @property {string} [declared] - for a case the test does not ask: where it is tested
 */

/** @type {ReadonlyArray<InventoryRow>} */
export const ROUTE_INVENTORY = Object.freeze([
  // ── /api/runs ────────────────────────────────────────────────────────────
  {
    route: 'GET /api/runs',
    cases: [
      {
        check: 'adminAuth',
        intent: 'list every run',
        expect: statuses(403, 403, 200, 403, 403),
        probe: {}
      }
    ]
  },
  {
    route: 'GET /api/runs/:runId',
    cases: [{ check: 'authorizeRun', intent: 'read', expect: RUN_READ, probe: {} }]
  },
  {
    route: 'GET /api/runs/:runId/events',
    cases: [{ check: 'authorizeRun', intent: 'read', expect: RUN_READ, probe: {} }]
  },
  {
    route: 'DELETE /api/runs/:runId',
    cases: [{ check: 'authorizeRun', intent: 'delete', expect: RUN_DELETE, probe: {} }]
  },
  {
    route: 'GET /api/runs/:runId/evidence',
    cases: [
      {
        check: 'readEvidenceRecord',
        intent: 'read (the run’s caller only)',
        expect: statuses(200, 404, 404, 404, 404),
        declared:
          'the record is read by owner id, an admin and an anonymous caller get 404 like anyone else (server/tests/chat-evidence-routes.test.js)'
      }
    ]
  },
  {
    route: 'GET /api/runs/:runId/evidence/content/:sha256',
    cases: [
      {
        check: 'readEvidenceContent',
        intent: 'read (the run’s caller only)',
        expect: statuses(200, 404, 404, 404, 404),
        declared:
          'the record is read by owner id, an admin and an anonymous caller get 404 like anyone else (server/tests/chat-evidence-routes.test.js)'
      }
    ]
  },
  {
    route: 'GET /api/runs/:runId/interactions',
    cases: [
      {
        check: 'authorizeRun, then authorizeInteraction',
        intent: 'read',
        expect: RUN_READ,
        probe: { interaction: true }
      }
    ]
  },
  {
    route: 'POST /api/runs/:runId/interactions/:interactionId/answer',
    cases: [
      {
        check: 'authorizeInteraction',
        intent: 'answer',
        // An admin answers only for a run that belongs to no person (an
        // agent's own identity, a triggered workflow): steerApproval.test.js.
        when: 'the interaction names no approver group and its run is a person’s',
        expect: RUN_OWNER_ONLY,
        probe: { interaction: true, body: { decision: 'approve' } }
      }
    ]
  },
  {
    route: 'POST /api/runs/:runId/human-events',
    cases: [
      {
        check: 'authorizeRun',
        intent: 'steer',
        when: "kind: 'steer'",
        expect: RUN_OWNER_ONLY,
        probe: { body: { kind: 'steer', message: 'Use the newer report' } }
      },
      {
        check: 'authorizeRun',
        intent: 'stop',
        when: "kind: 'stop'",
        expect: RUN_STOP,
        probe: { body: { kind: 'stop' } }
      },
      {
        check: 'authorizeRun',
        intent: 'feedback',
        when: "kind: 'feedback'",
        expect: RUN_OWNER_ONLY,
        probe: { body: { kind: 'feedback', rating: 1 } }
      }
    ]
  },
  {
    route: 'DELETE /api/runs/:runId/human-events/:id',
    cases: [
      {
        check: 'authorizeRun',
        // Removing a queued message is the owner's own, like sending it.
        intent: 'steer',
        expect: statuses(204, 403, 403, 204, 403),
        probe: { queuedMessage: true }
      }
    ]
  },

  // ── interactions ─────────────────────────────────────────────────────────
  {
    route: 'GET /api/interactions/pending',
    cases: [
      {
        check: 'the caller’s own queue',
        intent: 'read',
        // Every signed-in caller gets a list: their own interactions and those
        // of their approver groups; an admin all of them, redacted.
        expect: statuses(200, 200, 200, 403, 403),
        probe: {}
      }
    ]
  },
  {
    route: 'POST /api/mcp-apps/tools/call/approval',
    cases: [
      {
        check: 'authorizeInteraction',
        intent: 'answer',
        expect: statuses(200, 403, 403, 403, 403),
        declared:
          'the real check with the route’s intent, for the owner, another user and an admin (server/tests/mcp/mcpAppRoutes.test.js); an approval of a view’s call records no owner for an anonymous visitor, so no anonymous caller answers it'
      }
    ]
  },
  {
    route: 'POST /api/feedback',
    cases: [
      {
        check: 'authorizeRun',
        intent: 'feedback',
        // The rating is stored for whoever may use the app. Run access decides
        // only whether it is also written to the run's ledger: for the owner.
        expect: statuses(204, 204, 204, 204, 204),
        declared:
          'the status does not depend on run access; who writes into the run’s ledger does (server/tests/feedbackRunIntent.test.js)'
      }
    ]
  },

  // ── the other routes of the modules that decide through run access ───────
  {
    route: 'GET /api/mcp-apps/sandbox',
    cases: [
      {
        check: 'none: a static page without data',
        intent: NOT_BY_RUN,
        expect: statuses(200, 200, 200, 200, 200),
        declared: 'server/tests/mcp/mcpAppRoutes.test.js'
      }
    ]
  },
  {
    route: 'GET /api/mcp-apps/resource',
    cases: [
      {
        check: 'resolveMcpApp',
        intent: NOT_BY_RUN,
        expect: statuses(200, 200, 200, 200, 200),
        declared: MCP_APP_SUITE
      }
    ]
  },
  {
    route: 'POST /api/mcp-apps/tools/call',
    cases: [
      {
        check: 'resolveMcpApp',
        intent: NOT_BY_RUN,
        // A call that needs approval answers 202 and raises the approval for
        // the caller; it reads and answers none.
        expect: statuses(200, 200, 200, 200, 200),
        declared: MCP_APP_SUITE
      }
    ]
  },
  {
    route: 'POST /api/mcp-apps/handshake',
    cases: [
      {
        check: 'resolveMcpApp',
        intent: NOT_BY_RUN,
        expect: statuses(204, 204, 204, 204, 204),
        declared: MCP_APP_SUITE
      }
    ]
  },
  {
    route: 'POST /api/mcp-apps/resources/read',
    cases: [
      {
        check: 'resolveMcpApp',
        intent: NOT_BY_RUN,
        expect: statuses(200, 200, 200, 200, 200),
        declared: MCP_APP_SUITE
      }
    ]
  },
  {
    route: 'GET /api/models/:modelId/chat/test',
    cases: [
      {
        check: 'modelAccessRequired',
        intent: NOT_BY_RUN,
        expect: statuses(200, 200, 200, 200, 200),
        declared:
          'the caller needs the model (server/tests/chatSessionRoutesErrors.test.js, anonymous-principal.test.js)'
      }
    ]
  },

  // ── /api/apps/:appId/chat ────────────────────────────────────────────────
  {
    route: 'GET /api/apps/:appId/chat/:chatId',
    cases: [{ check: 'authorizeChat', intent: 'read', expect: CHAT_READ, declared: CHAT_SUITES }]
  },
  {
    route: 'GET /api/apps/:appId/chat/:chatId/status',
    cases: [{ check: 'authorizeChat', intent: 'read', expect: CHAT_READ, declared: CHAT_SUITES }]
  },
  {
    route: 'POST /api/apps/:appId/chat/:chatId',
    cases: [
      {
        check: 'authorizeChat',
        intent: 'write',
        expect: statuses(200, 404, 404, 200, 404),
        declared: CHAT_SUITES
      },
      {
        check: 'authorizeInteraction',
        intent: 'answer',
        when: 'the message answers or supersedes a question or a tool approval of the chat',
        // The turn itself is not refused: a question that is not the sender's
        // stays as it was, and an approval answers 403 APPROVAL_FORBIDDEN.
        expect: statuses(200, 404, 404, 200, 404),
        declared:
          'the three call sites with the real check, as an admin and as another user (server/tests/chatAnswerIntent.test.js)'
      }
    ]
  },
  {
    route: 'POST /api/apps/:appId/chat/:chatId/stop',
    cases: [
      {
        check: 'authorizeChat',
        intent: 'write',
        expect: statuses(204, 404, 404, 204, 404),
        declared: CHAT_SUITES
      }
    ]
  },

  // ── /api/chats ───────────────────────────────────────────────────────────
  {
    route: 'GET /api/chats',
    cases: [
      {
        check: 'authenticatedOnly',
        intent: 'list the caller’s own chats',
        expect: statuses(200, 200, 200, 401, 401),
        declared: CHAT_SUITES
      }
    ]
  },
  {
    route: 'GET /api/chats/:chatId',
    cases: [{ check: 'authorizeChat', intent: 'read', expect: CHAT_READ, declared: CHAT_SUITES }]
  },
  {
    route: 'PATCH /api/chats/:chatId',
    cases: [
      {
        check: 'authenticatedOnly, authorizeChat',
        intent: 'write',
        expect: statuses(200, 404, 404, 401, 401),
        declared: CHAT_SUITES
      }
    ]
  },
  {
    route: 'DELETE /api/chats/:chatId',
    cases: [
      {
        check: 'authorizeChat',
        intent: 'write',
        expect: statuses(204, 404, 404, 204, 404),
        declared: CHAT_SUITES
      }
    ]
  },
  {
    route: 'GET /api/chats/:chatId/artifacts',
    cases: [{ check: 'authorizeChat', intent: 'read', expect: CHAT_READ, declared: CHAT_SUITES }]
  },
  {
    route: 'POST /api/chats/:chatId/artifacts/zip',
    cases: [{ check: 'authorizeChat', intent: 'read', expect: CHAT_READ, declared: CHAT_SUITES }]
  },
  {
    route: 'GET /api/chats/:chatId/artifacts/:artifactId',
    cases: [{ check: 'authorizeChat', intent: 'read', expect: CHAT_READ, declared: CHAT_SUITES }]
  },
  {
    route: 'GET /api/chats/:chatId/artifacts/:artifactId/provenance',
    cases: [{ check: 'authorizeChat', intent: 'read', expect: CHAT_READ, declared: CHAT_SUITES }]
  },
  {
    route: 'GET /api/chats/:chatId/evidence/:messageId',
    cases: [
      {
        check: 'authorizeChat, owner only',
        intent: 'read',
        expect: CHAT_OWNER_READ,
        declared: 'server/tests/chat-evidence-routes.test.js'
      }
    ]
  },
  {
    route: 'GET /api/chats/:chatId/evidence/:messageId/content/:sha256',
    cases: [
      {
        check: 'authorizeChat, owner only',
        intent: 'read',
        expect: CHAT_OWNER_READ,
        declared: 'server/tests/chat-evidence-routes.test.js'
      }
    ]
  },
  {
    route: 'GET /api/chats/:chatId/files',
    cases: [{ check: 'authorizeChat', intent: 'read', expect: CHAT_READ, declared: CHAT_SUITES }]
  },
  {
    route: 'POST /api/chats/:chatId/files',
    cases: [
      {
        check: 'authorizeChat',
        intent: 'write',
        expect: statuses(201, 404, 404, 201, 404),
        declared: 'server/tests/chat-files.test.js'
      }
    ]
  },
  {
    route: 'GET /api/chats/:chatId/files/:fileId',
    cases: [
      {
        check: 'authorizeChat',
        intent: 'read',
        expect: CHAT_READ,
        declared: 'server/tests/chat-files.test.js'
      }
    ]
  },
  {
    route: 'DELETE /api/chats/:chatId/files/:fileId',
    cases: [
      {
        check: 'authorizeChat',
        intent: 'write',
        expect: statuses(204, 404, 404, 204, 404),
        declared: 'server/tests/chat-files.test.js'
      }
    ]
  },
  {
    route: 'GET /api/chats/:chatId/shares',
    cases: [
      {
        check: 'authenticatedOnly, authorizeChat',
        intent: 'write',
        expect: statuses(200, 404, 404, 401, 401),
        declared: 'server/tests/chat-persistence-shares.test.js'
      }
    ]
  },
  {
    route: 'POST /api/chats/:chatId/shares',
    cases: [
      {
        check: 'authenticatedOnly, authorizeChat',
        intent: 'write',
        expect: statuses(201, 404, 404, 401, 401),
        declared: 'server/tests/chat-persistence-shares.test.js'
      }
    ]
  },
  {
    route: 'POST /api/chats/:chatId/artifacts/:artifactId/shares',
    cases: [
      {
        check: 'authenticatedOnly, authorizeChat',
        intent: 'write',
        expect: statuses(201, 404, 404, 401, 401),
        declared: 'server/tests/chat-persistence-shares.test.js'
      }
    ]
  }
]);
