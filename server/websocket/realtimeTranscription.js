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
 *   - The upstream socket opens only once the client names a model (`start`),
 *     not on connect, and a short no-audio grace timeout closes sockets that
 *     connect but never speak, so an abandoned browser socket can't pin an
 *     upstream session for long.
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
 *   client -> server: JSON `{type:'start', modelId, lang?}`, then binary PCM16
 *                     frames, then JSON `{type:'stop'}`
 *   server -> client: JSON `{type:'ready', mode, knowledgeSources:['audio']}`
 *                     once the backend is initialized (`mode` is the provider's,
 *                     'stream' or 'batch': a batch transcript only arrives after
 *                     `stop`, so a client waits longer for it),
 *                     `{type:'delta', text}` (streaming), `{type:'final', text}`
 *                     per completed segment, `{type:'done'}` once the transcript
 *                     is complete after `stop`, `{type:'error', message}`
 *   The same protocol serves both provider modes and every use — dictation
 *   (the microphone button), live transcription (the record button) and file
 *   transcription — so they share this one code path.
 */
import { WebSocketServer, WebSocket } from 'ws';
import configCache from '../configCache.js';
import logger from '../utils/logger.js';
import { verifyJwt } from '../utils/tokenService.js';
import { tokenUserState } from '../utils/tokenUser.js';
import {
  isAnonymousAccessAllowed,
  getDefaultAnonymousGroups,
  enhanceUserWithPermissions
} from '../utils/authorization.js';
import { buildApiPath } from '../utils/basePath.js';
import { getTranscriptionProvider } from '../transcription/index.js';
import {
  beginTranscriptionTurn,
  endTranscriptionTurn
} from '../services/chat/transcriptionTurn.js';

// What a session produces is text transcribed from the user's audio: `ready`
// says so, like `run/ended.knowledgeSources` does for a chat turn, so a
// transcript shown as a chat answer is badged by what the server reported —
// including a partial one, whose session never reaches `done`.
// `realtimeFactor` is set only when a file is paced, so the client can tell the
// user how long the transcript will take.
const readyFrame = (mode, realtimeFactor) => ({
  type: 'ready',
  mode,
  knowledgeSources: ['audio'],
  ...(realtimeFactor ? { realtimeFactor } : {})
});

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
// 4200 s = the 3600 s the chat lets a transcription run (MAX_TRANSCRIPTION_SECONDS)
// plus 10 minutes. The session's clock starts when the connection opens and the
// recording's a little later, and a batch provider transcribes only after Stop,
// which takes minutes for an hour of audio. A cap equal to the recording limit
// would end the session before the transcript arrives and lose the recording.
const DEFAULT_MAX_SESSION_SECONDS = 4200;

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
// connection (≈70 min of 16 kHz PCM16, which holds the 60 minutes an app
// transcribes by default) and one across the process, so the per-user/global
// connection caps can't be combined into an OOM. Both are overridable via
// platform.speech.realtime.{maxBufferedAudioBytes, maxBufferedAudioBytesTotal}.
const DEFAULT_MAX_BATCH_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_BATCH_BYTES_TOTAL = 512 * 1024 * 1024;

// Pacing a file into a rate-limited live upstream (see getStreamLimits): the
// queue drains every tick, with at most one second of audio as burst credit.
// The client socket is paused while the queue holds more than the high mark,
// so a file streamed at full speed is held as TCP backpressure, not in memory.
const PACE_TICK_MS = 100;
const PACE_HIGH_BYTES = 2 * 1024 * 1024;
const PACE_LOW_BYTES = 512 * 1024;
// Session rotation: after `stop` the retiring session gets this long to
// deliver its last segment (quiet time after its last frame), at most the max.
const RETIRE_QUIET_MS = 1_500;
const RETIRE_MAX_MS = 10_000;
// PCM16 mono at 16 kHz.
const BYTES_PER_SECOND = 32_000;

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
 *
 * A signed session token outlives the account behind it, and the upgrade does
 * not pass through `jwtAuth`, so the user store is asked here too: a token for a
 * deleted or disabled user is refused, not downgraded to anonymous.
 *
 * @throws {Error} When the user store cannot be read, so the caller can answer
 *   503 rather than treating the user as deleted
 */
