/**
 * Realtime speech-to-text WebSocket proxy.
 *
 * The browser opens a same-origin WebSocket to `/api/voice/realtime` and streams
 * raw PCM16 (16 kHz, mono) audio frames. This module authenticates the upgrade
 * (JWT `authToken` cookie, same logic as `authRequired`), then opens an upstream
 * WebSocket to a vLLM realtime endpoint (e.g. Voxtral on `/v1/realtime`) and
 * relays audio up / transcription text down. The vLLM URL and optional API key
 * stay server-side (`platform.speech.realtime`); the browser never talks to vLLM
 * directly.
 *
 * Browser <-> iHub protocol (iHub-defined, we own both ends):
 *   client -> server: JSON `{type:'start', lang?}`, then binary PCM16 frames,
 *                     then JSON `{type:'stop'}`
 *   server -> client: JSON `{type:'ready'}` once upstream is connected,
 *                     `{type:'delta', text}` (streaming), `{type:'final', text}`,
 *                     `{type:'error', message}`
 *
 * iHub <-> vLLM protocol (vLLM realtime API):
 *   see https://docs.vllm.ai/ — session.created / session.update /
 *   input_audio_buffer.append|commit / transcription.delta|done / error
 */
import { WebSocketServer, WebSocket } from 'ws';
import configCache from '../configCache.js';
import logger from '../utils/logger.js';
import { verifyJwt } from '../utils/tokenService.js';
import { isAnonymousAccessAllowed } from '../utils/authorization.js';
import { buildApiPath } from '../utils/basePath.js';

// Close cleanly if the browser stops sending audio and no transcription is
// flowing. Keeps orphaned upstream sockets from lingering.
const IDLE_TIMEOUT_MS = 60_000;

/**
 * Strip a trailing slash / path from an origin so comparison is scheme+host(+port),
 * the form a browser sends in the Origin header.
 */
function normalizeOrigin(origin) {
  if (typeof origin !== 'string') return origin;
  const trimmed = origin.trim();
  const schemeEnd = trimmed.indexOf('://');
  if (schemeEnd === -1) return trimmed.replace(/\/+$/, '');
  const pathStart = trimmed.indexOf('/', schemeEnd + 3);
  return pathStart === -1 ? trimmed : trimmed.slice(0, pathStart);
}

/**
 * Resolve the configured CORS origins from platform config, expanding
 * ${ENV_VAR} placeholders and comma-separated lists (same rules as the HTTP
 * CORS middleware).
 */
function resolveConfiguredOrigins(platform) {
  const raw = platform?.cors?.origin;
  const out = [];
  const pushResolved = val => {
    if (typeof val !== 'string') return;
    if (val.includes('${')) {
      const replaced = val.replace(/\$\{([^}]+)\}/g, (_m, envVar) => process.env[envVar] || '');
      replaced
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .forEach(o => out.push(o));
    } else if (val) {
      out.push(val);
    }
  };
  if (Array.isArray(raw)) raw.forEach(pushResolved);
  else pushResolved(raw);
  return out;
}

/**
 * Guard against Cross-Site WebSocket Hijacking. The upgrade is authenticated via
 * the `authToken` cookie, which browsers attach on cross-origin WS handshakes
 * too — so we must reject browser connections whose Origin isn't same-origin or
 * in the CORS allowlist. Non-browser clients omit Origin; they can't be a CSWSH
 * victim (same-origin policy is a browser concept), so a missing Origin is
 * allowed.
 */
function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser caller — not a CSWSH vector

  const normalized = normalizeOrigin(origin);
  // Same-origin: the browser tab was served by this iHub instance. Check both
  // the direct Host and the forwarded host, so this works behind a reverse
  // proxy (production nginx) and the Vite dev proxy, where `Host` is the
  // internal target but `X-Forwarded-Host` carries the browser-facing host.
  const forwardedHost = (req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const hosts = [req.headers.host, forwardedHost].filter(Boolean);
  for (const host of hosts) {
    if (normalized === `http://${host}` || normalized === `https://${host}`) {
      return true;
    }
  }

  const configured = resolveConfiguredOrigins(configCache.getPlatform() || {}).map(normalizeOrigin);
  if (configured.includes('*')) return true;
  return configured.includes(normalized);
}

