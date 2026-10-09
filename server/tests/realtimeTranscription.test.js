/**
 * Realtime speech-to-text WebSocket proxy — unit tests.
 *
 * Locks in the security-critical behavior of the upgrade path (Cross-Site
 * WebSocket Hijacking origin guard, JWT/anonymous auth), the resource-exhaustion
 * guard (per-user + global connection caps), and the upstream error-diagnostic
 * mapping. These previously lived only in throwaway verification scripts.
 */
import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import http from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  normalizeOrigin,
  isAllowedOrigin,
  extractToken,
  authenticateUpgrade,
  ConnectionLimiter,
  bridgeConnection,
  diagnoseSocketError,
  diagnoseUnexpectedResponse,
  diagnoseUpstreamClose,
  testTranscriptionModel
} from '../websocket/realtimeTranscription.js';
import { generateJwt } from '../utils/tokenService.js';
import { getTranscriptionProvider } from '../transcription/index.js';
import configCache from '../configCache.js';

// verifyJwt (called inside authenticateUpgrade) resolves its algorithm and
// signing key from the platform cache. Seed a symmetric HS256 secret so tokens
// generated here validate, without depending on RSA key material.
beforeAll(() => {
  configCache.setCacheEntry('config/platform.json', {
    jwt: { algorithm: 'HS256' },
    auth: { jwtSecret: 'realtime-stt-test-secret' }
  });
});

afterAll(() => {
  // setCacheEntry schedules a TTL refresh timer that dynamically imports the
  // telemetry module; cancel it so it can't fire after Jest tears the env down.
  const timer = configCache.refreshTimers?.get('config/platform.json');
  if (timer) clearTimeout(timer);
  configCache.refreshTimers?.delete('config/platform.json');
});

const anonAllowed = {
  anonymousAuth: { enabled: true, defaultGroups: ['anonymous'] }
};
const anonDenied = {
  anonymousAuth: { enabled: false, defaultGroups: ['anonymous'] }
};

describe('normalizeOrigin', () => {
  test('strips trailing path and slashes to scheme+host(+port)', () => {
    expect(normalizeOrigin('https://app.example.com/')).toBe('https://app.example.com');
    expect(normalizeOrigin('https://app.example.com/some/path')).toBe('https://app.example.com');
    expect(normalizeOrigin('http://localhost:3000')).toBe('http://localhost:3000');
  });
});

describe('isAllowedOrigin (CSWSH guard)', () => {
  const platform = { cors: { origin: ['https://trusted.example.com'] } };

  test('allows a missing Origin (non-browser caller cannot be a CSWSH victim)', () => {
    expect(isAllowedOrigin({ headers: { host: 'ihub.local' } }, platform)).toBe(true);
  });

  test('allows same-origin via Host header', () => {
    const req = { headers: { host: 'ihub.local', origin: 'https://ihub.local' } };
    expect(isAllowedOrigin(req, platform)).toBe(true);
  });

  test('allows same-origin via X-Forwarded-Host (behind a reverse proxy)', () => {
    const req = {
      headers: {
        host: 'internal:3000',
        'x-forwarded-host': 'ihub.public.com',
        origin: 'https://ihub.public.com'
      }
    };
    expect(isAllowedOrigin(req, platform)).toBe(true);
  });

  test('allows an origin in the configured CORS allowlist', () => {
    const req = { headers: { host: 'internal', origin: 'https://trusted.example.com' } };
    expect(isAllowedOrigin(req, platform)).toBe(true);
  });

  test('rejects a cross-origin browser handshake', () => {
    const req = { headers: { host: 'ihub.local', origin: 'https://evil.example.com' } };
    expect(isAllowedOrigin(req, platform)).toBe(false);
  });

  test('does NOT honor a wildcard CORS origin (cookie-authenticated socket)', () => {
    const req = { headers: { host: 'ihub.local', origin: 'https://anything.com' } };
    expect(isAllowedOrigin(req, { cors: { origin: ['*'] } })).toBe(false);
  });

  test('same-origin is still allowed when the allowlist is a wildcard', () => {
    const req = { headers: { host: 'ihub.local', origin: 'https://ihub.local' } };
    expect(isAllowedOrigin(req, { cors: { origin: ['*'] } })).toBe(true);
  });

  test('origin/host comparison is case-insensitive (RFC 3986)', () => {
    const req = { headers: { host: 'IHub.Local', origin: 'https://ihub.LOCAL' } };
    expect(isAllowedOrigin(req, {})).toBe(true);
    const listed = { headers: { host: 'internal', origin: 'https://Trusted.Example.com' } };
    expect(isAllowedOrigin(listed, platform)).toBe(true);
  });
});

describe('extractToken', () => {
  test('reads a Bearer token from the Authorization header', () => {
    expect(extractToken({ headers: { authorization: 'Bearer abc.def.ghi' } })).toBe('abc.def.ghi');
  });

  test('reads the authToken cookie and url-decodes it', () => {
    const req = { headers: { cookie: 'other=1; authToken=a%2Bb.c; foo=2' } };
    expect(extractToken(req)).toBe('a+b.c');
  });

  test('returns null when no token is present', () => {
    expect(extractToken({ headers: {} })).toBeNull();
  });
});