export async function authenticateUpgrade(req, platform = configCache.getPlatform() || {}) {
  const decoded = verifyTokenOf(req);
  if (decoded) return sessionUserOf(decoded, platform);

  // No valid token — allow only if anonymous access is enabled platform-wide.
  if (isAnonymousAccessAllowed(platform)) {
    return { id: 'anonymous', name: 'anonymous', groups: getDefaultAnonymousGroups(platform) };
  }
  return null;
}

/** The verified claims of the request's session token, if it carries a valid one. */
function verifyTokenOf(req) {
  const token = extractToken(req);
  return token ? verifyJwt(token) : null;
}

/**
 * The user a verified session token stands for, unless that user was deleted or
 * disabled since it was minted.
 *
 * @throws {Error} When the users cannot be read to check
 */
async function sessionUserOf(decoded, platform) {
  const userState = await tokenUserState(platform, decoded);
  if (userState === 'unavailable') throw new Error('Users configuration unavailable');
  if (userState !== 'active') return null;
  return {
    id: decoded.sub || decoded.username || decoded.id || 'user',
    name: decoded.name || decoded.username || 'user',
    groups: Array.isArray(decoded.groups) ? decoded.groups : []
  };
}

/**
 * True when at least one enabled `transcription` model is configured. Used by
 * the upgrade-time availability pre-check: every session needs one.
 */
export function hasEnabledTranscriptionModel() {
  const { data: models = [] } = configCache.getModels(); // enabled only
  return models.some(m => m?.modelType === 'transcription');
}

/**
 * Resolve the upstream connection for a transcription session.
 *
 * The model is looked up in the models cache, required to be an enabled
 * `transcription` model the user is permitted to use, and resolved to concrete
 * upstream details via the transcription provider registry. Dictation names
 * its model like every other use: the one an app or Admin → Voice Input picks.
 *
 * A raw upstream URL is NEVER accepted from the client — only a server-resolved
 * model id — so the upstream URL/API key never reach the browser.
 *
 * @param {{ modelId?: string, user?: Object }} params
 * @returns {Promise<{ ok: true, upstream: { url: string, apiKey: string, model: string },
 *   provider: Object } | { ok: false, code: string, error: string }>}
 */