/**
 * Extract the authToken from a raw upgrade request (Bearer header or cookie).
 * The upgrade request never went through Express, so cookies aren't parsed.
 */
function extractToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const entry = cookieHeader
      .split(';')
      .map(c => c.trim())
      .find(c => c.startsWith('authToken='));
    if (entry) {
      try {
        return decodeURIComponent(entry.substring('authToken='.length));
      } catch {
        return entry.substring('authToken='.length);
      }
    }
  }
  return null;
}

/**
 * Authenticate an upgrade request. Returns a minimal user object, or null when
 * authentication is required but missing/invalid.
 */
function authenticateUpgrade(req) {
  const platform = configCache.getPlatform() || {};
  const token = extractToken(req);

  if (token) {
    const decoded = verifyJwt(token);
    if (decoded) {
      return {
        id: decoded.sub || decoded.username || decoded.id || 'user',
        name: decoded.name || decoded.username || 'user'
      };
    }
  }

  // No valid token — allow only if anonymous access is enabled platform-wide.
  if (isAnonymousAccessAllowed(platform)) {
    return { id: 'anonymous', name: 'anonymous' };
  }
  return null;
}

/**
 * Get the realtime speech config from the platform config, or null if disabled.
 */
function getRealtimeConfig() {
  const platform = configCache.getPlatform() || {};
  const cfg = platform.speech?.realtime;
  if (!cfg || cfg.enabled === false || !cfg.url) return null;
  return cfg;
}

function sendJson(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

/**
 * Bridge a single accepted browser connection to a fresh upstream vLLM socket.
 */
function bridgeConnection(clientWs, user) {
  const cfg = getRealtimeConfig();
  if (!cfg) {
    sendJson(clientWs, { type: 'error', message: 'Realtime transcription is not configured' });
    clientWs.close();
    return;
  }

  const headers = {};
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  let upstream;
  try {
    upstream = new WebSocket(cfg.url, { headers });
  } catch (err) {
    logger.error('Realtime STT: failed to open upstream socket', {
      component: 'RealtimeSTT',
      error: err.message
    });
    sendJson(clientWs, { type: 'error', message: 'Failed to reach transcription service' });
    clientWs.close();
    return;
  }

  let upstreamReady = false; // handshake complete, audio may flow
  let idleTimer = null;

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.info('Realtime STT: idle timeout, closing', { component: 'RealtimeSTT' });
      cleanup();
    }, IDLE_TIMEOUT_MS);
  };

  const cleanup = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (upstream && upstream.readyState <= WebSocket.OPEN) {
      try {
        upstream.close();
      } catch {
        /* ignore */
      }
    }
    if (clientWs.readyState <= WebSocket.OPEN) {
      try {
        clientWs.close();
      } catch {
        /* ignore */
      }
    }
  };

  // --- Upstream (vLLM) -> iHub ---
  upstream.on('open', () => {
    // Handshake: identify the model, then open the audio buffer.
    sendJson(upstream, { type: 'session.update', model: cfg.model });
    sendJson(upstream, { type: 'input_audio_buffer.commit' });
    upstreamReady = true;
    sendJson(clientWs, { type: 'ready' });
    resetIdle();
  });

  upstream.on('message', data => {
    resetIdle();
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // vLLM realtime frames are JSON; ignore anything else
    }
    switch (msg.type) {
      case 'transcription.delta':
        sendJson(clientWs, { type: 'delta', text: msg.delta || '' });
        break;
      case 'transcription.done':
        sendJson(clientWs, { type: 'final', text: msg.text || '' });
        break;
      case 'error':
        sendJson(clientWs, { type: 'error', message: msg.error || 'Transcription error' });
        break;
      // session.created and other control frames need no client action
      default:
        break;
    }
  });

  upstream.on('error', err => {
    logger.warn('Realtime STT: upstream error', { component: 'RealtimeSTT', error: err.message });
    sendJson(clientWs, { type: 'error', message: 'Transcription service error' });
    cleanup();
  });

  upstream.on('close', () => {
    cleanup();
  });

  // --- iHub <- browser ---
  clientWs.on('message', (data, isBinary) => {
    resetIdle();
    if (isBinary) {
      // Raw PCM16 frame — base64-wrap into the vLLM realtime protocol.
      if (upstreamReady && upstream.readyState === WebSocket.OPEN) {
        const audio = Buffer.from(data).toString('base64');
        sendJson(upstream, { type: 'input_audio_buffer.append', audio });
      }
      return;
    }
    // Text control frame from the browser.
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === 'stop') {
      if (upstreamReady && upstream.readyState === WebSocket.OPEN) {
        sendJson(upstream, { type: 'input_audio_buffer.commit', final: true });
      }
    }
    // {type:'start'} carries optional lang; the model auto-detects language, so
    // no upstream action is needed today. Reserved for future use.
  });

  clientWs.on('error', err => {
    logger.warn('Realtime STT: client error', { component: 'RealtimeSTT', error: err.message });
    cleanup();
  });

  clientWs.on('close', () => {
    cleanup();
  });

  resetIdle();
  logger.info('Realtime STT: bridge established', {
    component: 'RealtimeSTT',
    userId: user.id
  });
}

