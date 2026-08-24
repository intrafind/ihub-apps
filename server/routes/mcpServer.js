import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { randomUUID } from 'crypto';
import express from 'express';
import mcpAuth from '../middleware/mcpAuth.js';
import { buildMcpServer } from '../services/mcp/McpServerService.js';
import { dispatchA2A } from '../services/mcp/a2aHandler.js';
import configCache from '../configCache.js';
import { buildServerPath } from '../utils/basePath.js';
import logger from '../utils/logger.js';

/**
 * Mounts the iHub-as-MCP-server gateway endpoints:
 *
 *   POST /mcp           — Streamable HTTP (canonical, MCP 2025-03-26+)
 *   GET  /mcp           — Streamable HTTP GET (SSE upgrade)
 *   DELETE /mcp         — Streamable HTTP session termination
 *   GET  /mcp/sse       — Legacy SSE transport (back-compat)
 *   POST /mcp/messages  — Legacy SSE client→server messages
 *
 * Sessions are stateful by default: an MCP `initialize` request receives a
 * session id that the client echoes back via `Mcp-Session-Id` on subsequent
 * requests. Stateful sessions keep the in-memory `McpServer` registry alive
 * across requests so tool callbacks stay bound to the same authenticated user.
 *
 * Because that registry lives in the worker's process memory, stateful mode
 * needs the client to keep landing on the same worker/replica (the sticky
 * cluster router in `clusterSticky.js` handles the multi-worker case). Behind a
 * load balancer that fans out across pods, set
 * `platform.mcpServer.transports.streamableHttp.stateless = true` — every
 * request then builds its own short-lived transport and no session id is
 * issued, so no affinity is required.
 */

// Map<sessionId, { transport, server, userId, lastSeen }>
const sessions = new Map();

// Sessions are dropped after this much inactivity. MCP clients hold a session
// for the lifetime of their connection, so the window is generous; the sweep
// exists so abandoned sessions (client killed, network dropped without a
// DELETE) cannot pile up McpServer instances for the life of the process.
const SESSION_IDLE_TTL_MS = 60 * 60 * 1000;
const SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

function gatewayEnabled() {
  const platform = configCache.getPlatform() || {};
  return platform.mcpServer?.enabled === true;
}

function gatewayConfig() {
  return (configCache.getPlatform() || {}).mcpServer || {};
}

async function closeServer(server, sessionId) {
  try {
    await server.close();
  } catch (err) {
    logger.warn('Error closing MCP gateway server', {
      component: 'McpGateway',
      sessionId,
      error: err.message
    });
  }
}

async function destroySession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  // Delete first: closing the transport fires onclose, which calls back into
  // destroySession. Removing the entry up front makes that re-entry a no-op.
  sessions.delete(sessionId);
  await closeServer(s.server, sessionId);
}

/**
 * Drop sessions whose client has gone away without sending DELETE.
 */
function sweepIdleSessions() {
  const cutoff = Date.now() - SESSION_IDLE_TTL_MS;
  for (const [sessionId, entry] of sessions) {
    if (entry.lastSeen > cutoff) continue;
    logger.info('Expiring idle MCP session', {
      component: 'McpGateway',
      sessionId,
      idleMs: Date.now() - entry.lastSeen
    });
    destroySession(sessionId).catch(() => {});
  }
}

/**
 * Reply with a JSON-RPC error envelope at a specific HTTP status.
 * Matches the shape the MCP SDK's own transport-level errors use so clients
 * parse gateway-level rejections the same way.
 */
function sendRpcError(res, status, code, message, headers = {}) {
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
  return res.status(status).json({
    jsonrpc: '2.0',
    error: { code, message },
    id: null
  });
}

