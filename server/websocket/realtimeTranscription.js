/**
 * Realtime speech-to-text WebSocket proxy.
 *
 * The browser opens a same-origin WebSocket to `/api/voice/realtime` and streams
 * raw PCM16 (16 kHz, mono) audio frames. This module authenticates the upgrade
 * (JWT `authToken` cookie, same logic as `authRequired`), resolves which
 * speech-to-text backend to use, and relays audio up / transcription text down.
 * Upstream URLs and API keys stay server-side — the browser only ever sends a
 * model *id*, never an endpoint or a credential.
 *
 * Which upstream, and how to talk to it, comes from the transcription provider
 * registry (`server/transcription/index.js`); this module is provider-agnostic.
 * Two provider shapes are driven here:
 *   - `mode: 'stream'` — an upstream WebSocket (vLLM `/v1/realtime`, Gemini
 *     Live API). The provider supplies the frames to send and reads the frames
 *     that come back; this module supplies the socket and every guard below.
 *   - `mode: 'batch'` — a request/response API (Gemini batch transcription).
 *     No upstream socket: the audio is buffered here and handed to the provider
 *     in one call when the client sends `stop`.
 *
 * Resource guards (a transcription session pins a GPU-backed upstream socket):
 *   - The upstream socket opens LAZILY on the first audio frame, not on connect,
 *     so an idle/abandoned browser socket never pins an upstream session.
 *   - A short no-audio grace timeout closes sockets that connect but never speak.
 *   - Per-user and global concurrent-connection caps (ConnectionLimiter) bound
 *     the number of simultaneous upstream sessions one user (or the whole
 *     instance) can hold.
 *   - `maxPayload` caps the size of a single inbound audio frame.
 *   - A keepalive ping/pong loop detects dead clients (crashed tab, suspended
 *     laptop) and keeps reverse-proxy read timeouts from killing quiet sessions.
 *   - Upstream-leg backpressure: when the iHub->upstream socket's send buffer
 *     exceeds a high-water mark the client socket is paused (real TCP flow
 *     control), bounding per-connection memory instead of buffering the file.
 *   - Batch providers buffer audio in memory, so both a per-connection and a
 *     process-wide byte cap bound how much can be held at once.
 *   - A hard session-duration cap (platform.speech.realtime.maxSessionSeconds)
 *     bounds how LONG one connection can pin an upstream session.
 *
 * Browser <-> iHub protocol (iHub-defined, we own both ends):
 *   client -> server: JSON `{type:'start', modelId?, lang?}`, then binary PCM16
 *                     frames, then JSON `{type:'stop'}`
 *   server -> client: JSON `{type:'ready'}` once the backend is initialized,
 *                     `{type:'delta', text}` (streaming), `{type:'final', text}`
 *                     per completed segment, `{type:'done'}` once the transcript
 *                     is complete after `stop`, `{type:'error', message}`
 *   The same protocol serves both provider modes, so the client does not know
 *   or care whether its audio was streamed upstream or transcribed in one call.
 */
import { WebSocketServer, WebSocket } from 'ws';
import configCache from '../configCache.js';
import logger from '../utils/logger.js';
import { verifyJwt } from '../utils/tokenService.js';
import {
  isAnonymousAccessAllowed,
  getDefaultAnonymousGroups,
  enhanceUserWithPermissions
} from '../utils/authorization.js';
import { buildApiPath } from '../utils/basePath.js';
import { getTranscriptionProvider } from '../transcription/index.js';
import vllmRealtimeProvider from '../transcription/vllmRealtimeProvider.js';

// Close cleanly if the browser stops sending audio and no transcription is
// flowing. Keeps orphaned upstream sockets from lingering.
const IDLE_TIMEOUT_MS = 60_000;
// A connection that opens but never sends an audio frame is closed after this,
// so abandoned sockets don't sit holding a limiter slot.
const NO_AUDIO_GRACE_MS = 15_000;
// After the client sends `stop`, the upstream may emit several transcription
// segments (one per VAD utterance) before it goes quiet — a whole file blasted
// at once produces many. We consider transcription complete once the upstream
// has been quiet for this long following the last segment, rather than closing
// on the first post-stop segment (which truncates multi-segment transcripts).
const POST_STOP_SETTLE_MS = 2_500;
// WebSocket keepalive. Browsers cannot send protocol pings, and reverse proxies
// (nginx `proxy_read_timeout` defaults to 60s) kill WS connections that go
// quiet — e.g. while a busy upstream GPU processes a long tail after `stop`.
// The server pings the browser (which auto-pongs per RFC 6455) every interval;
// a client that misses a whole interval is considered dead and terminated. The
// upstream leg is pinged too, purely to generate traffic for intermediaries —
// its liveness is governed by its own close/error events and the idle timer.
const KEEPALIVE_INTERVAL_MS = 25_000;
// Backpressure on the upstream leg. The browser paces itself against ITS socket
// (`ws.bufferedAmount` toward iHub), but if iHub->vLLM is the slower hop the
// relayed frames would queue unbounded in the upstream socket's send buffer.
// When that buffer exceeds the high-water mark we pause the client socket
// (ws.pause() — real TCP backpressure the browser observes as its own
// bufferedAmount rising) and resume once the upstream drains.
const UPSTREAM_HIGH_WATER_BYTES = 4 * 1024 * 1024;
const UPSTREAM_RESUME_BYTES = 1 * 1024 * 1024;
const BACKPRESSURE_POLL_MS = 250;
// Hard ceiling on a single bridge session's lifetime, so a (possibly scripted)
// client streaming forever can't pin a GPU-backed upstream session
// indefinitely. Overridable via platform.speech.realtime.maxSessionSeconds.
const DEFAULT_MAX_SESSION_SECONDS = 3600;