/**
 * Attach the realtime transcription WebSocket handler to an HTTP(S) server.
 * Safe to call in both single-process and sticky-cluster worker modes — WS
 * upgrades ride the same TCP connection the primary hands to the worker, so no
 * extra clustering coordination is required.
 *
 * @param {import('http').Server|import('https').Server} httpServer
 */
export function attachRealtimeTranscription(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return; // malformed URL — let other handlers/ default behavior deal with it
    }

    // Only handle our endpoint; ignore everything else so other upgrade
    // listeners (if any) keep working.
    if (pathname !== buildApiPath('/voice/realtime')) {
      return;
    }

    // Reject cross-origin browser handshakes (Cross-Site WebSocket Hijacking).
    if (!isAllowedOrigin(req)) {
      logger.warn('Realtime STT: rejected upgrade from disallowed origin', {
        component: 'RealtimeSTT',
        origin: req.headers.origin
      });
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const user = authenticateUpgrade(req);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!getRealtimeConfig()) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, ws => {
      bridgeConnection(ws, user);
    });
  });

  logger.info('Realtime transcription WebSocket handler attached', {
    component: 'RealtimeSTT',
    path: buildApiPath('/voice/realtime')
  });
}

/**
 * Test connectivity to a vLLM realtime endpoint without streaming audio.
 * Opens a WebSocket, performs the session handshake, and reports whether the
 * endpoint is reachable and speaks the realtime protocol. Used by the admin
 * "Test connection" button.
 *
 * @param {{url?: string, model?: string, apiKey?: string}} cfg
 * @param {number} [timeoutMs=8000]
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export function testRealtimeConnection(cfg = {}, timeoutMs = 8000) {
  return new Promise(resolve => {
    const url = (cfg.url || '').trim();
    if (!/^wss?:\/\//i.test(url)) {
      resolve({ ok: false, message: 'URL must start with ws:// or wss://' });
      return;
    }

    let settled = false;
    let opened = false;
    let ws;

    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ws && ws.readyState <= WebSocket.OPEN) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish(
        opened
          ? { ok: true, message: 'Connected (handshake sent; no session frame received in time)' }
          : { ok: false, message: `Connection timed out after ${timeoutMs}ms` }
      );
    }, timeoutMs);

    try {
      const headers = {};
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
      ws = new WebSocket(url, { headers });
    } catch (err) {
      finish({ ok: false, message: `Failed to open socket: ${err.message}` });
      return;
    }

    ws.on('open', () => {
      opened = true;
      sendJson(ws, { type: 'session.update', model: cfg.model });
    });

    ws.on('message', data => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        // Any parseable-or-not frame means the endpoint responded.
        finish({ ok: true, message: 'Connected — endpoint responded' });
        return;
      }
      if (msg.type === 'error') {
        finish({ ok: false, message: `Endpoint error: ${msg.error || 'unknown'}` });
      } else {
        // session.created / transcription.* / any control frame = healthy.
        finish({ ok: true, message: `Connected — received "${msg.type}"` });
      }
    });

    ws.on('error', err => {
      finish({ ok: false, message: `Connection failed: ${err.message}` });
    });

    ws.on('close', () => {
      if (!opened) finish({ ok: false, message: 'Connection closed before handshake' });
    });
  });
}

export default attachRealtimeTranscription;