describe('authenticateUpgrade', () => {
  test('accepts a valid JWT and returns the user identity', async () => {
    const { token } = generateJwt({ id: 'u1', name: 'Alice', groups: ['users'] });
    const req = { headers: { cookie: `authToken=${token}` } };
    const user = await authenticateUpgrade(req, anonDenied);
    expect(user).toBeTruthy();
    expect(user.id).toBe('u1');
  });

  test('falls back to anonymous when anonymous access is enabled and no token', async () => {
    const user = await authenticateUpgrade({ headers: {} }, anonAllowed);
    expect(user).toEqual({ id: 'anonymous', name: 'anonymous', groups: ['anonymous'] });
  });

  test('rejects (null) when no token and anonymous access is disabled', async () => {
    expect(await authenticateUpgrade({ headers: {} }, anonDenied)).toBeNull();
  });

  test('rejects an invalid token when anonymous access is disabled', async () => {
    const req = { headers: { cookie: 'authToken=not-a-real-jwt' } };
    expect(await authenticateUpgrade(req, anonDenied)).toBeNull();
  });

  describe('the user behind a session token', () => {
    const setUsers = users =>
      configCache.setCacheEntry('config/users.json', { users, metadata: { version: '2.0.0' } });
    const cookieFor = id => {
      const { token } = generateJwt(
        { id, name: 'Alice', groups: ['users'] },
        { authMode: 'local' }
      );
      return { headers: { cookie: `authToken=${token}` } };
    };

    afterEach(() => {
      const timer = configCache.refreshTimers?.get('config/users.json');
      if (timer) clearTimeout(timer);
      configCache.refreshTimers?.delete('config/users.json');
    });

    test('is let through while the user exists and is active', async () => {
      setUsers({ u_ws_1: { id: 'u_ws_1', active: true, authMethods: ['local'] } });

      const user = await authenticateUpgrade(cookieFor('u_ws_1'), anonDenied);

      expect(user?.id).toBe('u_ws_1');
    });

    test('is refused once the user has been deleted, even when anonymous access is on', async () => {
      setUsers({});

      expect(await authenticateUpgrade(cookieFor('u_ws_gone'), anonAllowed)).toBeNull();
    });

    test('is refused once the user has been disabled', async () => {
      setUsers({ u_ws_2: { id: 'u_ws_2', active: false, authMethods: ['local'] } });

      expect(await authenticateUpgrade(cookieFor('u_ws_2'), anonAllowed)).toBeNull();
    });
  });
});

describe('ConnectionLimiter', () => {
  test('enforces the per-user cap', () => {
    const limiter = new ConnectionLimiter({ maxTotal: 10, maxPerUser: 2 });
    expect(limiter.tryAcquire('a')).toBe(true);
    expect(limiter.tryAcquire('a')).toBe(true);
    expect(limiter.tryAcquire('a')).toBe(false); // third for 'a' exceeds per-user
    expect(limiter.tryAcquire('b')).toBe(true); // other user unaffected
  });

  test('enforces the global cap across users', () => {
    const limiter = new ConnectionLimiter({ maxTotal: 2, maxPerUser: 5 });
    expect(limiter.tryAcquire('a')).toBe(true);
    expect(limiter.tryAcquire('b')).toBe(true);
    expect(limiter.tryAcquire('c')).toBe(false); // global cap reached
  });

  test('release frees a slot for the same user', () => {
    const limiter = new ConnectionLimiter({ maxTotal: 1, maxPerUser: 1 });
    expect(limiter.tryAcquire('a')).toBe(true);
    expect(limiter.tryAcquire('a')).toBe(false);
    limiter.release('a');
    expect(limiter.tryAcquire('a')).toBe(true);
  });

  test('release never drives a counter negative', () => {
    const limiter = new ConnectionLimiter({ maxTotal: 2, maxPerUser: 2 });
    limiter.release('a'); // release without acquire is a no-op
    expect(limiter.tryAcquire('a')).toBe(true);
    expect(limiter.tryAcquire('a')).toBe(true);
    expect(limiter.tryAcquire('a')).toBe(false);
  });
});