// Defaults for the concurrent-connection caps. Overridable via
// platform.speech.realtime.{maxConnections,maxConnectionsPerUser}.
const DEFAULT_MAX_TOTAL_CONNECTIONS = 50;
const DEFAULT_MAX_CONNECTIONS_PER_USER = 3;
// Largest single inbound audio frame we accept. The browser sends ~4 KB PCM16
// frames; 256 KB is generous headroom while bounding per-frame memory.
const DEFAULT_MAX_FRAME_BYTES = 256 * 1024;
// Byte cap on audio buffered while the upstream socket is still connecting, so
// the pre-ready window can't be used to grow memory (a byte bound, not a frame
// bound — otherwise max-size frames would multiply it). 1 MB ≈ 32 s of PCM16
// dictation audio, far beyond any realistic handshake.
const MAX_PENDING_BYTES = 1024 * 1024;
// Batch providers have no upstream socket to stream into, so the whole
// recording is held in memory until `stop`. Two caps bound that: one per
// connection (≈17 min of 16 kHz PCM16) and one across the process, so the
// per-user/global connection caps can't be combined into an OOM. Both are
// overridable via platform.speech.realtime.{maxBufferedAudioBytes,
// maxBufferedAudioBytesTotal}.
const DEFAULT_MAX_BATCH_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_BATCH_BYTES_TOTAL = 256 * 1024 * 1024;

// Process-wide accounting for audio buffered by batch-mode connections.
let batchBytesInFlight = 0;

// Sample rate the browser resamples every source to before streaming
// (client/src/utils/realtimeTranscriptionCore.js). Only needed to describe the
// buffer to a batch provider and to log audio duration.
const TARGET_SAMPLE_RATE = 16000;

/**
 * Tracks concurrent bridge connections and enforces a per-user and a global cap
 * so no single user (and no single instance) can pin an unbounded number of
 * GPU-backed upstream transcription sessions.
 */
export class ConnectionLimiter {
  constructor({
    maxTotal = DEFAULT_MAX_TOTAL_CONNECTIONS,
    maxPerUser = DEFAULT_MAX_CONNECTIONS_PER_USER
  } = {}) {
    this.maxTotal = maxTotal;
    this.maxPerUser = maxPerUser;
    this.total = 0;
    this.perUser = new Map();
  }

  /** Reserve a slot for `userId`. Returns false (and reserves nothing) if a cap is hit. */
  tryAcquire(userId) {
    const used = this.perUser.get(userId) || 0;
    if (this.total >= this.maxTotal) return false;
    if (used >= this.maxPerUser) return false;
    this.total += 1;
    this.perUser.set(userId, used + 1);
    return true;
  }

  /** Free a previously-acquired slot. A release without a matching acquire is a no-op. */
  release(userId) {
    const used = this.perUser.get(userId) || 0;
    if (used <= 0) return;
    if (used === 1) this.perUser.delete(userId);
    else this.perUser.set(userId, used - 1);
    this.total = Math.max(0, this.total - 1);
  }
}

/**
 * Strip a trailing slash / path from an origin so comparison is scheme+host(+port),
 * the form a browser sends in the Origin header. Lowercased — scheme and host
 * are case-insensitive per RFC 3986, and a case mismatch must not reject a
 * legitimate same-origin handshake.
 */