export async function resolveTranscriptionUpstream({ modelId, user } = {}) {
  if (!modelId) {
    return { ok: false, code: 'no-model', error: 'No transcription model selected' };
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
  return { ok: true, upstream, provider, limits: getStreamLimits(provider, model) };
}

/**
 * How fast a whole file may be fed to a streaming upstream, and how long one
 * upstream session may run. A model's `config` overrides the provider's
 * defaults; 0 / absent means unlimited. Exported for tests.
 *
 * - `maxRealtimeFactor`: a live API that rate-limits audio closes the session
 *   when a file arrives much faster than real time (Gemini Live answers ~8x
 *   with 1011 "Resource has been exhausted"). Microphone audio is real time
 *   already and is never paced.
 * - `maxSessionSeconds`: a live API that caps one session's lifetime (Gemini
 *   Live, ~10 min) gets a fresh session before the cap, so long recordings and
 *   long dictation keep going.
 *
 * @param {Object} provider
 * @param {Object} model
 * @returns {{ maxRealtimeFactor: number, maxSessionSeconds: number }}
 */
export function getStreamLimits(provider, model) {
  const pick = key => {
    const val = Number(model?.config?.[key] ?? provider?.[key]);
    return Number.isFinite(val) && val > 0 ? val : 0;
  };
  return {
    maxRealtimeFactor: pick('maxRealtimeFactor'),
    maxSessionSeconds: pick('maxSessionSeconds')
  };
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
 * response (404 wrong path, 401/403 auth, 502 bad gateway…). The common causes
 * get a hint on how to fix them. A redirect on a ws:// URL almost always means
 * the endpoint only accepts TLS (the HTTP→HTTPS redirect of a reverse proxy),
 * which a WebSocket client cannot follow (issue #2612). The Location header is
 * deliberately left out: it may name an internal host.
 *
 * @param {{statusCode?: number, statusMessage?: string}} res
 * @param {{url?: string}} [opts] The dialled URL, to tailor the redirect hint.
 */
export function diagnoseUnexpectedResponse(res = {}, { url = '' } = {}) {
  const base =
    `Transcription service rejected the connection (HTTP ${res.statusCode} ${res.statusMessage || ''})`.trim();
  const status = Number(res.statusCode);
  let hint = '';
  if (status >= 300 && status < 400) {
    hint = /^ws:\/\//i.test(url)
      ? 'the endpoint redirected, which usually means it requires a secure connection: use wss:// instead of ws://'
      : 'the endpoint redirected: check the URL (host, path and trailing slash)';
  } else if (status === 401 || status === 403) {
    hint = 'check the API key';
  } else if (status === 404) {
    hint = 'check the URL path';
  }
  return hint ? `${base}: ${hint}` : base;
}

/**
 * Client-facing message for an upstream close, or null when the close is
 * expected. Only a normal close (1000, or 1005 = no status) of an established
 * session is expected. Any other code is a failure even after some text came
 * back: an upstream that drops the session mid-recording (Gemini Live's 1011
 * "Resource has been exhausted") would otherwise end silently and leave a
 * truncated transcript looking complete.
 */
export function diagnoseUpstreamClose({ gotTranscription, upstreamReady, code, reason } = {}) {
  const normal = code === 1000 || code === 1005;
  if (normal && (gotTranscription || upstreamReady)) return null;
  return `Transcription service closed the connection (code ${code}${reason ? `: ${reason}` : ''})`;
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
 * Upstream config is resolved on the `{type:'start'}` frame, which names the
 * model. This lets unknown/forbidden/disabled-model errors be answered with an
 * `{type:'error'}` frame before any audio flows. The upstream socket opens as
 * soon as config resolves, so a client can wait for `{type:'ready'}` and stream
 * a whole buffer with backpressure; audio sent before that is held (bounded).
 * A client that streams audio without a `start` frame gets a `no-model` error.
 *
 * Everything upstream-specific — what to dial, which frames to send, how to
 * read the frames that come back, or (for a batch provider) the single
 * transcription call — comes from the resolved provider. See
 * `server/transcription/index.js` for that contract.
 *
 * Terminology used here and in the docs: "transcription" is the feature,
 * "dictation" is the mic-to-input UX, "realtime" is the transport.
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
  let tornDown = false; // cleanup ran: closes we caused are not diagnosed
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
  // `file`: a whole recording streamed faster than real time (paced upstream
  // when the model has a maxRealtimeFactor); `mic`: live audio (never paced).
  let source = 'mic';
  let limits = { maxRealtimeFactor: 0, maxSessionSeconds: 0 };
  const paced = []; // file audio waiting for its turn upstream
  let pacedBytes = 0;
  let paceTimer = null;
  let paceCredit = 0; // bytes the pacer may still send now
  let paceLast = 0;
  let pacePaused = false; // client socket paused because the paced queue is full
  let stopSentUpstream = false; // the provider's stop frames went out
  let clientReadySent = false; // `ready` goes to the client once, not per session
  let sessionStartedAt = 0; // current upstream session: wall clock …
  let sessionAudioBytes = 0; // … and audio sent, for rotation
  let retiring = null; // previous upstream session finishing its tail
  let retireQuietTimer = null;
  let retireMaxTimer = null;
  // A file or recording sent to a transcription model selected in a stored
  // chat is a chat turn (see services/chat/transcriptionTurn.js): `start`
  // names the chat, the bridge stores the transcript as the answer.
  let turnRequest = null; // { chatId, appId, ephemeral, clientMessageId, attachment }
  let turnPromise = null; // resolves to the begun turn, or null
  let transcriptCommitted = ''; // the transcript, assembled like the client does
  let transcriptPartial = '';
  let completed = false; // `done` went to the client
  let failure = null; // what a failure told the client

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

  // A `final` replaces the deltas of its utterance (the client does the same).
  const commitTranscript = text => {
    transcriptCommitted = `${transcriptCommitted} ${text || transcriptPartial}`.trim();
    transcriptPartial = '';
  };

  // Resolves once the chat is authorized and the question stored (or nothing
  // is stored); the provider starts only after it, so a refused chat costs no
  // upstream session.
  const startTurn = modelId => {
    if (!turnRequest) return Promise.resolve(null);
    if (turnPromise) return turnPromise;
    turnPromise = beginTranscriptionTurn({ user, modelId, ...turnRequest })
      .then(result => {
        if (result.ok) return result.turn;
        failBridge(result.code, 'Not permitted to add to this chat', {
          reason: 'chat turn refused',
          chatId: turnRequest.chatId
        });
        return null;
      })
      .catch(err => {
        logger.error('Realtime STT: chat turn not stored', {
          component: 'RealtimeSTT',
          userId: user.id,
          error: err.message
        });
        return null;
      });
  };

  // Store the answer once, however the session ends. Resolves when it is
  // stored, so a success is only acknowledged with the transcript in place.
  let turnEndPromise = null;
  const endTurn = () => {
    if (!turnPromise) return Promise.resolve();
    if (turnEndPromise) return turnEndPromise;
    const content = `${transcriptCommitted} ${transcriptPartial}`.replace(/\s+/g, ' ').trim();
    const outcome = { content, error: failure, aborted: !completed && !failure };
    turnEndPromise = turnPromise.then(turn => endTranscriptionTurn(turn, outcome));
    return turnEndPromise;
  };

  // The transcript is complete: store it, then tell the client and close.
  // A chat model asked about it right after `done` reads it from the store.
  const finishCompleted = async () => {
    if (completed || tornDown) return;
    completed = true;
    await endTurn();
    sendJson(clientWs, { type: 'done' });
    cleanup();
  };

  const cleanup = () => {
    tornDown = true;
    endTurn();
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
    if (paceTimer) clearInterval(paceTimer);
    paceTimer = null;
    paced.length = 0;
    pacedBytes = 0;
    if (retireQuietTimer) clearTimeout(retireQuietTimer);
    retireQuietTimer = null;
    if (retireMaxTimer) clearTimeout(retireMaxTimer);
    retireMaxTimer = null;
    if (retiring && retiring.readyState <= WebSocket.OPEN) {
      try {
        retiring.close();
      } catch {
        /* ignore */
      }
    }
    retiring = null;
    // Cancel an in-flight batch request and free its buffered audio, so a
    // client that walks away doesn't leave a fetch (and 30 MB) hanging around.
    abortController.abort();
    releaseBatchBytes();
    if (clientPaused || pacePaused) {
      clientPaused = false;
      pacePaused = false;
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
      if (pacePaused) return; // the pacer resumes the client once its queue drains
      try {
        if (typeof clientWs.resume === 'function') clientWs.resume();
      } catch {
        /* ignore */
      }
    }, BACKPRESSURE_POLL_MS);
  };

  const upstreamOpen = () => upstreamReady && upstream?.readyState === WebSocket.OPEN;

  // One chunk of PCM to the current upstream session.
  const sendUpstreamAudio = chunk => {
    sendJson(upstream, provider.audioFrame(chunk.toString('base64'), cfg));
    appendedFrames += 1;
    sessionAudioBytes += chunk.length;
    resetIdle();
    // If the upstream is the slow hop, stop reading the client socket until
    // the upstream send buffer drains (bounds per-connection memory).
    applyUpstreamBackpressure();
    maybeRotate();
  };

  // End of audio for the upstream: only once every paced chunk went out, and
  // never to a session that is being replaced (the next one gets it).
  const sendStopUpstreamWhenDrained = () => {
    if (!stopRequested || stopSentUpstream || paced.length || !upstreamOpen()) return;
    stopSentUpstream = true;
    for (const frame of provider.stopFrames(cfg)) sendJson(upstream, frame);
  };

  const isPacing = () => source === 'file' && limits.maxRealtimeFactor > 0;

  // Release queued file audio: at `maxRealtimeFactor` × real time when the
  // model has one, otherwise as fast as the upstream takes it. File audio is
  // always queued (not `pending`, which is capped), so a session rotation in
  // the middle of a file loses nothing.
  const drainPaced = () => {
    if (isPacing()) {
      const now = Date.now();
      // The first drain starts with a full second of credit: a short burst
      // (measured fine) gets the transcript going without waiting a tick.
      if (!paceLast) paceLast = now - 1000;
      const bytesPerSecond = BYTES_PER_SECOND * limits.maxRealtimeFactor;
      paceCredit = Math.min(
        paceCredit + ((now - paceLast) / 1000) * bytesPerSecond,
        bytesPerSecond
      );
      paceLast = now;
    } else {
      paceCredit = Infinity;
    }
    while (paced.length && paceCredit > 0 && upstreamOpen()) {
      const chunk = paced.shift();
      pacedBytes -= chunk.length;
      paceCredit -= chunk.length;
      sendUpstreamAudio(chunk);
    }
    if (pacePaused && pacedBytes <= PACE_LOW_BYTES) {
      pacePaused = false;
      if (!clientPaused) {
        try {
          clientWs.resume();
        } catch {
          /* ignore */
        }
      }
    }
    sendStopUpstreamWhenDrained();
  };

  const enqueuePaced = chunk => {
    paced.push(chunk);
    pacedBytes += chunk.length;
    if (!isPacing()) drainPaced();
    else if (!paceTimer) paceTimer = setInterval(drainPaced, PACE_TICK_MS);
    if (!pacePaused && pacedBytes > PACE_HIGH_BYTES && typeof clientWs.pause === 'function') {
      pacePaused = true;
      try {
        clientWs.pause();
      } catch {
        pacePaused = false;
      }
    }
  };

  // --- Upstream session rotation ---
  // A live API that caps a session's lifetime gets a fresh session before the
  // cap (or when it announces the end itself, Gemini's `goAway`). The old one
  // is told the audio ended and keeps delivering its last segments; audio that
  // arrives meanwhile waits in `pending` / the paced queue. The browser sees
  // one uninterrupted session.
  const maybeRotate = () => {
    const cap = limits.maxSessionSeconds;
    if (!cap || stopSentUpstream || !upstreamOpen()) return;
    const elapsed = (Date.now() - sessionStartedAt) / 1000;
    const audioSeconds = sessionAudioBytes / BYTES_PER_SECOND;
    if (elapsed >= cap || audioSeconds >= cap) rotateUpstream('session-limit');
  };

  const finishRotation = () => {
    if (retireQuietTimer) clearTimeout(retireQuietTimer);
    retireQuietTimer = null;
    if (retireMaxTimer) clearTimeout(retireMaxTimer);
    retireMaxTimer = null;
    const old = retiring;
    retiring = null;
    if (old && old.readyState <= WebSocket.OPEN) {
      try {
        old.close();
      } catch {
        /* ignore */
      }
    }
    if (errorSent || clientWs.readyState > WebSocket.OPEN) return;
    openUpstream();
  };

  const armRetireQuiet = () => {
    if (retireQuietTimer) clearTimeout(retireQuietTimer);
    retireQuietTimer = setTimeout(finishRotation, RETIRE_QUIET_MS);
  };

  const rotateUpstream = reason => {
    if (retiring || !upstream || stopSentUpstream) return;
    logger.info('Realtime STT: rotating upstream session', {
      component: 'RealtimeSTT',
      userId: user.id,
      provider: provider.id,
      reason,
      sessionSeconds: Math.round((Date.now() - sessionStartedAt) / 1000),
      audioSeconds: Math.round(sessionAudioBytes / BYTES_PER_SECOND)
    });
    retiring = upstream;
    if (retiring.readyState === WebSocket.OPEN) {
      for (const frame of provider.stopFrames(cfg)) sendJson(retiring, frame);
    }
    upstream = null;
    upstreamReady = false;
    sessionInitDone = false;
    if (sessionInitTimer) clearTimeout(sessionInitTimer);
    sessionInitTimer = null;
    armRetireQuiet();
    retireMaxTimer = setTimeout(finishRotation, RETIRE_MAX_MS);
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
      void finishCompleted();
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
      failure = clientMessage;
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
    sessionStartedAt = Date.now();
    sessionAudioBytes = 0;
    logger.info('Realtime STT: upstream ready', {
      component: 'RealtimeSTT',
      userId: user.id,
      provider: provider.id,
      model: cfg.model,
      trigger,
      source,
      ...(isPacing() ? { realtimeFactor: limits.maxRealtimeFactor } : {}),
      ...(limits.maxSessionSeconds ? { maxSessionSeconds: limits.maxSessionSeconds } : {})
    });
    // A rotated session is invisible to the client: `ready` goes out once.
    if (!clientReadySent) {
      clientReadySent = true;
      sendJson(
        clientWs,
        readyFrame(provider.mode, isPacing() ? limits.maxRealtimeFactor : undefined)
      );
    }
    // Flush any audio captured during the handshake (or a rotation).
    const held = pending.splice(0);
    pendingBytes = 0;
    for (const chunk of held) {
      if (!upstreamOpen()) {
        pending.push(chunk); // a rotation started mid-flush; the next session gets it
        pendingBytes += chunk.length;
      } else sendUpstreamAudio(chunk);
    }
    // If the client already said `stop` while the handshake was still in flight
    // (a very short dictation), the stop handler couldn't send the end-of-audio
    // frames — send them now, after the flushed audio, so the tail isn't lost.
    // A paced file sends them once its queue is empty.
    if (source === 'file') drainPaced();
    else sendStopUpstreamWhenDrained();
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
    let sock;
    try {
      const dial = provider.connect(cfg);
      sock = createUpstream(dial.url, dial.options || {});
    } catch (err) {
      failBridge('upstream-unreachable', 'Failed to reach transcription service', {
        reason: 'construct error',
        error: err.message
      });
      return;
    }
    upstream = sock;
    // Handlers are bound to this socket. After a rotation it is `retiring`: its
    // last segments still reach the client, but it can no longer fail or end
    // the bridge. Any other socket is stale and ignored.
    const isCurrent = () => sock === upstream;
    const isRetiring = () => sock === retiring;

    // Arm the idle timer for the connecting phase too, so a handshake that hangs
    // in CONNECTING (no 'open', no 'error') can't leave the bridge timer-less.
    // It is reset on 'open' and on every subsequent frame.
    resetIdle();

    sock.on('open', () => {
      if (!isCurrent()) return;
      resetIdle();
      // Frames the provider needs on the wire immediately (Gemini's `setup`
      // must be the first message; vLLM sends nothing and waits instead).
      for (const frame of provider.openFrames(cfg)) sendJson(sock, frame);
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

    sock.on('message', data => {
      const retiringNow = isRetiring();
      if (!isCurrent() && !retiringNow) return;
      resetIdle();
      if (retiringNow) armRetireQuiet();
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
          transcriptPartial += event.text || '';
          sendJson(clientWs, { type: 'delta', text: event.text || '' });
          // A file blasted at once can produce many segments after `stop`;
          // keep the completion window open while segments are still arriving.
          if (stopSentUpstream) armPostStopSettle();
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
          commitTranscript(event.text);
          sendJson(clientWs, { type: 'final', text: event.text || '' });
          // Completion signaling (G8): an upstream emits one finalized segment
          // per utterance, and a whole file streamed faster than realtime
          // produces several after `stop`. Closing on the FIRST would truncate
          // the transcript, so instead we (re)arm a short quiet timer on each
          // segment after the end of audio went upstream (not merely after the
          // client's `stop`: a paced file may still be feeding for minutes),
          // and only send {type:'done'} + close once the upstream has gone
          // quiet. Dictation clients ignore the `done` frame.
          if (stopSentUpstream) armPostStopSettle();
          break;
        }
        case 'session-ready':
          // Session exists now — safe to configure it and start transcription.
          if (!retiringNow) initUpstreamSession('session-ready');
          break;
        case 'go-away':
          // The upstream announced it will end this session soon.
          if (!retiringNow) rotateUpstream('go-away');
          break;
        case 'error':
          if (retiringNow) {
            finishRotation();
            break;
          }
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
    sock.on('unexpected-response', (_req, res) => {
      if (!isCurrent()) return;
      failBridge('upstream-rejected', diagnoseUnexpectedResponse(res, { url: cfg.url }), {
        reason: 'unexpected-response',
        statusCode: res.statusCode
      });
    });

    sock.on('error', err => {
      if (isRetiring()) {
        finishRotation();
        return;
      }
      if (!isCurrent()) return;
      // The full err.message (which may embed the internal upstream address)
      // goes to the log only; the client gets the bare code via diagnose.
      failBridge('upstream-unreachable', diagnoseSocketError(err), {
        reason: 'socket error',
        error: err.message,
        errCode: err.code
      });
    });

    sock.on('close', (code, reasonBuf) => {
      if (isRetiring()) {
        finishRotation();
        return;
      }
      if (!isCurrent() || tornDown) return;
      const reason = reasonBuf ? reasonBuf.toString() : '';
      const message = errorSent
        ? null
        : diagnoseUpstreamClose({ gotTranscription, upstreamReady, code, reason });
      if (message) {
        failBridge('upstream-closed', message, {
          reason: 'abnormal close',
          closeCode: code,
          closeReason: reason,
          upstreamReady,
          source,
          audioSeconds: Math.round(sessionAudioBytes / BYTES_PER_SECOND)
        });
        return;
      }
      // A normal close after the end of audio went upstream is the upstream
      // finishing the transcript, which the client takes as completion too.
      if (stopSentUpstream && !errorSent) {
        void finishCompleted();
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
      commitTranscript(result?.text);
      sendJson(clientWs, { type: 'final', text: result?.text || '' });
      await finishCompleted();
    } catch (err) {
      if (abortController.signal.aborted) return; // teardown already in progress
      failBridge('upstream-error', `Transcription failed: ${err.message}`, {
        reason: 'batch transcription error',
        error: err.message
      });
    }
  };

  // Resolve upstream config (once) and open the upstream socket. A second
  // `start` while resolving or after is ignored.
  const resolveAndPrepare = async modelId => {
    if (cfg || resolvingCfg || upstream) return;
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
    limits = result.limits || limits;
    await startTurn(modelId);
    if (errorSent || clientWs.readyState > WebSocket.OPEN) return; // refused, or the client left

    if (isBatch()) {
      // Nothing to dial: the client is cleared to stream straight away and the
      // audio is held here until `stop`. Audio captured while resolving moves
      // into the batch buffer so nothing is lost.
      upstreamReady = true;
      sendJson(clientWs, readyFrame(provider.mode));
      for (const chunk of pending) bufferBatchAudio(chunk);
      pending.length = 0;
      pendingBytes = 0;
      if (stopRequested) void runBatchTranscription();
      return;
    }

    openUpstream();
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
      // A client that streams without a `start` frame named no model: this
      // answers it with a `no-model` error.
      if (!cfg && !resolvingCfg) void resolveAndPrepare(undefined);
      const chunk = Buffer.from(data);
      if (isBatch()) {
        resetIdle();
        appendedFrames += 1;
        bufferBatchAudio(chunk);
        return;
      }
      if (upstreamReady) resetIdle();
      if (source === 'file' && provider) {
        enqueuePaced(chunk);
      } else if (upstreamOpen()) {
        sendUpstreamAudio(chunk);
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
      // audio flows; the upstream opens as soon as the model resolves.
      // `msg.lang` is accepted but unused — the models auto-detect the
      // language; the field is kept for future language-pinned backends.
      // `source: 'file'` marks a whole recording sent faster than real time.
      if (msg.source === 'file') source = 'file';
      if (typeof msg.chatId === 'string' && typeof msg.appId === 'string') {
        const attachment =
          msg.attachment && typeof msg.attachment === 'object' ? msg.attachment : null;
        turnRequest = {
          chatId: msg.chatId,
          appId: msg.appId,
          ephemeral: msg.ephemeral === true,
          clientMessageId: typeof msg.clientMessageId === 'string' ? msg.clientMessageId : null,
          attachment: attachment && {
            name: String(attachment.name || '').slice(0, 300),
            type: String(attachment.type || 'audio'),
            ...(Number.isFinite(Number(attachment.bytes))
              ? { bytes: Number(attachment.bytes) }
              : {})
          }
        };
      }
      void resolveAndPrepare(msg.modelId);
    } else if (msg.type === 'stop') {
      stopRequested = true;
      logger.info('Realtime STT: stop received', {
        component: 'RealtimeSTT',
        userId: user.id,
        provider: provider?.id,
        appendedFrames,
        pendingFrames: pending.length,
        queuedSeconds: Math.round(pacedBytes / BYTES_PER_SECOND),
        upstreamReady
      });
      if (isBatch()) {
        // The whole recording is buffered — transcribe it in one request. If
        // config is still resolving, resolveAndPrepare picks this up instead.
        if (cfg) void runBatchTranscription();
      } else {
        // Straight away, or once the paced queue / a rotation is through.
        sendStopUpstreamWhenDrained();
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
  const maxSessionSeconds = getMaxSessionSeconds();
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
 * The hard cap on one session's lifetime in seconds: the platform's
 * `speech.realtime.maxSessionSeconds` where that is a positive integer, the
 * default otherwise. It has to exceed the longest recording an app allows
 * (the chat's MAX_TRANSCRIPTION_SECONDS) with room for the final transcription.
 * Exported for tests.
 *
 * @returns {number}
 */
export function getMaxSessionSeconds() {
  const { maxSessionSeconds } = (configCache.getPlatform() || {}).speech?.realtime || {};
  return Number.isInteger(maxSessionSeconds) && maxSessionSeconds > 0
    ? maxSessionSeconds
    : DEFAULT_MAX_SESSION_SECONDS;
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

  httpServer.on('upgrade', async (req, socket, head) => {
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
    let user = null;
    try {
      user = await authenticateUpgrade(req, platform);
    } catch (err) {
      logger.error('Realtime STT: could not validate the user behind the token', {
        component: 'RealtimeSTT',
        error: err.message
      });
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }
    // The client may have gone while the user was looked up; nothing below
    // would release what it takes.
    if (socket.destroyed) return;
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

    // Every session names a transcription model, so with none enabled there
    // is nothing to bridge to.
    if (!hasEnabledTranscriptionModel()) {
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
 * Test a transcription model's upstream without streaming speech — the "Test"
 * action on Admin → Models. A streaming provider is dialled exactly like a
 * session (same `connect` and `openFrames`) and passes once the upstream
 * starts the session; a batch provider is sent one second of silence, which
 * exercises the endpoint and the key.
 *
 * @param {Object} model - Transcription model config, as cached (keys decrypted).
 * @param {{ timeoutMs?: number, createUpstream?: Function }} [options]
 *   `createUpstream` injects the socket factory for tests.
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function testTranscriptionModel(
  model,
  { timeoutMs = 8000, createUpstream = (url, opts) => new WebSocket(url, opts) } = {}
) {
  const provider = getTranscriptionProvider(model?.provider);
  if (!provider) {
    return { ok: false, message: `Unsupported transcription provider: ${model?.provider}` };
  }
  const cfg = await provider.resolveUpstream(model);
  if (!cfg?.url) return { ok: false, message: 'The model has no endpoint URL' };

  if (provider.mode === 'batch') {
    try {
      await provider.transcribe({
        cfg,
        pcm: Buffer.alloc(TARGET_SAMPLE_RATE * 2),
        sampleRate: TARGET_SAMPLE_RATE,
        signal: AbortSignal.timeout(timeoutMs)
      });
      return { ok: true, message: 'Transcribed a second of silence' };
    } catch (err) {
      return { ok: false, message: `Transcription failed: ${err.message}` };
    }
  }
  return testStreamingUpstream(provider, cfg, { timeoutMs, createUpstream });
}

function testStreamingUpstream(provider, cfg, { timeoutMs, createUpstream }) {
  return new Promise(resolve => {
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

    // A provider without a guaranteed session frame (vLLM builds differ) may
    // stay silent until audio arrives, so an open socket is a pass there.
    const timer = setTimeout(() => {
      if (!opened) {
        finish({ ok: false, message: `Connection timed out after ${timeoutMs}ms` });
      } else if (provider.readyFallbackMs > 0) {
        finish({ ok: true, message: 'Connected (no session frame received in time)' });
      } else {
        finish({ ok: false, message: 'Connected, but the endpoint never started a session' });
      }
    }, timeoutMs);

    try {
      const dial = provider.connect(cfg);
      ws = createUpstream(dial.url, dial.options || {});
    } catch (err) {
      finish({ ok: false, message: `Failed to open socket: ${err.message}` });
      return;
    }

    ws.on('open', () => {
      opened = true;
      for (const frame of provider.openFrames(cfg)) sendJson(ws, frame);
    });

    ws.on('message', data => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        finish({ ok: true, message: 'Connected — endpoint responded' });
        return;
      }
      const event = provider.interpret(msg);
      if (event.kind === 'error') {
        finish({ ok: false, message: `Endpoint error: ${event.error || 'unknown'}` });
      } else if (event.kind === 'session-ready') {
        finish({ ok: true, message: 'Connected — the endpoint started a session' });
      }
      // Anything else (acks, keepalives) — keep waiting for the session.
    });

    // The endpoint answered the upgrade with a plain HTTP response (redirect,
    // auth failure, wrong path…). Handled here so the admin sees what it means
    // instead of ws's bare "Unexpected server response: 308". finish() closes
    // the still-CONNECTING socket, which aborts the request.
    ws.on('unexpected-response', (_req, res) => {
      finish({ ok: false, message: diagnoseUnexpectedResponse(res, { url: cfg.url }) });
    });

    ws.on('error', err => {
      finish({ ok: false, message: `Connection failed: ${err.message}` });
    });

    // Gemini Live reports a rejected key by closing with a reason.
    ws.on('close', (code, reason) => {
      if (!opened) {
        finish({ ok: false, message: 'Connection closed before handshake' });
        return;
      }
      const why = reason?.toString() || '';
      finish({
        ok: false,
        message: `The endpoint closed the connection (${code}${why ? `: ${why}` : ''})`
      });
    });
  });
}

export default attachRealtimeTranscription;
