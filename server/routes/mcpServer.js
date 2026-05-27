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
 * Sessions are stateful: an MCP `initialize` request receives a session id
 * that the client echoes back via `Mcp-Session-Id` on subsequent requests.
 * Stateful sessions keep the in-memory `McpServer` registry alive across
 * requests so tool callbacks stay bound to the same authenticated user.
 */

// Map<sessionId, { transport, server, userId }>
const sessions = new Map();

function gatewayEnabled() {
  const platform = configCache.getPlatform() || {};
  return platform.mcpServer?.enabled === true;
}

function gatewayConfig() {
  return (configCache.getPlatform() || {}).mcpServer || {};
}

async function destroySession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  try {
    await s.server.close();
  } catch (err) {
    logger.warn('Error closing MCP gateway server', {
      component: 'McpGateway',
      sessionId,
      error: err.message
    });
  }
  sessions.delete(sessionId);
}

export default function registerMcpServerRoutes(app) {
  const enabledCheck = (req, res, next) => {
    if (!gatewayEnabled()) {
      return res
        .status(404)
        .json({ error: 'not_found', error_description: 'MCP gateway is not enabled' });
    }
    next();
  };

  // ---- Streamable HTTP transport ----------------------------------------
  const streamableHttpHandler = async (req, res) => {
    const cfg = gatewayConfig();
    if (cfg.transports?.streamableHttp?.enabled === false) {
      return res
        .status(404)
        .json({ error: 'not_found', error_description: 'Streamable HTTP transport disabled' });
    }

    const sessionId = req.headers['mcp-session-id'];
    let entry = sessionId ? sessions.get(sessionId) : null;

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
      const platform = configCache.getPlatform() || {};
      const server = await buildMcpServer({ user: req.user, platform });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID()
      });
      transport.onclose = () => {
        if (transport.sessionId) destroySession(transport.sessionId);
      };
      await server.connect(transport);
      // Session id is assigned after the first request the transport handles
      // (per MCP spec). We register into the map once the id is known.
      entry = { transport, server, userId: req.user.id };
    }

    try {
      await entry.transport.handleRequest(req, res, req.body);
      // Register the session after handleRequest so we have the assigned id.
      const id = entry.transport.sessionId;
      if (id && !sessions.has(id)) {
        sessions.set(id, entry);
      }
    } catch (err) {
      logger.error('MCP gateway streamable HTTP handler failed', {
        component: 'McpGateway',
        error: err.message,
        stack: err.stack
      });
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal_error', error_description: err.message });
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
    if (sessionId) await destroySession(sessionId);
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
      oauth_authorization_server: `${baseUrl}/.well-known/oauth-authorization-server`
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