export function normalizeOrigin(origin) {
  if (typeof origin !== 'string') return origin;
  const trimmed = origin.trim().toLowerCase();
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
export function isAllowedOrigin(req, platform = configCache.getPlatform() || {}) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser caller — not a CSWSH vector

  const normalized = normalizeOrigin(origin);
  // Same-origin: the browser tab was served by this iHub instance. Check both
  // the direct Host and the forwarded host, so this works behind a reverse
  // proxy (production nginx) and the Vite dev proxy, where `Host` is the
  // internal target but `X-Forwarded-Host` carries the browser-facing host.
  const forwardedHost = (req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const hosts = [req.headers.host, forwardedHost].filter(Boolean).map(h => h.toLowerCase());
  for (const host of hosts) {
    if (normalized === `http://${host}` || normalized === `https://${host}`) {
      return true;
    }
  }

  // Unlike HTTP CORS, a `*` wildcard is deliberately NOT honored here: this
  // socket is cookie-authenticated, and a wildcard would let any website drive
  // a visitor's browser into transcription sessions (CSWSH / resource abuse).
  // Cross-origin use requires explicitly listing the origin in cors.origin.
  const configured = resolveConfiguredOrigins(platform)
    .filter(o => o !== '*')
    .map(normalizeOrigin);
  return configured.includes(normalized);
}

/**
 * Extract the authToken from a raw upgrade request (Bearer header or cookie).
 * The upgrade request never went through Express, so cookies aren't parsed.
 */
export function extractToken(req) {
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
 * Authenticate an upgrade request. Returns a minimal user object (id, name and
 * the JWT `groups` claim), or null when authentication is required but
 * missing/invalid. `groups` is carried so the upgrade handler can compute the
 * user's model permissions via `enhanceUserWithPermissions` — needed to enforce
 * per-model access for transcription models.
 */
export function authenticateUpgrade(req, platform = configCache.getPlatform() || {}) {
  const token = extractToken(req);

  if (token) {
    const decoded = verifyJwt(token);
    if (decoded) {
      return {
        id: decoded.sub || decoded.username || decoded.id || 'user',
        name: decoded.name || decoded.username || 'user',
        groups: Array.isArray(decoded.groups) ? decoded.groups : []
      };
    }
  }

  // No valid token — allow only if anonymous access is enabled platform-wide.
  if (isAnonymousAccessAllowed(platform)) {
    return { id: 'anonymous', name: 'anonymous', groups: getDefaultAnonymousGroups(platform) };
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

/**
 * True when at least one enabled `transcription` model is configured. Used by
 * the upgrade-time availability pre-check so model-based transcription is
 * reachable even when the platform-wide dictation backend is disabled.
 */
export function hasEnabledTranscriptionModel() {
  const { data: models = [] } = configCache.getModels(); // enabled only
  return models.some(m => m?.modelType === 'transcription');
}

/**
 * Resolve the upstream connection for a transcription session.
 *
 * With a `modelId`, the model is looked up in the models cache, required to be
 * an enabled `transcription` model the user is permitted to use, and resolved
 * to concrete upstream details via the transcription provider registry. Without
 * a `modelId`, falls back to the platform-wide `platform.speech.realtime`
 * dictation backend (unchanged behavior).
 *
 * A raw upstream URL is NEVER accepted from the client — only a server-resolved
 * model id — so the upstream URL/API key never reach the browser.
 *
 * @param {{ modelId?: string, user?: Object }} params
 * @returns {Promise<{ ok: true, upstream: { url: string, apiKey: string, model: string },
 *   provider: Object } | { ok: false, code: string, error: string }>}
 */
export async function resolveTranscriptionUpstream({ modelId, user } = {}) {
  // No model id → platform-wide dictation backend (unchanged). The platform
  // dictation backend is a vLLM realtime endpoint, so it speaks that protocol.
  if (!modelId) {
    const cfg = getRealtimeConfig();
    if (!cfg) {
      return {
        ok: false,
        code: 'not-configured',
        error: 'Realtime transcription is not configured'
      };
    }
    return {
      ok: true,
      upstream: { url: cfg.url, apiKey: cfg.apiKey || '', model: cfg.model },
      provider: vllmRealtimeProvider
    };
  }

  const { data: models = [] } = configCache.getModels(true);
  const model = models.find(m => m.id === modelId);
  if (!model) {
    return { ok: false, code: 'unknown-model', error: `Unknown transcription model: ${modelId}` };
  }
  if (model.modelType !== 'transcription') {
    return {
      ok: false,
      code: 'not-transcription-model',
      error: `Model "${modelId}" is not a transcription model`
    };
  }
  if (model.enabled === false) {
    return {
      ok: false,
      code: 'model-disabled',
      error: `Transcription model "${modelId}" is disabled`
    };
  }

  // Enforce the same group-permission filtering chat models get. Fail CLOSED:
  // if permissions could not be computed (e.g. enhanceUserWithPermissions threw
  // at upgrade time), deny rather than granting an unpermitted model.
  const allowed = user?.permissions?.models;
  if (!allowed || !(allowed.has('*') || allowed.has(modelId))) {
    return {
      ok: false,
      code: 'not-permitted',
      error: `Not permitted to use transcription model: ${modelId}`
    };
  }

  const provider = getTranscriptionProvider(model.provider);
  if (!provider) {
    return {
      ok: false,
      code: 'unsupported-provider',
      error: `Unsupported transcription provider: ${model.provider}`
    };
  }

  const upstream = await provider.resolveUpstream(model);
  if (!upstream?.url) {
    return {
      ok: false,
      code: 'no-endpoint',
      error: `Transcription model "${modelId}" has no endpoint URL`
    };
  }
  return { ok: true, upstream, provider };
}

// --- Upstream error diagnostics (pure, unit-tested) ---

/**
 * Client-facing message for a socket-level upstream failure (ECONNREFUSED,
 * ETIMEDOUT, ENOTFOUND, TLS errors…). Only the bare error CODE is included:
 * Node embeds the upstream address in `err.message` (e.g. "connect ECONNREFUSED
 * 10.0.0.5:8000"), and the internal vLLM host must never reach the browser.
 * The full message goes to the server log instead.
 */
export function diagnoseSocketError(err = {}) {
  return `Transcription service unreachable: ${err.code || 'connection error'}`;
}

/**
 * Client-facing message when the upstream rejected the WS upgrade with an HTTP
 * response (404 wrong path, 401/403 auth, 502 bad gateway…).
 */
export function diagnoseUnexpectedResponse(res = {}) {
  return `Transcription service rejected the connection (HTTP ${res.statusCode} ${res.statusMessage || ''})`.trim();
}

/**
 * Client-facing message for an upstream close, or null when the close is
 * expected. A clean close (code 1000) is expected; so is a clean close after we
 * already delivered transcription. Report only genuinely-abnormal closes:
 * before the handshake completed, or a non-normal code with nothing transcribed.
 */
export function diagnoseUpstreamClose({ gotTranscription, upstreamReady, code, reason } = {}) {
  if (!gotTranscription && (!upstreamReady || code !== 1000)) {
    return `Transcription service closed the connection (code ${code}${reason ? `: ${reason}` : ''})`;
  }
  return null;
}

function sendJson(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

/**
 * Bridge a single accepted browser connection to a transcription backend. The
 * limiter slot has already been acquired by the caller; this function owns
 * releasing it exactly once on teardown.
 *
 * Upstream config is resolved lazily — on the `{type:'start'}` frame (which may
 * carry a `modelId`) or, for clients that skip `start`, on the first audio
 * frame. This lets unknown/forbidden/disabled-model errors be answered with an
 * `{type:'error'}` frame before any audio flows. For dictation (no modelId) the
 * upstream socket still opens lazily on the first audio frame, so an idle
 * browser socket never pins an upstream GPU session; for model-based
 * transcription the socket opens as soon as config resolves so the client can
 * wait for `{type:'ready'}` and stream a whole buffer with backpressure.
 *
 * Everything upstream-specific — what to dial, which frames to send, how to
 * read the frames that come back, or (for a batch provider) the single
 * transcription call — comes from the resolved provider. See
 * `server/transcription/index.js` for that contract.
 *
 * Terminology used here and in the docs: "transcription" is the feature,
 * "dictation" is the mic-to-input UX (no modelId), "realtime" is the transport.
 *
 * Exported for tests. `options.limiterKey` is the slot key (differs from
 * user.id for anonymous connections, which are keyed by client IP);
 * `options.createUpstream` injects the upstream socket factory so the state
 * machine is testable with fake sockets.
 */
export function bridgeConnection(clientWs, user, limiter, options = {}) {
  const { limiterKey = user.id, createUpstream = (url, opts) => new WebSocket(url, opts) } =
    options;
  let cfg = null; // resolved upstream { url, apiKey, model }; set on start/first-audio
  let provider = null; // resolved transcription provider (protocol / batch call)
  let resolvingCfg = false; // guard so upstream config is resolved at most once
  let upstream = null; // opened once config is resolved (streaming providers only)
  let upstreamReady = false; // handshake complete, audio may flow
  let gotTranscription = false; // at least one delta/final was received
  let stopRequested = false; // client sent {type:'stop'} — arm completion signal (G8)
  let firstAudioSeen = false; // first inbound audio frame observed
  let appendedFrames = 0; // audio frames relayed upstream (diagnostics)
  let errorSent = false; // guard so we report a failure at most once
  let released = false; // guard so we release the limiter slot at most once
  let idleTimer = null;
  let graceTimer = null;
  let postStopSettleTimer = null; // fires once the upstream goes quiet after `stop`
  let sessionInitTimer = null; // fallback when a provider has no ready signal
  let sessionInitDone = false; // guard so the upstream session is initialized once
  let keepaliveTimer = null; // periodic ping to the browser (and upstream)
  let clientAlive = true; // pong bookkeeping for the keepalive interval
  let sessionTimer = null; // hard cap on the whole session's lifetime
  let backpressureTimer = null; // polls upstream drain while the client is paused
  let clientPaused = false; // client socket paused due to upstream backpressure
  const pending = []; // raw PCM buffers captured before the backend is ready
  let pendingBytes = 0; // byte-bound on `pending` (see MAX_PENDING_BYTES)
  // Batch-provider state: the whole recording accumulates here until `stop`.
  const batchChunks = [];
  let batchBytes = 0; // bytes this connection has added to batchBytesInFlight
  let batchRunning = false; // a transcription request is in flight
  const abortController = new AbortController(); // cancels an in-flight request

  const isBatch = () => provider?.mode === 'batch';

  const releaseSlot = () => {
    if (released) return;
    released = true;
    limiter.release(limiterKey);
  };

  // Give back this connection's share of the process-wide batch byte budget.
  const releaseBatchBytes = () => {
    if (!batchBytes) return;
    batchBytesInFlight = Math.max(0, batchBytesInFlight - batchBytes);
    batchBytes = 0;
    batchChunks.length = 0;
  };

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
    if (graceTimer) clearTimeout(graceTimer);
    graceTimer = null;
    if (postStopSettleTimer) clearTimeout(postStopSettleTimer);
    postStopSettleTimer = null;
    if (sessionInitTimer) clearTimeout(sessionInitTimer);
    sessionInitTimer = null;
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    keepaliveTimer = null;
    if (sessionTimer) clearTimeout(sessionTimer);
    sessionTimer = null;
    if (backpressureTimer) clearInterval(backpressureTimer);
    backpressureTimer = null;
    // Cancel an in-flight batch request and free its buffered audio, so a
    // client that walks away doesn't leave a fetch (and 30 MB) hanging around.
    abortController.abort();
    releaseBatchBytes();
    if (clientPaused) {
      clientPaused = false;
      // Un-pause before closing so the close handshake can complete.
      try {
        if (typeof clientWs.resume === 'function') clientWs.resume();
      } catch {
        /* ignore */
      }
    }
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
    releaseSlot();
  };

  // Pause the client socket while the upstream send buffer is above the
  // high-water mark, and poll for drain. ws.pause() stops reading the underlying
  // TCP socket, so kernel flow control propagates to the browser: its own
  // `bufferedAmount` rises and its pacing loop stops queuing. Bounds this
  // bridge's memory to roughly UPSTREAM_HIGH_WATER_BYTES per connection instead
  // of the whole streamed file when the upstream is the slow hop.
  const applyUpstreamBackpressure = () => {
    if (clientPaused || !upstream || typeof clientWs.pause !== 'function') return;
    if (upstream.bufferedAmount <= UPSTREAM_HIGH_WATER_BYTES) return;
    clientPaused = true;
    try {
      clientWs.pause();
    } catch {
      clientPaused = false;
      return;
    }
    backpressureTimer = setInterval(() => {
      const drained =
        !upstream ||
        upstream.readyState !== WebSocket.OPEN ||
        upstream.bufferedAmount <= UPSTREAM_RESUME_BYTES;
      if (!drained) return;
      clearInterval(backpressureTimer);
      backpressureTimer = null;
      clientPaused = false;
      try {
        if (typeof clientWs.resume === 'function') clientWs.resume();
      } catch {
        /* ignore */
      }
    }, BACKPRESSURE_POLL_MS);
  };

  // (Re)arm the post-stop quiet timer. Called on each transcription segment that
  // arrives after the client's `stop`; when the upstream stays quiet for
  // POST_STOP_SETTLE_MS we treat the transcript as complete, tell the client,
  // and close. This is what allows multi-segment file transcripts to finish in
  // full instead of being cut off at the first segment.
  const armPostStopSettle = () => {
    if (postStopSettleTimer) clearTimeout(postStopSettleTimer);
    postStopSettleTimer = setTimeout(() => {
      postStopSettleTimer = null;
      sendJson(clientWs, { type: 'done' });
      cleanup();
    }, POST_STOP_SETTLE_MS);
  };

  // Report a failure to the browser (once) as an {type:'error'} frame carrying
  // a stable machine-readable `code` plus a human-readable message, write a
  // structured server log, and tear the bridge down. Serves both setup failures
  // (unknown model, no permission — before any upstream socket exists) and
  // upstream failures (socket errors, protocol errors, abnormal closes).
  const failBridge = (code, clientMessage, logMeta = {}) => {
    logger.warn('Realtime STT: bridge failure', {
      component: 'RealtimeSTT',
      userId: user.id,
      code,
      url: cfg?.url,
      ...logMeta
    });
    if (!errorSent) {
      errorSent = true;
      sendJson(clientWs, { type: 'error', code, message: clientMessage });
    }
    cleanup();
  };

  // Initialize the upstream session once it can accept commands: send the
  // provider's `readyFrames` (for vLLM, session.update + the initial commit
  // that starts transcription generation), then release the client to stream by
  // sending `ready`. Deferred until the provider's session-ready frame (or a
  // provider-specific fallback timer) so a fast/short clip can't dump audio into
  // a not-yet-created session and transcribe nothing. Any spurious empty
  // segment that initialization produces is absorbed by the post-stop settle
  // timer, not by closing on the first `final`.
  const initUpstreamSession = trigger => {
    if (sessionInitDone || !upstream || upstream.readyState !== WebSocket.OPEN) return;
    sessionInitDone = true;
    if (sessionInitTimer) {
      clearTimeout(sessionInitTimer);
      sessionInitTimer = null;
    }
    for (const frame of provider.readyFrames(cfg)) sendJson(upstream, frame);
    upstreamReady = true;
    logger.info('Realtime STT: upstream ready', {
      component: 'RealtimeSTT',
      userId: user.id,
      provider: provider.id,
      model: cfg.model,
      trigger
    });
    sendJson(clientWs, { type: 'ready' });
    // Flush any audio captured during the handshake.
    for (const chunk of pending) {
      sendJson(upstream, provider.audioFrame(chunk.toString('base64'), cfg));
    }
    pending.length = 0;
    pendingBytes = 0;
    // If the client already said `stop` while the handshake was still in flight
    // (a very short dictation), the stop handler couldn't send the end-of-audio
    // frames — send them now, after the flushed audio, so the tail isn't lost.
    if (stopRequested) {
      for (const frame of provider.stopFrames(cfg)) sendJson(upstream, frame);
    }
    resetIdle();
  };

  // Open the upstream socket. Requires `cfg` and `provider` (resolved upstream
  // details) to already be set. The no-audio grace timer is cleared on the first
  // audio frame — not here — so a socket that opens but never receives audio is
  // still torn down.
  const openUpstream = () => {
    if (upstream || !cfg || !provider) return;

    // The provider decides what to dial and how to authenticate. `cfg.url` stays
    // credential-free for logging; `connect()` may return a URL that is not.
    let dial;
    try {
      dial = provider.connect(cfg);
      upstream = createUpstream(dial.url, dial.options || {});
    } catch (err) {
      failBridge('upstream-unreachable', 'Failed to reach transcription service', {
        reason: 'construct error',
        error: err.message
      });
      return;
    }

    // Arm the idle timer for the connecting phase too, so a handshake that hangs
    // in CONNECTING (no 'open', no 'error') can't leave the bridge timer-less.
    // It is reset on 'open' and on every subsequent frame.
    resetIdle();

    upstream.on('open', () => {
      resetIdle();
      // Frames the provider needs on the wire immediately (Gemini's `setup`
      // must be the first message; vLLM sends nothing and waits instead).
      for (const frame of provider.openFrames(cfg)) sendJson(upstream, frame);
      // Wait for the provider's session-ready frame before initializing — see
      // initUpstreamSession. Providers whose readiness signal is guaranteed set
      // readyFallbackMs to 0 and rely on the idle timer for a hung handshake.
      if (provider.readyFallbackMs > 0) {
        sessionInitTimer = setTimeout(() => {
          sessionInitTimer = null;
          initUpstreamSession('fallback');
        }, provider.readyFallbackMs);
      }
    });

    upstream.on('message', data => {
      resetIdle();
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return; // upstream frames are JSON; ignore anything else
      }
      const event = provider.interpret(msg);
      switch (event.kind) {
        case 'delta': {
          gotTranscription = true;
          logger.debug('Realtime STT: transcript delta', {
            component: 'RealtimeSTT',
            userId: user.id,
            provider: provider.id,
            textLen: event.text?.length || 0
          });
          sendJson(clientWs, { type: 'delta', text: event.text || '' });
          // A file blasted at once can produce many segments after `stop`;
          // keep the completion window open while segments are still arriving.
          if (stopRequested) armPostStopSettle();
          break;
        }
        case 'final': {
          gotTranscription = true;
          logger.debug('Realtime STT: transcript segment', {
            component: 'RealtimeSTT',
            userId: user.id,
            provider: provider.id,
            textLen: event.text?.length || 0
          });
          sendJson(clientWs, { type: 'final', text: event.text || '' });
          // Completion signaling (G8): an upstream emits one finalized segment
          // per utterance, and a whole file streamed faster than realtime
          // produces several after `stop`. Closing on the FIRST would truncate
          // the transcript, so instead we (re)arm a short quiet timer on each
          // post-stop segment and only send {type:'done'} + close once the
          // upstream has gone quiet. Dictation clients ignore the `done` frame,
          // so this stays backward-compatible.
          if (stopRequested) armPostStopSettle();
          break;
        }
        case 'session-ready':
          // Session exists now — safe to configure it and start transcription.
          initUpstreamSession('session-ready');
          break;
        case 'error':
          failBridge('upstream-error', `Transcription error: ${event.error || 'unknown'}`, {
            reason: 'upstream error frame',
            upstreamError: event.error
          });
          break;
        default:
          break; // control frames that need no client action
      }
    });

    // The upstream rejected the WebSocket upgrade with an HTTP response
    // (e.g. 404 wrong path, 401/403 auth, 502 bad gateway) — very actionable.
    upstream.on('unexpected-response', (_req, res) => {
      failBridge('upstream-rejected', diagnoseUnexpectedResponse(res), {
        reason: 'unexpected-response',
        statusCode: res.statusCode
      });
    });

    upstream.on('error', err => {
      // The full err.message (which may embed the internal upstream address)
      // goes to the log only; the client gets the bare code via diagnose.
      failBridge('upstream-unreachable', diagnoseSocketError(err), {
        reason: 'socket error',
        error: err.message,
        errCode: err.code
      });
    });

    upstream.on('close', (code, reasonBuf) => {
      const reason = reasonBuf ? reasonBuf.toString() : '';
      const message = errorSent
        ? null
        : diagnoseUpstreamClose({ gotTranscription, upstreamReady, code, reason });
      if (message) {
        failBridge('upstream-closed', message, {
          reason: 'abnormal close',
          closeCode: code,
          closeReason: reason,
          upstreamReady
        });
        return;
      }
      cleanup();
    });
  };

  // --- Batch providers (no upstream socket) -------------------------------

  const batchLimits = getBatchLimits();

  /**
   * Buffer one audio frame for a batch provider. Two byte caps guard the
   * memory: this connection's own, and the process-wide total shared with every
   * other batch connection.
   */
  const bufferBatchAudio = chunk => {
    if (batchRunning) return; // audio after `stop` is ignored
    // Once the bridge has failed, cleanup has already given this connection's
    // bytes back to the process-wide budget — buffering more would re-charge
    // them with nothing left to release them again. Matters most when a cap is
    // hit part-way through draining `pending`.
    if (errorSent || clientWs.readyState > WebSocket.OPEN) return;
    if (batchBytes + chunk.length > batchLimits.maxBytes) {
      failBridge(
        'audio-too-long',
        'Recording is too long for this transcription model. Split it into shorter parts.',
        { batchBytes, maxBytes: batchLimits.maxBytes }
      );
      return;
    }
    if (batchBytesInFlight + chunk.length > batchLimits.maxBytesTotal) {
      failBridge('server-busy', 'The transcription service is busy. Please try again shortly.', {
        batchBytesInFlight,
        maxBytesTotal: batchLimits.maxBytesTotal
      });
      return;
    }
    batchChunks.push(chunk);
    batchBytes += chunk.length;
    batchBytesInFlight += chunk.length;
  };

  /**
   * Run the single transcription request a batch provider needs, then finish
   * the session exactly the way a streaming provider does: one `final` carrying
   * the transcript, then `done`.
   *
   * The idle timer is stopped for the duration — a long recording can take
   * minutes to come back, far past IDLE_TIMEOUT_MS. The keepalive pings hold
   * the browser socket (and any reverse proxy) open, and the hard session timer
   * still bounds the whole thing.
   */
  const runBatchTranscription = async () => {
    if (batchRunning) return;
    batchRunning = true;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (graceTimer) clearTimeout(graceTimer);
    graceTimer = null;

    const pcm = Buffer.concat(batchChunks);
    logger.info('Realtime STT: batch transcription started', {
      component: 'RealtimeSTT',
      userId: user.id,
      provider: provider.id,
      model: cfg.model,
      audioBytes: pcm.length,
      audioSeconds: Math.round(pcm.length / (TARGET_SAMPLE_RATE * 2))
    });

    try {
      const result = await provider.transcribe({
        cfg,
        pcm,
        sampleRate: TARGET_SAMPLE_RATE,
        signal: abortController.signal
      });
      if (clientWs.readyState > WebSocket.OPEN) return; // client walked away
      gotTranscription = true;
      sendJson(clientWs, { type: 'final', text: result?.text || '' });
      sendJson(clientWs, { type: 'done' });
      cleanup();
    } catch (err) {
      if (abortController.signal.aborted) return; // teardown already in progress
      failBridge('upstream-error', `Transcription failed: ${err.message}`, {
        reason: 'batch transcription error',
        error: err.message
      });
    }
  };

  // Resolve upstream config (once) and, when requested, open the upstream
  // socket. `openImmediately` is true for model-based transcription (the client
  // waits for {type:'ready'} before streaming) and false for dictation, where
  // the upstream opens lazily on the first audio frame. Buffered audio forces an
  // open even in the lazy case so a fast dictation client isn't stranded.
  const resolveAndPrepare = async (modelId, { openImmediately } = {}) => {
    if (cfg || resolvingCfg || upstream) {
      if (cfg && !upstream && !isBatch() && (openImmediately || pending.length > 0)) openUpstream();
      return;
    }
    resolvingCfg = true;
    let result;
    try {
      result = await resolveTranscriptionUpstream({ modelId, user });
    } catch (err) {
      resolvingCfg = false;
      failBridge('resolve-failed', 'Failed to resolve transcription model', {
        reason: 'resolve error',
        error: err.message
      });
      return;
    }
    resolvingCfg = false;
    if (errorSent || clientWs.readyState > WebSocket.OPEN) return; // torn down mid-resolve
    if (!result.ok) {
      failBridge(result.code || 'resolve-rejected', result.error, {
        reason: 'resolve rejected',
        modelId
      });
      return;
    }
    cfg = result.upstream;
    provider = result.provider;

    if (isBatch()) {
      // Nothing to dial: the client is cleared to stream straight away and the
      // audio is held here until `stop`. Audio captured while resolving moves
      // into the batch buffer so nothing is lost.
      upstreamReady = true;
      sendJson(clientWs, { type: 'ready' });
      for (const chunk of pending) bufferBatchAudio(chunk);
      pending.length = 0;
      pendingBytes = 0;
      if (stopRequested) runBatchTranscription();
      return;
    }

    if (openImmediately || pending.length > 0) openUpstream();
  };

  // --- iHub <- browser ---
  clientWs.on('message', (data, isBinary) => {
    if (isBinary) {
      // First audio frame: the client is genuinely streaming, so drop the
      // no-audio grace timer (the idle timer takes over once upstream is ready).
      if (!firstAudioSeen) {
        firstAudioSeen = true;
        if (graceTimer) {
          clearTimeout(graceTimer);
          graceTimer = null;
        }
      }
      // Open the upstream once config is known. A client that skips the `start`
      // frame resolves against the platform dictation backend here.
      if (!upstream && !isBatch()) {
        if (cfg) openUpstream();
        else if (!resolvingCfg) resolveAndPrepare(undefined, { openImmediately: true });
      }
      const chunk = Buffer.from(data);
      if (isBatch()) {
        resetIdle();
        appendedFrames += 1;
        bufferBatchAudio(chunk);
        return;
      }
      if (upstreamReady) resetIdle();
      if (upstreamReady && upstream.readyState === WebSocket.OPEN) {
        sendJson(upstream, provider.audioFrame(chunk.toString('base64'), cfg));
        appendedFrames += 1;
        // If the upstream is the slow hop, stop reading the client socket until
        // the upstream send buffer drains (bounds per-connection memory).
        applyUpstreamBackpressure();
      } else if (pendingBytes + chunk.length <= MAX_PENDING_BYTES) {
        pending.push(chunk);
        pendingBytes += chunk.length;
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
    if (msg.type === 'start') {
      // Resolve upstream now so unknown/forbidden-model errors surface before
      // audio flows. A modelId selects a first-class transcription model and
      // opens the upstream immediately (client waits for {type:'ready'}); no
      // modelId falls back to the platform dictation backend (lazy open).
      // `msg.lang` is accepted but unused — Voxtral auto-detects the language;
      // the field is kept in the protocol for future language-pinned backends.
      resolveAndPrepare(msg.modelId, { openImmediately: msg.modelId != null });
    } else if (msg.type === 'stop') {
      stopRequested = true;
      logger.info('Realtime STT: stop received', {
        component: 'RealtimeSTT',
        userId: user.id,
        provider: provider?.id,
        appendedFrames,
        pendingFrames: pending.length,
        upstreamReady
      });
      if (isBatch()) {
        // The whole recording is buffered — transcribe it in one request. If
        // config is still resolving, resolveAndPrepare picks this up instead.
        if (cfg) runBatchTranscription();
      } else if (upstreamReady && upstream.readyState === WebSocket.OPEN) {
        for (const frame of provider.stopFrames(cfg)) sendJson(upstream, frame);
      }
    }
  });

  clientWs.on('error', err => {
    logger.warn('Realtime STT: client error', { component: 'RealtimeSTT', error: err.message });
    cleanup();
  });

  clientWs.on('close', () => {
    cleanup();
  });

  // Wait for the first audio frame; close the connection if none arrives.
  graceTimer = setTimeout(() => {
    logger.info('Realtime STT: no audio received within grace window, closing', {
      component: 'RealtimeSTT',
      userId: user.id
    });
    cleanup();
  }, NO_AUDIO_GRACE_MS);

  // Keepalive: ping the browser every interval (it auto-pongs); a client that
  // misses a whole interval (crashed tab, suspended laptop, dropped network) is
  // terminated instead of lingering until the idle timeout. The pings also keep
  // reverse proxies (nginx proxy_read_timeout) from killing a connection that
  // goes quiet while the upstream GPU chews on a long tail.
  clientWs.on('pong', () => {
    clientAlive = true;
  });
  keepaliveTimer = setInterval(() => {
    if (!clientAlive) {
      logger.info('Realtime STT: client failed keepalive, terminating', {
        component: 'RealtimeSTT',
        userId: user.id
      });
      try {
        clientWs.terminate();
      } catch {
        /* ignore */
      }
      cleanup();
      return;
    }
    clientAlive = false;
    try {
      if (typeof clientWs.ping === 'function') clientWs.ping();
    } catch {
      /* ignore */
    }
    // Traffic-only ping on the upstream leg (keeps intermediaries open); its
    // liveness is governed by its own error/close events and the idle timer.
    if (upstream && upstream.readyState === WebSocket.OPEN) {
      try {
        if (typeof upstream.ping === 'function') upstream.ping();
      } catch {
        /* ignore */
      }
    }
  }, KEEPALIVE_INTERVAL_MS);

  // Hard cap on the whole session so a client streaming forever can't pin a
  // GPU-backed upstream session indefinitely (per-user caps bound how many, this
  // bounds how long). Configurable via platform.speech.realtime.maxSessionSeconds.
  const platformRealtime = (configCache.getPlatform() || {}).speech?.realtime || {};
  const maxSessionSeconds =
    Number.isInteger(platformRealtime.maxSessionSeconds) && platformRealtime.maxSessionSeconds > 0
      ? platformRealtime.maxSessionSeconds
      : DEFAULT_MAX_SESSION_SECONDS;
  sessionTimer = setTimeout(() => {
    failBridge(
      'session-limit',
      `Transcription session exceeded the maximum duration (${maxSessionSeconds}s)`,
      { maxSessionSeconds }
    );
  }, maxSessionSeconds * 1000);

  logger.info('Realtime STT: bridge established', {
    component: 'RealtimeSTT',
    userId: user.id
  });
}

/**
 * Read the batch-buffer byte caps from platform config, falling back to sane
 * defaults. Exported for tests.
 *
 * @returns {{ maxBytes: number, maxBytesTotal: number }}
 */
export function getBatchLimits() {
  const cfg = (configCache.getPlatform() || {}).speech?.realtime || {};
  const toPositiveInt = (val, fallback) => (Number.isInteger(val) && val > 0 ? val : fallback);
  return {
    maxBytes: toPositiveInt(cfg.maxBufferedAudioBytes, DEFAULT_MAX_BATCH_BYTES),
    maxBytesTotal: toPositiveInt(cfg.maxBufferedAudioBytesTotal, DEFAULT_MAX_BATCH_BYTES_TOTAL)
  };
}

/**
 * Read the connection-cap / frame-size settings from platform config, falling
 * back to sane defaults.
 */
function getConnectionLimits() {
  const cfg = (configCache.getPlatform() || {}).speech?.realtime || {};
  const toPositiveInt = (val, fallback) => (Number.isInteger(val) && val > 0 ? val : fallback);
  return {
    maxTotal: toPositiveInt(cfg.maxConnections, DEFAULT_MAX_TOTAL_CONNECTIONS),
    maxPerUser: toPositiveInt(cfg.maxConnectionsPerUser, DEFAULT_MAX_CONNECTIONS_PER_USER),
    maxFrameBytes: toPositiveInt(cfg.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES)
  };
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
  const limits = getConnectionLimits();
  const limiter = new ConnectionLimiter({
    maxTotal: limits.maxTotal,
    maxPerUser: limits.maxPerUser
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxFrameBytes });

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

    const platform = configCache.getPlatform() || {};
    let user = authenticateUpgrade(req, platform);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // Compute model permissions (from the JWT groups / anonymous defaults) so
    // per-model access can be enforced when a transcription model is selected.
    try {
      user = enhanceUserWithPermissions(user, platform.auth || {}, platform);
    } catch (err) {
      logger.warn('Realtime STT: failed to enhance user permissions', {
        component: 'RealtimeSTT',
        error: err.message
      });
    }

    // Available when either the platform dictation backend is enabled OR at
    // least one enabled transcription model exists (model-based transcription
    // does not require platform.speech.realtime).
    if (!getRealtimeConfig() && !hasEnabledTranscriptionModel()) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }

    // Enforce the concurrent-connection caps before completing the handshake, so
    // a flood of upgrades can't pin unbounded upstream sessions. Anonymous users
    // all share the id 'anonymous', which would make the per-user cap a GLOBAL
    // cap across every anonymous visitor — so key anonymous slots by client IP
    // instead (first X-Forwarded-For hop behind a proxy, socket address
    // otherwise). A direct client can spoof the header, which at worst bypasses
    // its own per-user cap; the global cap still bounds the instance.
    let limiterKey = user.id;
    if (user.id === 'anonymous') {
      const forwardedFor = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      limiterKey = `anonymous:${forwardedFor || socket.remoteAddress || 'unknown'}`;
    }
    if (!limiter.tryAcquire(limiterKey)) {
      logger.warn('Realtime STT: connection cap reached, rejecting upgrade', {
        component: 'RealtimeSTT',
        userId: user.id,
        activeTotal: limiter.total
      });
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }

    // The slot is acquired above but `bridgeConnection` (which owns releasing it)
    // only runs if handleUpgrade completes the handshake. If the socket dies
    // mid-upgrade the callback never fires, so guard against a leaked slot: once
    // the bridge takes over, `bridged` is set and this listener is inert (the
    // bridge's own cleanup releases exactly once); otherwise a pre-bridge close
    // releases the slot here.
    let bridged = false;
    socket.on('close', () => {
      if (!bridged) limiter.release(limiterKey);
    });

    wss.handleUpgrade(req, socket, head, ws => {
      bridged = true;
      bridgeConnection(ws, user, limiter, { limiterKey });
    });
  });

  logger.info('Realtime transcription WebSocket handler attached', {
    component: 'RealtimeSTT',
    path: buildApiPath('/voice/realtime'),
    maxConnections: limits.maxTotal,
    maxConnectionsPerUser: limits.maxPerUser
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
