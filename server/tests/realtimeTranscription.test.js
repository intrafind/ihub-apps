/**
 * Realtime speech-to-text WebSocket proxy — unit tests.
 *
 * Locks in the security-critical behavior of the upgrade path (Cross-Site
 * WebSocket Hijacking origin guard, JWT/anonymous auth), the resource-exhaustion
 * guard (per-user + global connection caps), and the upstream error-diagnostic
 * mapping. These previously lived only in throwaway verification scripts.
 */
import {
  normalizeOrigin,
  isAllowedOrigin,
  extractToken,
  authenticateUpgrade,
  ConnectionLimiter,
  diagnoseSocketError,
  diagnoseUnexpectedResponse,
  diagnoseUpstreamClose
} from '../websocket/realtimeTranscription.js';
import { generateJwt } from '../utils/tokenService.js';
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

  test('honors a wildcard CORS origin', () => {
    const req = { headers: { host: 'ihub.local', origin: 'https://anything.com' } };
    expect(isAllowedOrigin(req, { cors: { origin: ['*'] } })).toBe(true);
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