describe('upstream error diagnostics', () => {
  test('diagnoseSocketError includes the error code when the message is empty', () => {
    expect(diagnoseSocketError({ code: 'ECONNREFUSED', message: '' })).toBe(
      'Transcription service unreachable: ECONNREFUSED'
    );
  });

  test('diagnoseSocketError falls back to a generic message when nothing is set', () => {
    expect(diagnoseSocketError({})).toBe('Transcription service unreachable: connection error');
  });

  test('diagnoseSocketError never leaks the upstream address from err.message', () => {
    const msg = diagnoseSocketError({
      code: 'ECONNREFUSED',
      message: 'connect ECONNREFUSED 10.0.0.5:8000'
    });
    expect(msg).toBe('Transcription service unreachable: ECONNREFUSED');
    expect(msg).not.toMatch(/10\.0\.0\.5|8000/);
  });

  test('diagnoseUnexpectedResponse reports the HTTP status', () => {
    expect(diagnoseUnexpectedResponse({ statusCode: 502, statusMessage: 'Bad Gateway' })).toBe(
      'Transcription service rejected the connection (HTTP 502 Bad Gateway)'
    );
  });

  test('diagnoseUnexpectedResponse hints at the fix for common statuses', () => {
    expect(diagnoseUnexpectedResponse({ statusCode: 404, statusMessage: 'Not Found' })).toBe(
      'Transcription service rejected the connection (HTTP 404 Not Found): check the URL path'
    );
    expect(diagnoseUnexpectedResponse({ statusCode: 401, statusMessage: 'Unauthorized' })).toMatch(
      /check the API key$/
    );
  });

  // Issue #2612: a reverse proxy answering ws:// with its HTTP→HTTPS redirect.
  test('diagnoseUnexpectedResponse explains a redirect on ws:// as "use wss://"', () => {
    const msg = diagnoseUnexpectedResponse(
      { statusCode: 308, statusMessage: 'Permanent Redirect' },
      { url: 'ws://speech.example.com/v1/realtime' }
    );
    expect(msg).toMatch(/HTTP 308 Permanent Redirect/);
    expect(msg).toMatch(/use wss:\/\/ instead of ws:\/\//);
  });

  test('diagnoseUnexpectedResponse does not suggest wss:// when already on wss://', () => {
    const msg = diagnoseUnexpectedResponse(
      { statusCode: 301, statusMessage: 'Moved Permanently' },
      { url: 'wss://speech.example.com/v1/realtime' }
    );
    expect(msg).not.toMatch(/instead of ws:/);
    expect(msg).toMatch(/check the URL/);
  });

  test('diagnoseUpstreamClose reports an abnormal close before the handshake', () => {
    const msg = diagnoseUpstreamClose({
      gotTranscription: false,
      upstreamReady: false,
      code: 1006
    });
    expect(msg).toMatch(/closed the connection \(code 1006/);
  });

  test('diagnoseUpstreamClose is silent on a clean close after transcription', () => {
    expect(
      diagnoseUpstreamClose({ gotTranscription: true, upstreamReady: true, code: 1000 })
    ).toBeNull();
  });

  test('diagnoseUpstreamClose is silent on a clean close with nothing transcribed', () => {
    expect(
      diagnoseUpstreamClose({ gotTranscription: false, upstreamReady: true, code: 1000 })
    ).toBeNull();
  });

  test('diagnoseUpstreamClose reports an abnormal close code even after handshake', () => {
    const msg = diagnoseUpstreamClose({ gotTranscription: false, upstreamReady: true, code: 1011 });
    expect(msg).toMatch(/code 1011/);
  });
});

/**
 * Minimal ws-compatible fake for driving bridgeConnection: an EventEmitter with
 * the socket surface the bridge touches (send/close/terminate/ping/pause/resume,
 * readyState, bufferedAmount).
 */
class FakeWs extends EventEmitter {
  constructor(readyState = WebSocket.OPEN) {
    super();
    this.readyState = readyState;
    this.sent = [];
    this.bufferedAmount = 0;
    this.pings = 0;
    this.terminated = false;
  }
  send(data) {
    this.sent.push(typeof data === 'string' ? data : Buffer.from(data).toString());
  }
  close() {
    if (this.readyState >= WebSocket.CLOSING) return;
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
  terminate() {
    this.terminated = true;
    this.close();
  }
  ping() {
    this.pings += 1;
  }
  pause() {}
  resume() {}
  framesOfType(type) {
    return this.sent
      .map(s => {
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      })
      .filter(m => m && m.type === type);
  }
}

// Dictation, live and file transcription all run this path, naming a model.
describe('bridgeConnection state machine (fake sockets)', () => {
  const user = { id: 'u1', name: 'u1', permissions: { models: new Set(['voxtral']) } };
  const vllmModel = {
    id: 'voxtral',
    modelId: 'fake-model',
    url: 'ws://fake-upstream:9/v1/realtime',
    provider: 'vllm-realtime',
    modelType: 'transcription',
    enabled: true
  };
  const START = JSON.stringify({ type: 'start', modelId: 'voxtral' });

  beforeEach(() => {
    jest.useFakeTimers();
    configCache.setCacheEntry('config/platform.json', {
      jwt: { algorithm: 'HS256' },
      auth: { jwtSecret: 'realtime-stt-test-secret' }
    });
    configCache.setCacheEntry('config/models.json', [vllmModel]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    for (const key of ['config/platform.json', 'config/models.json']) {
      const timer = configCache.refreshTimers?.get(key);
      if (timer) clearTimeout(timer);
      configCache.refreshTimers?.delete(key);
    }
  });

  const setup = () => {
    const client = new FakeWs();
    const upstream = new FakeWs(WebSocket.CONNECTING);
    const limiter = new ConnectionLimiter({ maxTotal: 5, maxPerUser: 5 });
    limiter.tryAcquire(user.id);
    bridgeConnection(client, user, limiter, { createUpstream: () => upstream });
    return { client, upstream, limiter };
  };

  const openUpstream = async upstream => {
    upstream.readyState = WebSocket.OPEN;
    upstream.emit('open');
    await jest.advanceTimersByTimeAsync(0);
  };

  test('golden path: audio → session.created → ready+flush → stop → segments → done, slot released once', async () => {
    const { client, upstream, limiter } = setup();

    client.emit('message', START, false);
    client.emit('message', Buffer.from([1, 2, 3, 4]), true);
    await jest.advanceTimersByTimeAsync(0);
    await openUpstream(upstream);

    // Not initialized until the upstream announces the session.
    expect(client.framesOfType('ready')).toHaveLength(0);
    upstream.emit('message', JSON.stringify({ type: 'session.created' }));
    await jest.advanceTimersByTimeAsync(0);

    // session.update + initial commit, then the buffered audio flushes.
    expect(upstream.framesOfType('session.update')[0].model).toBe('fake-model');
    expect(upstream.framesOfType('input_audio_buffer.commit')).toHaveLength(1);
    expect(upstream.framesOfType('input_audio_buffer.append')).toHaveLength(1);
    expect(client.framesOfType('ready')).toHaveLength(1);
    // The server names what the transcript is based on (the chat badge reads
    // it) and the provider mode (a batch transcript only comes after `stop`).
    expect(client.framesOfType('ready')[0]).toEqual({
      type: 'ready',
      mode: 'stream',
      knowledgeSources: ['audio']
    });

    client.emit('message', JSON.stringify({ type: 'stop' }), false);
    await jest.advanceTimersByTimeAsync(0);
    const commits = upstream.framesOfType('input_audio_buffer.commit');
    expect(commits[commits.length - 1].final).toBe(true);

    upstream.emit('message', JSON.stringify({ type: 'transcription.delta', delta: 'hel' }));
    upstream.emit('message', JSON.stringify({ type: 'transcription.done', text: 'hello' }));
    await jest.advanceTimersByTimeAsync(0);
    expect(client.framesOfType('delta')[0].text).toBe('hel');
    expect(client.framesOfType('final')[0].text).toBe('hello');

    // Post-stop settle: done + teardown once the upstream stays quiet.
    await jest.advanceTimersByTimeAsync(2600);
    expect(client.framesOfType('done')).toHaveLength(1);
    expect(client.readyState).toBe(WebSocket.CLOSED);
    expect(upstream.readyState).toBe(WebSocket.CLOSED);
    expect(limiter.total).toBe(0);
    // Release is idempotent — a second cleanup path must not go negative.
    expect(limiter.tryAcquire(user.id)).toBe(true);
    expect(limiter.total).toBe(1);
  });

  test('session.created fallback: initializes after the fallback window when the frame never arrives', async () => {
    const { client, upstream } = setup();
    client.emit('message', START, false);
    client.emit('message', Buffer.from([1, 2]), true);
    await jest.advanceTimersByTimeAsync(0);
    await openUpstream(upstream);

    expect(client.framesOfType('ready')).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(2100);
    expect(client.framesOfType('ready')).toHaveLength(1);
    expect(upstream.framesOfType('session.update')).toHaveLength(1);
  });

  test('stop during handshake: final commit is sent after the pending flush', async () => {
    const { client, upstream } = setup();
    client.emit('message', START, false);
    client.emit('message', Buffer.from([1, 2]), true);
    client.emit('message', JSON.stringify({ type: 'stop' }), false);
    await jest.advanceTimersByTimeAsync(0);
    await openUpstream(upstream);
    upstream.emit('message', JSON.stringify({ type: 'session.created' }));
    await jest.advanceTimersByTimeAsync(0);

    const frames = upstream.sent.map(s => JSON.parse(s));
    const appendIdx = frames.findIndex(f => f.type === 'input_audio_buffer.append');
    const finalIdx = frames.findIndex(f => f.type === 'input_audio_buffer.commit' && f.final);
    expect(appendIdx).toBeGreaterThan(-1);
    expect(finalIdx).toBeGreaterThan(appendIdx);
  });

  test('unknown model: {type:"error"} with a stable code, teardown, slot released', async () => {
    configCache.setCacheEntry('config/models.json', []);
    const { client, upstream, limiter } = setup();
    client.emit('message', JSON.stringify({ type: 'start', modelId: 'nope' }), false);
    await jest.advanceTimersByTimeAsync(0);

    const errors = client.framesOfType('error');
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('unknown-model');
    expect(client.readyState).toBe(WebSocket.CLOSED);
    expect(upstream.sent).toHaveLength(0);
    expect(limiter.total).toBe(0);
  });

  test('audio without a start frame names no model: no-model error, no upstream', async () => {
    const createUpstream = jest.fn();
    const client = new FakeWs();
    const limiter = new ConnectionLimiter({ maxTotal: 5, maxPerUser: 5 });
    limiter.tryAcquire(user.id);
    bridgeConnection(client, user, limiter, { createUpstream });

    client.emit('message', Buffer.from([1, 2]), true);
    await jest.advanceTimersByTimeAsync(0);

    expect(client.framesOfType('error')[0].code).toBe('no-model');
    expect(createUpstream).not.toHaveBeenCalled();
    expect(limiter.total).toBe(0);
  });

  test('upstream socket error: client gets code-only diagnostics (no internal address)', async () => {
    const { client, upstream, limiter } = setup();
    client.emit('message', START, false);
    client.emit('message', Buffer.from([1, 2]), true);
    await jest.advanceTimersByTimeAsync(0);
    const err = new Error('connect ECONNREFUSED 10.0.0.5:8000');
    err.code = 'ECONNREFUSED';
    upstream.emit('error', err);
    await jest.advanceTimersByTimeAsync(0);

    const errors = client.framesOfType('error');
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('upstream-unreachable');
    expect(errors[0].message).not.toMatch(/10\.0\.0\.5/);
    expect(limiter.total).toBe(0);
  });

  test('keepalive terminates a client that never pongs', async () => {
    const { client, upstream, limiter } = setup();
    client.emit('message', START, false);
    client.emit('message', Buffer.from([1, 2]), true); // clears the no-audio grace
    await jest.advanceTimersByTimeAsync(0);
    await openUpstream(upstream);
    upstream.emit('message', JSON.stringify({ type: 'session.created' }));
    await jest.advanceTimersByTimeAsync(0);

    // First interval: ping sent. Second interval with no pong: terminate. The
    // idle timer must not fire first (upstream traffic keeps resetting it).
    await jest.advanceTimersByTimeAsync(25_000);
    expect(client.pings).toBe(1);
    upstream.emit('message', JSON.stringify({ type: 'session.updated' })); // keeps idle timer fresh
    await jest.advanceTimersByTimeAsync(25_000);
    expect(client.terminated).toBe(true);
    expect(limiter.total).toBe(0);
  });

  test('session duration cap closes the bridge with a session-limit error', async () => {
    configCache.setCacheEntry('config/platform.json', {
      jwt: { algorithm: 'HS256' },
      auth: { jwtSecret: 'realtime-stt-test-secret' },
      speech: { realtime: { maxSessionSeconds: 1 } }
    });
    const { client, upstream, limiter } = setup();
    client.emit('message', START, false);
    client.emit('message', Buffer.from([1, 2]), true);
    await jest.advanceTimersByTimeAsync(0);
    await openUpstream(upstream);

    await jest.advanceTimersByTimeAsync(1_100);
    const errors = client.framesOfType('error');
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('session-limit');
    expect(limiter.total).toBe(0);
  });
});

/**
 * Batch-provider mode (issue #2282).
 *
 * A batch provider (Gemini's unary transcription) has no upstream socket: the
 * bridge clears the client to stream straight away, buffers the PCM, and makes
 * one `transcribe()` call on `stop`. The browser-facing protocol is identical
 * to a streaming provider's, which is what lets the client stay unchanged.
 */
describe('bridgeConnection — Mistral realtime (fake sockets)', () => {
  const user = {
    id: 'u1',
    name: 'u1',
    permissions: { models: new Set(['voxtral-mini-transcribe-realtime']) }
  };

  const mistralModel = {
    id: 'voxtral-mini-transcribe-realtime',
    modelId: 'voxtral-mini-transcribe-realtime-2602',
    url: 'wss://api.mistral.ai/v1/audio/transcriptions/realtime',
    provider: 'mistral',
    modelType: 'transcription',
    apiKey: 'mistral-test-key',
    enabled: true
  };

  beforeEach(() => {
    jest.useFakeTimers();
    configCache.setCacheEntry('config/platform.json', {
      jwt: { algorithm: 'HS256' },
      auth: { jwtSecret: 'realtime-stt-test-secret' }
    });
    configCache.setCacheEntry('config/models.json', [mistralModel]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    for (const key of ['config/platform.json', 'config/models.json']) {
      const timer = configCache.refreshTimers?.get(key);
      if (timer) clearTimeout(timer);
      configCache.refreshTimers?.delete(key);
    }
  });

  test('golden path: session.created → session.update → audio → flush + end → deltas, done → final', async () => {
    const client = new FakeWs();
    const upstream = new FakeWs(WebSocket.CONNECTING);
    const limiter = new ConnectionLimiter({ maxTotal: 5, maxPerUser: 5 });
    limiter.tryAcquire(user.id);
    const createUpstream = jest.fn(() => upstream);
    bridgeConnection(client, user, limiter, { createUpstream });

    client.emit(
      'message',
      JSON.stringify({ type: 'start', modelId: 'voxtral-mini-transcribe-realtime' }),
      false
    );
    client.emit('message', Buffer.from([1, 2, 3, 4]), true);
    await jest.advanceTimersByTimeAsync(0);

    // The model rides in the query string, the key in a header — never in the url.
    expect(createUpstream).toHaveBeenCalledTimes(1);
    const [url, options] = createUpstream.mock.calls[0];
    expect(url).toBe(
      'wss://api.mistral.ai/v1/audio/transcriptions/realtime?model=voxtral-mini-transcribe-realtime-2602'
    );
    expect(options.headers.Authorization).toBe('Bearer mistral-test-key');

    upstream.readyState = WebSocket.OPEN;
    upstream.emit('open');
    await jest.advanceTimersByTimeAsync(0);
    // Nothing goes out before the session exists, and there is no fallback window.
    expect(upstream.sent).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(3000);
    expect(client.framesOfType('ready')).toHaveLength(0);

    upstream.emit(
      'message',
      JSON.stringify({ type: 'session.created', session: { request_id: 'r1' } })
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(upstream.framesOfType('session.update')[0]).toEqual({
      type: 'session.update',
      session: { audio_format: { encoding: 'pcm_s16le', sample_rate: 16000 } }
    });
    expect(upstream.framesOfType('input_audio.append')[0].audio).toBe(
      Buffer.from([1, 2, 3, 4]).toString('base64')
    );
    expect(client.framesOfType('ready')).toHaveLength(1);

    upstream.emit('message', JSON.stringify({ type: 'transcription.text.delta', text: 'Hallo ' }));
    upstream.emit('message', JSON.stringify({ type: 'transcription.language', language: 'de' }));
    await jest.advanceTimersByTimeAsync(0);
    expect(client.framesOfType('delta').map(f => f.text)).toEqual(['Hallo ']);

    client.emit('message', JSON.stringify({ type: 'stop' }), false);
    await jest.advanceTimersByTimeAsync(0);
    expect(upstream.framesOfType('input_audio.flush')).toHaveLength(1);
    expect(upstream.framesOfType('input_audio.end')).toHaveLength(1);

    upstream.emit(
      'message',
      JSON.stringify({ type: 'transcription.done', text: 'Hallo Welt', language: 'de' })
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(client.framesOfType('final').map(f => f.text)).toEqual(['Hallo Welt']);

    await jest.advanceTimersByTimeAsync(2600);
    expect(client.framesOfType('done')).toHaveLength(1);
    expect(limiter.total).toBe(0);
  });

  test('a keyed ws:// endpoint is refused before anything is dialed', async () => {
    configCache.setCacheEntry('config/models.json', [
      { ...mistralModel, url: 'ws://proxy.internal/v1/audio/transcriptions/realtime' }
    ]);
    const client = new FakeWs();
    const limiter = new ConnectionLimiter({ maxTotal: 5, maxPerUser: 5 });
    limiter.tryAcquire(user.id);
    const createUpstream = jest.fn(() => new FakeWs(WebSocket.CONNECTING));
    bridgeConnection(client, user, limiter, { createUpstream });

    client.emit(
      'message',
      JSON.stringify({ type: 'start', modelId: 'voxtral-mini-transcribe-realtime' }),
      false
    );
    client.emit('message', Buffer.from([1, 2]), true);
    await jest.advanceTimersByTimeAsync(0);

    expect(createUpstream).not.toHaveBeenCalled();
    expect(client.framesOfType('error')[0].code).toBe('upstream-unreachable');
    expect(limiter.total).toBe(0);
  });

  test('an upstream error frame reaches the client with its message', async () => {
    const client = new FakeWs();
    const upstream = new FakeWs(WebSocket.CONNECTING);
    const limiter = new ConnectionLimiter({ maxTotal: 5, maxPerUser: 5 });
    limiter.tryAcquire(user.id);
    bridgeConnection(client, user, limiter, { createUpstream: () => upstream });

    client.emit(
      'message',
      JSON.stringify({ type: 'start', modelId: 'voxtral-mini-transcribe-realtime' }),
      false
    );
    client.emit('message', Buffer.from([1, 2]), true);
    await jest.advanceTimersByTimeAsync(0);
    upstream.readyState = WebSocket.OPEN;
    upstream.emit('open');
    upstream.emit(
      'message',
      JSON.stringify({ type: 'error', error: { message: 'Invalid model', code: 3001 } })
    );
    await jest.advanceTimersByTimeAsync(0);

    const [error] = client.framesOfType('error');
    expect(error.code).toBe('upstream-error');
    expect(error.message).toContain('3001: Invalid model');
    expect(limiter.total).toBe(0);
  });
});

describe('bridgeConnection — batch providers', () => {
  const user = {
    id: 'u1',
    name: 'u1',
    permissions: { models: new Set(['gemini-3.5-transcribe']) }
  };

  const batchModel = {
    id: 'gemini-3.5-transcribe',
    modelId: 'gemini-3.5-transcribe',
    url: 'https://generativelanguage.googleapis.com',
    provider: 'google-transcribe',
    modelType: 'transcription',
    enabled: true
  };

  beforeEach(() => {
    jest.useFakeTimers();
    configCache.setCacheEntry('config/platform.json', {
      jwt: { algorithm: 'HS256' },
      auth: { jwtSecret: 'realtime-stt-test-secret' }
    });
    configCache.setCacheEntry('config/models.json', [batchModel]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    for (const key of ['config/platform.json', 'config/models.json']) {
      const timer = configCache.refreshTimers?.get(key);
      if (timer) clearTimeout(timer);
      configCache.refreshTimers?.delete(key);
    }
  });

  const setup = () => {
    const client = new FakeWs();
    const limiter = new ConnectionLimiter({ maxTotal: 5, maxPerUser: 5 });
    limiter.tryAcquire(user.id);
    const createUpstream = jest.fn(() => {
      throw new Error('a batch provider must never open an upstream socket');
    });
    bridgeConnection(client, user, limiter, { createUpstream });
    return { client, limiter, createUpstream };
  };

  const start = async client => {
    client.emit(
      'message',
      JSON.stringify({ type: 'start', modelId: 'gemini-3.5-transcribe' }),
      false
    );
    await jest.advanceTimersByTimeAsync(0);
  };

  test('golden path: ready without a socket → audio buffered → stop → final + done', async () => {
    const { client, limiter, createUpstream } = setup();
    const provider = getTranscriptionProvider('google-transcribe');
    const spy = jest
      .spyOn(provider, 'transcribe')
      .mockResolvedValue({ text: 'the whole transcript' });

    try {
      await start(client);
      // No handshake to wait for: the client is cleared immediately.
      expect(client.framesOfType('ready')).toHaveLength(1);
      expect(client.framesOfType('ready')[0].knowledgeSources).toEqual(['audio']);
      expect(createUpstream).not.toHaveBeenCalled();

      client.emit('message', Buffer.from([1, 2, 3, 4]), true);
      client.emit('message', Buffer.from([5, 6]), true);
      await jest.advanceTimersByTimeAsync(0);
      // Nothing is emitted while audio is still arriving.
      expect(client.framesOfType('final')).toHaveLength(0);

      client.emit('message', JSON.stringify({ type: 'stop' }), false);
      await jest.advanceTimersByTimeAsync(0);

      expect(spy).toHaveBeenCalledTimes(1);
      const call = spy.mock.calls[0][0];
      expect(call.pcm).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));
      expect(call.sampleRate).toBe(16000);
      expect(call.cfg.model).toBe('gemini-3.5-transcribe');

      const finals = client.framesOfType('final');
      expect(finals).toHaveLength(1);
      expect(finals[0].text).toBe('the whole transcript');
      expect(client.framesOfType('done')).toHaveLength(1);
      expect(limiter.total).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test('audio that arrives before the model resolves is not lost', async () => {
    const { client } = setup();
    const provider = getTranscriptionProvider('google-transcribe');
    const spy = jest.spyOn(provider, 'transcribe').mockResolvedValue({ text: 'ok' });

    try {
      // Send `start` and audio in the same tick, before resolution completes.
      client.emit(
        'message',
        JSON.stringify({ type: 'start', modelId: 'gemini-3.5-transcribe' }),
        false
      );
      client.emit('message', Buffer.from([9, 9]), true);
      await jest.advanceTimersByTimeAsync(0);

      client.emit('message', JSON.stringify({ type: 'stop' }), false);
      await jest.advanceTimersByTimeAsync(0);

      expect(spy.mock.calls[0][0].pcm).toEqual(Buffer.from([9, 9]));
    } finally {
      spy.mockRestore();
    }
  });

  test('a stop that arrives while the model is still resolving still transcribes', async () => {
    const { client } = setup();
    const provider = getTranscriptionProvider('google-transcribe');
    const spy = jest.spyOn(provider, 'transcribe').mockResolvedValue({ text: 'tail' });

    try {
      client.emit(
        'message',
        JSON.stringify({ type: 'start', modelId: 'gemini-3.5-transcribe' }),
        false
      );
      client.emit('message', Buffer.from([7]), true);
      client.emit('message', JSON.stringify({ type: 'stop' }), false);
      await jest.advanceTimersByTimeAsync(0);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(client.framesOfType('done')).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('a failed transcription is reported as an error frame, not a silent close', async () => {
    const { client, limiter } = setup();
    const provider = getTranscriptionProvider('google-transcribe');
    const spy = jest
      .spyOn(provider, 'transcribe')
      .mockRejectedValue(new Error('Gemini transcription request failed (HTTP 429)'));

    try {
      await start(client);
      client.emit('message', Buffer.from([1, 2]), true);
      client.emit('message', JSON.stringify({ type: 'stop' }), false);
      await jest.advanceTimersByTimeAsync(0);

      const errors = client.framesOfType('error');
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('upstream-error');
      expect(errors[0].message).toMatch(/HTTP 429/);
      expect(limiter.total).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test('the per-connection byte cap rejects an over-long recording', async () => {
    configCache.setCacheEntry('config/platform.json', {
      jwt: { algorithm: 'HS256' },
      auth: { jwtSecret: 'realtime-stt-test-secret' },
      speech: { realtime: { maxBufferedAudioBytes: 8 } }
    });
    const { client, limiter } = setup();
    const provider = getTranscriptionProvider('google-transcribe');
    const spy = jest.spyOn(provider, 'transcribe').mockResolvedValue({ text: 'never' });

    try {
      await start(client);
      client.emit('message', Buffer.alloc(6), true);
      client.emit('message', Buffer.alloc(6), true); // 12 > 8
      await jest.advanceTimersByTimeAsync(0);

      const errors = client.framesOfType('error');
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('audio-too-long');
      expect(spy).not.toHaveBeenCalled();
      expect(limiter.total).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test('hitting the cap while draining buffered audio does not leak the global budget', async () => {
    // The per-connection cap can be hit part-way through draining the audio
    // captured while the model was still resolving. Cleanup gives this
    // connection's bytes back to the process-wide budget once; buffering the
    // remaining chunks afterwards would re-charge them with nothing left to
    // release them again, permanently shrinking the budget for every later
    // session. The total cap is set tiny here so a few bytes of leak per run
    // become visible as a switch from `audio-too-long` to `server-busy`.
    configCache.setCacheEntry('config/platform.json', {
      jwt: { algorithm: 'HS256' },
      auth: { jwtSecret: 'realtime-stt-test-secret' },
      speech: { realtime: { maxBufferedAudioBytes: 8, maxBufferedAudioBytesTotal: 32 } }
    });

    for (let run = 0; run < 10; run += 1) {
      const { client } = setup();
      client.emit(
        'message',
        JSON.stringify({ type: 'start', modelId: 'gemini-3.5-transcribe' }),
        false
      );
      // Three chunks arrive before resolution finishes, so all three are drained
      // from `pending` in one loop — the second trips the 8-byte per-connection
      // cap, and the third must not be charged to the global budget after that.
      for (let i = 0; i < 3; i += 1) client.emit('message', Buffer.alloc(6), true);
      await jest.advanceTimersByTimeAsync(0);

      const errors = client.framesOfType('error');
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('audio-too-long');
    }
  });

  test('the idle timeout does not fire while a batch request is in flight', async () => {
    const { client } = setup();
    const provider = getTranscriptionProvider('google-transcribe');
    // A long recording can take minutes to come back — well past IDLE_TIMEOUT_MS.
    let resolveTranscribe;
    const spy = jest
      .spyOn(provider, 'transcribe')
      .mockReturnValue(new Promise(resolve => (resolveTranscribe = resolve)));

    try {
      // Simulate a real browser, which auto-pongs the keepalive ping per
      // RFC 6455 — otherwise the keepalive (not the idle timer) closes us.
      client.ping = () => {
        client.pings += 1;
        client.emit('pong');
      };

      await start(client);
      client.emit('message', Buffer.from([1, 2]), true);
      client.emit('message', JSON.stringify({ type: 'stop' }), false);
      await jest.advanceTimersByTimeAsync(0);

      // Two full idle windows pass with no upstream traffic.
      await jest.advanceTimersByTimeAsync(150_000);
      expect(client.readyState).toBe(WebSocket.OPEN);
      expect(client.pings).toBeGreaterThan(1);
      expect(client.framesOfType('error')).toHaveLength(0);

      resolveTranscribe({ text: 'finally' });
      await jest.advanceTimersByTimeAsync(0);
      expect(client.framesOfType('final')[0].text).toBe('finally');
    } finally {
      spy.mockRestore();
    }
  });

  test('a client that disconnects mid-request gets no frames and frees its slot', async () => {
    const { client, limiter } = setup();
    const provider = getTranscriptionProvider('google-transcribe');
    let rejectTranscribe;
    const spy = jest.spyOn(provider, 'transcribe').mockImplementation(({ signal }) => {
      return new Promise((_resolve, reject) => {
        rejectTranscribe = reject;
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });

    try {
      await start(client);
      client.emit('message', Buffer.from([1, 2]), true);
      client.emit('message', JSON.stringify({ type: 'stop' }), false);
      await jest.advanceTimersByTimeAsync(0);

      client.close();
      await jest.advanceTimersByTimeAsync(0);

      expect(client.framesOfType('error')).toHaveLength(0);
      expect(client.framesOfType('final')).toHaveLength(0);
      expect(limiter.total).toBe(0);
      expect(typeof rejectTranscribe).toBe('function');
    } finally {
      spy.mockRestore();
    }
  });
});

// The admin "Test" action for a transcription model, against a real local
// socket server for the streaming providers.
describe('testTranscriptionModel', () => {
  let server;
  let url;

  const listen = handler =>
    new Promise(resolve => {
      server = http.createServer();
      handler(server);
      server.listen(0, '127.0.0.1', () => {
        url = `ws://127.0.0.1:${server.address().port}/v1/realtime`;
        resolve();
      });
    });
  const model = (overrides = {}) => ({
    id: 'voxtral',
    modelId: 'm',
    url,
    provider: 'vllm-realtime',
    modelType: 'transcription',
    enabled: true,
    ...overrides
  });

  afterEach(async () => {
    await new Promise(resolve => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  // Issue #2612: previously surfaced as "Connection failed: Unexpected server response: 308".
  test('explains a redirect instead of reporting a bare status code', async () => {
    await listen(srv =>
      srv.on('upgrade', (_req, socket) => {
        socket.end(
          'HTTP/1.1 308 Permanent Redirect\r\nLocation: https://internal.example/v1/realtime\r\nContent-Length: 0\r\n\r\n'
        );
      })
    );

    const result = await testTranscriptionModel(model(), { timeoutMs: 3000 });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/HTTP 308/);
    expect(result.message).toMatch(/use wss:\/\//);
    // The redirect target may name an internal host; it is not echoed.
    expect(result.message).not.toMatch(/internal\.example/);
  });

  test('passes once the endpoint starts the session', async () => {
    await listen(srv => {
      const wss = new WebSocketServer({ server: srv });
      wss.on('connection', ws => ws.send(JSON.stringify({ type: 'session.created' })));
    });

    const result = await testTranscriptionModel(model(), { timeoutMs: 3000 });
    expect(result).toEqual({ ok: true, message: 'Connected — the endpoint started a session' });
  });

  test('reports an error frame from the endpoint', async () => {
    await listen(srv => {
      const wss = new WebSocketServer({ server: srv });
      wss.on('connection', ws => ws.send(JSON.stringify({ type: 'error', error: 'bad model' })));
    });

    const result = await testTranscriptionModel(model(), { timeoutMs: 3000 });
    expect(result).toEqual({ ok: false, message: 'Endpoint error: bad model' });
  });

  test('a provider that always starts a session fails when it never does', async () => {
    await listen(srv => new WebSocketServer({ server: srv }));
    const result = await testTranscriptionModel(model({ provider: 'mistral' }), {
      timeoutMs: 300
    });
    expect(result).toEqual({
      ok: false,
      message: 'Connected, but the endpoint never started a session'
    });
  });

  test('reports the reason the endpoint closed with', async () => {
    await listen(srv => {
      const wss = new WebSocketServer({ server: srv });
      wss.on('connection', ws => ws.close(1008, 'API key not valid'));
    });
    const result = await testTranscriptionModel(model(), { timeoutMs: 3000 });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/1008: API key not valid/);
  });

  test('a batch model transcribes a second of silence', async () => {
    const provider = getTranscriptionProvider('google-transcribe');
    const spy = jest.spyOn(provider, 'transcribe').mockResolvedValue({ text: '' });
    try {
      const batch = model({
        provider: 'google-transcribe',
        url: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'k'
      });
      expect(await testTranscriptionModel(batch)).toEqual({
        ok: true,
        message: 'Transcribed a second of silence'
      });
      expect(spy.mock.calls[0][0].pcm).toHaveLength(32000);

      spy.mockRejectedValueOnce(new Error('API key not valid'));
      expect(await testTranscriptionModel(batch)).toEqual({
        ok: false,
        message: 'Transcription failed: API key not valid'
      });
    } finally {
      spy.mockRestore();
    }
  });

  test('an unknown provider or a missing URL fails without dialling', async () => {
    expect((await testTranscriptionModel(model({ provider: 'nope' }))).message).toMatch(
      /Unsupported transcription provider: nope/
    );
    expect(await testTranscriptionModel(model({ url: '' }))).toEqual({
      ok: false,
      message: 'The model has no endpoint URL'
    });
  });
});
