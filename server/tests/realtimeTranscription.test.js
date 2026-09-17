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
import { WebSocket } from 'ws';
import {
  normalizeOrigin,
  isAllowedOrigin,
  extractToken,
  authenticateUpgrade,
  ConnectionLimiter,
  bridgeConnection,
  diagnoseSocketError,
  diagnoseUnexpectedResponse,
  diagnoseUpstreamClose
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
  test('accepts a valid JWT and returns the user identity', () => {
    const { token } = generateJwt({ id: 'u1', name: 'Alice', groups: ['users'] });
    const req = { headers: { cookie: `authToken=${token}` } };
    const user = authenticateUpgrade(req, anonDenied);
    expect(user).toBeTruthy();
    expect(user.id).toBe('u1');
  });

  test('falls back to anonymous when anonymous access is enabled and no token', () => {
    const user = authenticateUpgrade({ headers: {} }, anonAllowed);
    expect(user).toEqual({ id: 'anonymous', name: 'anonymous', groups: ['anonymous'] });
  });

  test('rejects (null) when no token and anonymous access is disabled', () => {
    expect(authenticateUpgrade({ headers: {} }, anonDenied)).toBeNull();
  });

  test('rejects an invalid token when anonymous access is disabled', () => {
    const req = { headers: { cookie: 'authToken=not-a-real-jwt' } };
    expect(authenticateUpgrade(req, anonDenied)).toBeNull();
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
    expect(diagnoseUnexpectedResponse({ statusCode: 404, statusMessage: 'Not Found' })).toBe(
      'Transcription service rejected the connection (HTTP 404 Not Found)'
    );
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

describe('bridgeConnection state machine (fake sockets)', () => {
  const user = { id: 'u1', name: 'u1' };

  beforeEach(() => {
    jest.useFakeTimers();
    configCache.setCacheEntry('config/platform.json', {
      jwt: { algorithm: 'HS256' },
      auth: { jwtSecret: 'realtime-stt-test-secret' },
      speech: {
        realtime: {
          enabled: true,
          url: 'ws://fake-upstream:9/v1/realtime',
          model: 'fake-model'
        }
      }
    });
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

    client.emit('message', JSON.stringify({ type: 'start' }), false);
    await jest.advanceTimersByTimeAsync(0);
    // Dictation resolves lazily: no upstream open until audio flows.
    expect(upstream.sent).toHaveLength(0);

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

  test('upstream socket error: client gets code-only diagnostics (no internal address)', async () => {
    const { client, upstream, limiter } = setup();
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
      speech: {
        realtime: {
          enabled: true,
          url: 'ws://fake-upstream:9/v1/realtime',
          model: 'fake-model',
          maxSessionSeconds: 1
        }
      }
    });
    const { client, upstream, limiter } = setup();
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