/**
 * Log a gateway-level rejection with everything needed to tell the causes
 * apart from the server side.
 *
 * `405` and `400` here are routinely reported as "the MCP gateway does not
 * work", and the three causes look identical to the client:
 *   - a compliant streamable-HTTP client probing for the optional
 *     server→client SSE stream (harmless — the MCP SDK treats 405 on GET as
 *     "this server has no push channel" and carries on),
 *   - a client configured for the legacy SSE transport but pointed at `/mcp`
 *     instead of `/mcp/sse` (it needs a GET stream and cannot recover), or
 *   - a reverse proxy dropping the `Mcp-Session-Id` header, so a client that
 *     did initialize correctly never gets to use its session.
 *
 * `hadSessionHeader` is the discriminator: false on a GET right after a
 * successful initialize means the header is being stripped in transit.
 */
function logGatewayRejection(req, { status, reason }) {
  logger.info('MCP gateway rejected request', {
    component: 'McpGateway',
    status,
    reason,
    method: req.method,
    userId: req.user?.id,
    hadSessionHeader: Boolean(req.headers['mcp-session-id']),
    accept: req.headers.accept || null,
    protocolVersion: req.headers['mcp-protocol-version'] || null,
    userAgent: req.headers['user-agent'] || null
  });
}

/**
 * True when the (already parsed) POST body is an MCP `initialize` request —
 * the only message allowed to open a new session.
 */
function isInitializeRequestBody(body) {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some(msg => msg && typeof msg === 'object' && msg.method === 'initialize');
}

export default function registerMcpServerRoutes(app) {
  // unref() so the sweep timer never keeps the process alive on shutdown.
  setInterval(sweepIdleSessions, SESSION_SWEEP_INTERVAL_MS).unref();

  const enabledCheck = (req, res, next) => {
    if (!gatewayEnabled()) {
      return res
        .status(404)
        .json({ error: 'not_found', error_description: 'MCP gateway is not enabled' });
    }
    next();
  };

  // ---- Streamable HTTP transport ----------------------------------------

  /**
   * Build a transport + per-user McpServer pair. In stateful mode the session
   * is registered from the SDK's `onsessioninitialized` callback, which fires
   * while the initialize request is still being handled — registering after
   * `handleRequest()` resolves would leave a window in which the client has
   * already received its session id but the gateway has not stored it yet, and
   * the client's very next request would be rejected as unknown.
   */
  async function createTransport(req, { stateless }) {
    const platform = configCache.getPlatform() || {};
    const server = await buildMcpServer({ user: req.user, platform });
    const entry = { transport: null, server, userId: req.user.id, lastSeen: Date.now() };

    const transport = new StreamableHTTPServerTransport({
      // `undefined` puts the SDK transport in stateless mode: no session id is
      // issued and no session validation is performed.
      sessionIdGenerator: stateless ? undefined : () => randomUUID(),
      ...(stateless
        ? {}
        : {
            onsessioninitialized: id => {
              entry.lastSeen = Date.now();
              sessions.set(id, entry);
              logger.debug('MCP session opened', {
                component: 'McpGateway',
                sessionId: id,
                userId: req.user.id
              });
            }
          })
    });

    // Without this, transport-level rejections (bad Accept header, unsupported
    // protocol version, malformed JSON-RPC) are returned to the client but
    // never logged, which makes a failing client impossible to diagnose from
    // the server side.
    transport.onerror = err => {
      logger.warn('MCP gateway transport rejected request', {
        component: 'McpGateway',
        userId: req.user?.id,
        method: req.method,
        sessionId: req.headers['mcp-session-id'] || null,
        error: err?.message
      });
    };
    if (!stateless) {
      transport.onclose = () => {
        if (transport.sessionId) destroySession(transport.sessionId);
      };
    }

    try {
      await server.connect(transport);
    } catch (err) {
      // The server is fully built by this point; if wiring the transport to it
      // fails there is nothing left holding a reference, so release it here
      // rather than leaving it to accumulate behind the caller's 500.
      await closeServer(server, null);
      throw err;
    }
    entry.transport = transport;
    return entry;
  }

  const streamableHttpHandler = async (req, res) => {
    const cfg = gatewayConfig();
    if (cfg.transports?.streamableHttp?.enabled === false) {
      return res
        .status(404)
        .json({ error: 'not_found', error_description: 'Streamable HTTP transport disabled' });
    }

    const stateless = cfg.transports?.streamableHttp?.stateless === true;
    const sessionId = req.headers['mcp-session-id'];

    if (stateless) {
      // One transport per request: nothing is kept in process memory, so the
      // gateway works behind a load balancer without session affinity.
      let entry;
      try {
        entry = await createTransport(req, { stateless: true });
      } catch (err) {
        logger.error('MCP gateway failed to build stateless server', {
          component: 'McpGateway',
          error: err.message
        });
        return sendRpcError(res, 500, -32603, 'Failed to initialise MCP server');
      }
      if (req.method === 'GET') {
        // The standalone server→client SSE stream needs a session to belong
        // to. Declining it with 405 is explicitly allowed by the spec and MCP
        // clients treat it as "this server has no push channel".
        await closeServer(entry.server, null);
        logGatewayRejection(req, { status: 405, reason: 'stateless_mode_no_sse_stream' });
        return sendRpcError(
          res,
          405,
          -32000,
          'Method Not Allowed: this gateway runs in stateless mode and offers no server-initiated SSE stream',
          { Allow: 'POST, DELETE' }
        );
      }
      try {
        await entry.transport.handleRequest(req, res, req.body);
      } catch (err) {
        logger.error('MCP gateway streamable HTTP handler failed', {
          component: 'McpGateway',
          error: err.message,
          stack: err.stack
        });
        if (!res.headersSent) {
          res.status(500).json({ error: 'internal_error', error_description: err.message });
        }
      } finally {
        await closeServer(entry.server, null);
      }
      return;
    }

    let entry = sessionId ? sessions.get(sessionId) : null;
    let isNewSession = false;

    if (sessionId && !entry) {
      // Unknown session: expired, terminated, or opened on another worker /
      // replica. The spec requires 404 here so the client knows to start a new
      // session with a fresh `initialize`. Handing the request to a brand-new
      // transport instead (as this used to) makes the SDK answer
      // 400 "Server not initialized", which clients treat as a fatal protocol
      // error — the connection never recovers.
      logger.info('MCP session not found — asking client to re-initialize', {
        component: 'McpGateway',
        sessionId,
        userId: req.user.id,
        method: req.method
      });
      return sendRpcError(res, 404, -32001, 'Session not found');
    }

    // Bind transport to authenticated user. Re-authenticating on every request
    // (rather than only at initialize) ensures token revocation takes effect
    // immediately.
    if (entry && entry.userId !== req.user.id) {
      // Session belongs to another user — refuse rather than leak resources.
      logger.warn('MCP session userId mismatch — rejecting', {
        component: 'McpGateway',
        sessionId,
        tokenUser: req.user.id,
        sessionUser: entry.userId
      });
      return res
        .status(403)
        .json({ error: 'forbidden', error_description: 'Session belongs to a different user' });
    }

    if (!entry) {
      // No session id at all. Only `initialize` may open one; anything else
      // gets a targeted error instead of an McpServer that would be built,
      // rejected by the SDK and then leaked.
      if (req.method === 'GET') {
        logGatewayRejection(req, { status: 405, reason: 'get_stream_without_session' });
        return sendRpcError(
          res,
          405,
          -32000,
          `Method Not Allowed: open a session with an initialize request before requesting the SSE stream. Legacy SSE clients must connect to ${buildServerPath('/mcp/sse')} instead.`,
          { Allow: 'POST, DELETE' }
        );
      }
      if (!isInitializeRequestBody(req.body)) {
        logGatewayRejection(req, { status: 400, reason: 'post_without_session' });
        return sendRpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header is required');
      }
      try {
        entry = await createTransport(req, { stateless: false });
        isNewSession = true;
      } catch (err) {
        logger.error('MCP gateway failed to build server', {
          component: 'McpGateway',
          error: err.message
        });
        return sendRpcError(res, 500, -32603, 'Failed to initialise MCP server');
      }
    }

    entry.lastSeen = Date.now();

    try {
      await entry.transport.handleRequest(req, res, req.body);
      entry.lastSeen = Date.now();
    } catch (err) {
      logger.error('MCP gateway streamable HTTP handler failed', {
        component: 'McpGateway',
        error: err.message,
        stack: err.stack
      });
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal_error', error_description: err.message });
      }
    } finally {
      // The transport only registers the session once it has accepted an
      // initialize request. If it rejected the request instead (bad Accept
      // header, malformed JSON-RPC, …) the server we just built is orphaned —
      // release it rather than leaving it for the GC-less sessions map.
      const assignedId = entry.transport.sessionId;
      if (isNewSession && (!assignedId || !sessions.has(assignedId))) {
        await closeServer(entry.server, assignedId || null);
      }
    }
  };

  // Use express.json() locally so the streamable transport gets a parsed body.
  // We deliberately do not rely on the global json parser since some MCP
  // payloads can exceed the default 100kb limit.
  const jsonBody = express.json({ limit: '4mb' });

  app.post(buildServerPath('/mcp'), enabledCheck, jsonBody, mcpAuth, streamableHttpHandler);
  app.get(buildServerPath('/mcp'), enabledCheck, mcpAuth, streamableHttpHandler);
  app.delete(buildServerPath('/mcp'), enabledCheck, mcpAuth, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    const entry = sessionId ? sessions.get(sessionId) : null;
    // Termination is idempotent: an already-gone session is still "terminated".
    if (entry) {
      if (entry.userId !== req.user.id) {
        logger.warn('MCP session termination refused — session belongs to another user', {
          component: 'McpGateway',
          sessionId,
          tokenUser: req.user.id,
          sessionUser: entry.userId
        });
        return res
          .status(403)
          .json({ error: 'forbidden', error_description: 'Session belongs to a different user' });
      }
      await destroySession(sessionId);
    }
    res.status(204).end();
  });

  // ---- Legacy SSE transport ---------------------------------------------
  // Older MCP clients still use the SSE transport. Keep a thin compat layer.
  const sseSessions = new Map(); // sessionId -> { server, transport }

  app.get(buildServerPath('/mcp/sse'), enabledCheck, mcpAuth, async (req, res) => {
    const cfg = gatewayConfig();
    if (cfg.transports?.sse?.enabled === false) {
      return res
        .status(404)
        .json({ error: 'not_found', error_description: 'SSE transport disabled' });
    }
    try {
      const platform = configCache.getPlatform() || {};
      const server = await buildMcpServer({ user: req.user, platform });
      const transport = new SSEServerTransport(buildServerPath('/mcp/messages'), res);
      await server.connect(transport);
      const sessionId = transport.sessionId;
      sseSessions.set(sessionId, { server, transport, userId: req.user.id });
      transport.onclose = () => {
        sseSessions.delete(sessionId);
        server.close().catch(() => {});
      };
    } catch (err) {
      logger.error('MCP gateway SSE handler failed', {
        component: 'McpGateway',
        error: err.message,
        stack: err.stack
      });
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal_error', error_description: err.message });
      }
    }
  });

  app.post(buildServerPath('/mcp/messages'), enabledCheck, jsonBody, mcpAuth, async (req, res) => {
    const sessionId = req.query.sessionId;
    const entry = sessionId ? sseSessions.get(sessionId) : null;
    if (!entry) {
      return res
        .status(404)
        .json({ error: 'not_found', error_description: 'No active SSE session' });
    }
    if (entry.userId !== req.user.id) {
      return res
        .status(403)
        .json({ error: 'forbidden', error_description: 'Session belongs to a different user' });
    }
    try {
      await entry.transport.handlePostMessage(req, res, req.body);
    } catch (err) {
      logger.error('MCP gateway SSE message handler failed', {
        component: 'McpGateway',
        error: err.message
      });
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal_error', error_description: err.message });
      }
    }
  });

  // ---- Public discovery -------------------------------------------------
  // Unauthenticated metadata endpoint; safe to expose.
  app.get(buildServerPath('/mcp/.well-known'), enabledCheck, (req, res) => {
    const cfg = gatewayConfig();
    const oauthCfg = (configCache.getPlatform() || {}).oauth || {};
    let baseUrl =
      cfg.publicUrl ||
      `${req.protocol || (req.secure ? 'https' : 'http')}://${req.get('host')}${buildServerPath('')}`;
    // Linear trailing-slash trim (the Host header is user-controlled; a regex
    // like /\/+$/ is polynomial under CodeQL's ReDoS rule even though it's
    // anchored — string ops sidestep that entirely).
    while (baseUrl.length > 0 && baseUrl.charCodeAt(baseUrl.length - 1) === 47) {
      baseUrl = baseUrl.slice(0, -1);
    }
    const a2aEnabled = cfg.a2a?.enabled === true;
    // Only advertise transports the operator has actually enabled so clients
    // don't pick a disabled one.
    const streamableHttpEnabled = cfg.transports?.streamableHttp?.enabled !== false;
    const sseEnabled = cfg.transports?.sse?.enabled !== false;
    const transports = [];
    if (streamableHttpEnabled) transports.push('streamableHttp');
    if (sseEnabled) transports.push('sse');
    if (a2aEnabled) transports.push('a2a');

    const allScopes = [
      'mcp:tools:read',
      'mcp:tools:call',
      'mcp:apps:invoke',
      'mcp:workflows:run',
      'mcp:resources:read'
    ];

    res.json({
      issuer: baseUrl,
      mcp_endpoint: streamableHttpEnabled ? `${baseUrl}/mcp` : null,
      mcp_sse_endpoint: sseEnabled ? `${baseUrl}/mcp/sse` : null,
      a2a_endpoint: a2aEnabled ? `${baseUrl}/a2a` : null,
      transports,
      scopes_supported: allScopes,
      // Recommended scopes an MCP-aware client should request by default
      // (admin-configurable via platform.mcpServer.defaultScopes).
      default_scopes: Array.isArray(cfg.defaultScopes)
        ? cfg.defaultScopes
        : ['mcp:tools:read', 'mcp:tools:call'],
      oauth_authorization_server: `${baseUrl}/.well-known/oauth-authorization-server`,
      oauth_protected_resource: `${baseUrl}/.well-known/oauth-protected-resource`,
      // Advertised only when /api/oauth/register would actually accept a
      // registration — it hard-404s unless DCR and the authorization server
      // are both enabled.
      ...(oauthCfg?.dcr?.enabled && oauthCfg?.enabled?.authz
        ? { registration_endpoint: `${baseUrl}/api/oauth/register` }
        : {})
    });
  });

  // ---- A2A endpoint (experimental) --------------------------------------
  // The A2A wire protocol is still v0.x; this scaffold implements the
  // well-defined subset (agent/info, agent/skills, tasks/send) and uses
  // the same OAuth Bearer + mcp:* scope gate as /mcp. Stateful tasks
  // (tasks/get, tasks/cancel, sendSubscribe) return method-not-found
  // until the spec stabilises.
  const a2aEnabledCheck = (req, res, next) => {
    const cfg = gatewayConfig();
    if (cfg.a2a?.enabled !== true) {
      return res
        .status(404)
        .json({ error: 'not_found', error_description: 'A2A endpoint is not enabled' });
    }
    return enabledCheck(req, res, next);
  };

  app.post(buildServerPath('/a2a'), a2aEnabledCheck, jsonBody, mcpAuth, async (req, res) => {
    const platform = configCache.getPlatform() || {};
    const body = req.body;
    try {
      if (Array.isArray(body)) {
        // JSON-RPC batch.
        const responses = await Promise.all(
          body.map(msg => dispatchA2A(msg, { user: req.user, platform }))
        );
        return res.json(responses);
      }
      const response = await dispatchA2A(body, { user: req.user, platform });
      return res.json(response);
    } catch (err) {
      logger.error('A2A endpoint error', { component: 'A2A', error: err.message });
      return res.status(500).json({
        jsonrpc: '2.0',
        id: body?.id ?? null,
        error: { code: -32603, message: err.message || 'internal error' }
      });
    }
  });
}
