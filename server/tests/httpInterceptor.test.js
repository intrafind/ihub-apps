// Plain-node test (node server/tests/httpInterceptor.test.js).
//
// The HTTP interceptor writes raw wire data to the log, which makes it the one
// logging feature that can leak a credential. Most of what follows is
// therefore about redaction and about the guards that stop capture from
// becoming a memory or privacy problem:
//
//   - credentials never reach the log unless raw mode is explicitly on
//   - bodies are capped, and the cap is visible in the record
//   - allow/denylists select traffic the way the config claims
//   - streamed responses are never buffered
//   - a disabled interceptor does nothing at all
//   - an inbound request and the outbound calls it caused share a requestId
//   - capture stops on its own once autoDisableAfterMinutes has elapsed

import assert from 'assert';
import http from 'node:http';
import { runWithContext } from '../utils/requestContext.js';

// The interceptor reads its config through configCache and emits through the
// logger. Both are stubbed at the module level so the test drives the config
// directly and can assert on what was logged.
const { default: configCache } = await import('../configCache.js');
const { default: logger } = await import('../utils/logger.js');

let platformConfig = {};
configCache.getPlatform = () => platformConfig;

const emitted = [];
const realDebug = logger.debug;
const realInfo = logger.info;
logger.debug = (message, meta) => emitted.push({ level: 'debug', message, ...meta });
logger.info = (message, meta) => emitted.push({ level: 'info', message, ...meta });

const interceptor = await import('../utils/httpInterceptor.js');
const {
  isInboundEnabled,
  isOutboundEnabled,
  recordInbound,
  recordOutbound,
  redactUrl,
  redactHeaders,
  redactBody,
  isCapturableContentType,
  isStreamContentType,
  interceptedFetch,
  resetHttpInterceptorForTests,
  setEnabledSinceForTests,
  STREAM_BODY_MARKER
} = interceptor;

const { httpInterceptorMiddleware } = await import('../middleware/httpInterceptor.js');

/** Replace the whole logging.http block and drop any memoised state. */
function setHttpConfig(http) {
  platformConfig = { logging: { http } };
  resetHttpInterceptorForTests();
  emitted.length = 0;
}

const ALL_ON = {
  inbound: {
    enabled: true,
    includeHeaders: true,
    includeRequestBody: true,
    includeResponseBody: true
  },
  outbound: {
    enabled: true,
    includeHeaders: true,
    includeRequestBody: true,
    includeResponseBody: true
  },
  maxBodyBytes: 8192,
  rawBodies: false,
  autoDisableAfterMinutes: 60
};

let failed = false;
const check = async (label, fn) => {
  try {
    await fn();
    console.log(`✅ ${label}`);
  } catch (error) {
    failed = true;
    console.error(`❌ ${label}\n   ${error.stack || error.message}`);
  }
};

const records = () => emitted.filter(e => e.component === 'HttpInterceptor' && e.direction);

// ---------------------------------------------------------------------------
// Redaction — URLs
// ---------------------------------------------------------------------------

await check('redactUrl masks credential query parameters and basic-auth userinfo', () => {
  assert.strictEqual(
    redactUrl('https://generativelanguage.googleapis.com/v1?key=AIzaSyABC123'),
    'https://generativelanguage.googleapis.com/v1?key=[REDACTED]'
  );
  assert.strictEqual(
    redactUrl('https://api.example.com/x?model=gpt-4&access_token=abc&page=2'),
    'https://api.example.com/x?model=gpt-4&access_token=[REDACTED]&page=2'
  );
  assert.strictEqual(
    redactUrl('http://user:hunter2@internal.example.com/path'),
    'http://[REDACTED]@internal.example.com/path'
  );
  // Non-secret parameters must survive; a wire log that hides the model name
  // is useless for the thing it is most often used for.
  assert.strictEqual(
    redactUrl('https://api.example.com/v1?model=claude&stream=true'),
    'https://api.example.com/v1?model=claude&stream=true'
  );
});

// ---------------------------------------------------------------------------
// Redaction — headers
// ---------------------------------------------------------------------------

await check('redactHeaders masks credentials but keeps every header name', () => {
  const out = redactHeaders({
    Authorization: 'Bearer sk-proj-abcdefghijklmnop',
    'x-api-key': 'sk-ant-api03-verylongkeyvalue',
    'anthropic-api-key': 'sk-ant-secret-value',
    'content-type': 'application/json',
    'user-agent': 'iHub/1.0',
    'anthropic-ratelimit-tokens-remaining': '39000'
  });

  assert.ok(out.Authorization.startsWith('Bearer '), 'auth scheme should survive');
  assert.ok(!out.Authorization.includes('abcdefghijklmnop'), 'bearer token must be masked');
  assert.ok(!out['x-api-key'].includes('verylongkeyvalue'), 'x-api-key must be masked');
  assert.ok(!out['anthropic-api-key'].includes('secret-value'), 'vendor api key must be masked');
  assert.strictEqual(out['content-type'], 'application/json');
  assert.strictEqual(out['user-agent'], 'iHub/1.0');
  // Rate-limit counters happen to contain the word "tokens". Masking them
  // would throw away the most useful diagnostic a provider sends.
  assert.strictEqual(out['anthropic-ratelimit-tokens-remaining'], '39000');
  // Names are always kept — a missing header is half the reason to look here.
  assert.deepStrictEqual(Object.keys(out).sort(), [
    'Authorization',
    'anthropic-api-key',
    'anthropic-ratelimit-tokens-remaining',
    'content-type',
    'user-agent',
    'x-api-key'
  ]);
});

await check('cookie values are masked while names and Set-Cookie attributes survive', () => {
  const out = redactHeaders({
    cookie: 'authToken=eyJhbGciOi.secret; theme=dark',
    'set-cookie': 'authToken=eyJhbGciOi.secret; Path=/; SameSite=Lax; HttpOnly; Max-Age=28800'
  });

  assert.strictEqual(out.cookie, 'authToken=[REDACTED]; theme=[REDACTED]');
  // Set-Cookie attributes are the answer to "why isn't this cookie sticking",
  // so only the cookie value itself is masked.
  assert.strictEqual(
    out['set-cookie'],
    'authToken=[REDACTED]; Path=/; SameSite=Lax; HttpOnly; Max-Age=28800'
  );
});

await check('redactHeaders normalises Headers instances and array-of-pairs', () => {
  const headers = new Map([
    ['authorization', 'Bearer sk-longenoughtomask'],
    ['accept', 'application/json']
  ]);
  const fromMap = redactHeaders(headers);
  assert.strictEqual(fromMap.accept, 'application/json');
  assert.ok(!fromMap.authorization.includes('longenoughtomask'));

  const fromPairs = redactHeaders([['x-api-key', 'supersecretvalue']]);
  assert.ok(!fromPairs['x-api-key'].includes('supersecretvalue'));
});

// ---------------------------------------------------------------------------
// Redaction — bodies
// ---------------------------------------------------------------------------

await check('redactBody masks credential-shaped keys in parsed objects', () => {
  const out = redactBody({
    model: 'gpt-4',
    api_key: 'sk-1234567890abcdef',
    password: 'hunter2hunter2',
    nested: { clientSecret: 'shhhhhhhhhh', keep: 'visible' },
    messages: [{ role: 'user', content: 'hello' }]
  });

  assert.ok(!out.includes('1234567890abcdef'), `api_key leaked: ${out}`);
  assert.ok(!out.includes('hunter2hunter2'), `password leaked: ${out}`);
  assert.ok(!out.includes('shhhhhhhhhh'), `clientSecret leaked: ${out}`);
  assert.ok(out.includes('"model":"gpt-4"'), 'non-secret fields must survive');
  assert.ok(out.includes('"keep":"visible"'));
  assert.ok(out.includes('hello'), 'prompt content is the point of capturing bodies');
});

await check('LLM token bookkeeping is not mistaken for an auth token', () => {
  const out = redactBody({
    maxTokens: 4096,
    promptTokens: 812,
    completionTokens: 190,
    totalTokens: 1002,
    tokenCount: 1002,
    access_token: 'ya29.averylongoauthtoken'
  });

  for (const field of ['maxTokens', 'promptTokens', 'completionTokens', 'totalTokens']) {
    assert.ok(out.includes(`"${field}":`), `${field} should be present`);
    assert.ok(!out.includes(`"${field}":"`), `${field} must not have been masked`);
  }
  assert.ok(out.includes('"tokenCount":1002'));
  assert.ok(!out.includes('averylongoauthtoken'), 'the real OAuth token must be masked');
});

await check('redactBody redacts JSON strings structurally and other text by pattern', () => {
  const json = redactBody('{"password":"hunter2hunter2","user":"admin"}');
  assert.ok(!json.includes('hunter2hunter2'));
  assert.ok(json.includes('admin'));

  const form = redactBody('username=admin&api_key=sk-abcdefghijk&lang=en');
  assert.ok(!form.includes('sk-abcdefghijk'), `form secret leaked: ${form}`);
  assert.ok(form.includes('username=admin'));
  assert.ok(form.includes('lang=en'));

  const xml = redactBody('<req><token>abcdefghijklmn</token></req>');
  assert.ok(!xml.includes('abcdefghijklmn'), `xml token leaked: ${xml}`);
});

await check('redactBody caps oversized bodies and says what it dropped', () => {
  const body = { note: 'x'.repeat(5000) };
  const out = redactBody(body, { maxBytes: 512 });
  assert.ok(Buffer.byteLength(out) < 700, `expected a capped body, got ${out.length} bytes`);
  assert.ok(
    /\[TRUNCATED 512 of \d+ bytes\]$/.test(out),
    `missing truncation note: ${out.slice(-60)}`
  );
});

await check('a body above the structural-redaction limit is still credential-safe', () => {
  // Over 256 KB the body is capped first and pattern-redacted rather than
  // parsed. The secret has to be masked on that path too.
  const filler = 'y'.repeat(300 * 1024);
  const text = JSON.stringify({ filler, api_key: 'sk-shouldnotappear' });
  const out = redactBody(text, { maxBytes: 400 * 1024 });
  assert.ok(!out.includes('sk-shouldnotappear'), 'secret leaked on the large-body path');
});

await check('maxBodyBytes: 0 means uncapped', () => {
  const out = redactBody({ note: 'x'.repeat(5000) }, { maxBytes: 0 });
  assert.ok(!out.includes('TRUNCATED'), 'an uncapped body must not be truncated');
  assert.ok(out.length > 5000);
});

await check('raw mode skips redaction and capping', () => {
  const out = redactBody({ password: 'hunter2hunter2', note: 'x'.repeat(5000) }, { raw: true });
  assert.ok(out.includes('hunter2hunter2'), 'raw mode is explicitly unredacted');
  assert.ok(!out.includes('TRUNCATED'), 'raw mode is uncapped');
});

await check('opaque bodies are named, not serialised', () => {
  assert.strictEqual(redactBody(Buffer.from('plain text')), 'plain text');
  assert.strictEqual(redactBody(new Uint8Array(64)), '[BINARY 64 bytes]');
  // express.json() leaves {} behind on every request without a JSON body.
  assert.strictEqual(redactBody({}), undefined);
  assert.strictEqual(redactBody(undefined), undefined);
  assert.strictEqual(redactBody(null), undefined);
});

// ---------------------------------------------------------------------------
// Predicates: enabled / disabled, allow / denylists
// ---------------------------------------------------------------------------

await check('a disabled interceptor selects nothing and logs nothing', () => {
  setHttpConfig(undefined); // config predates the feature entirely
  assert.strictEqual(isInboundEnabled({ method: 'GET', path: '/api/apps' }), null);
  assert.strictEqual(isOutboundEnabled('https://api.openai.com/v1/chat/completions'), null);

  setHttpConfig({ inbound: { enabled: false }, outbound: { enabled: false } });
  assert.strictEqual(isInboundEnabled({ method: 'POST', path: '/api/chat' }), null);
  assert.strictEqual(isOutboundEnabled('https://api.openai.com/v1'), null);

  // recordInbound/recordOutbound without settings must be a no-op, not a throw.
  recordInbound({ method: 'GET', url: '/api/apps' });
  recordOutbound({ url: 'https://api.openai.com/v1' });
  assert.strictEqual(records().length, 0, 'nothing should have been emitted');
});

await check('/api/health is excluded by default', () => {
  setHttpConfig({ inbound: { enabled: true } });
  assert.strictEqual(isInboundEnabled({ method: 'GET', path: '/api/health' }), null);
  // Prefix matching is by path segment, so a different route with the same
  // prefix is still captured.
  assert.ok(isInboundEnabled({ method: 'GET', path: '/api/healthcheck' }));
  assert.strictEqual(isInboundEnabled({ method: 'GET', path: '/api/health/live' }), null);
  assert.ok(isInboundEnabled({ method: 'GET', path: '/api/apps' }));
});

await check('inbound method, allowlist and denylist filters apply', () => {
  setHttpConfig({ inbound: { enabled: true, methods: ['post'] } });
  assert.ok(isInboundEnabled({ method: 'POST', path: '/api/chat' }), 'lowercase config matches');
  assert.strictEqual(isInboundEnabled({ method: 'GET', path: '/api/chat' }), null);

  setHttpConfig({
    inbound: { enabled: true, pathAllowlist: ['/api/admin'], pathDenylist: [] }
  });
  assert.ok(isInboundEnabled({ method: 'GET', path: '/api/admin/logging/config' }));
  assert.strictEqual(isInboundEnabled({ method: 'GET', path: '/api/apps' }), null);

  setHttpConfig({
    inbound: { enabled: true, pathAllowlist: ['/api'], pathDenylist: ['/api/admin'] }
  });
  assert.ok(isInboundEnabled({ method: 'GET', path: '/api/apps' }));
  assert.strictEqual(
    isInboundEnabled({ method: 'GET', path: '/api/admin/users' }),
    null,
    'denylist wins over allowlist'
  );
});

await check('outbound host allow/denylists use ssl.domainWhitelist semantics', () => {
  setHttpConfig({ outbound: { enabled: true, hostAllowlist: ['*.openai.com'] } });
  assert.ok(isOutboundEnabled('https://api.openai.com/v1/chat/completions'));
  assert.strictEqual(
    isOutboundEnabled('https://openai.com/v1'),
    null,
    '*.example.com must not match the bare domain'
  );
  assert.strictEqual(isOutboundEnabled('https://api.anthropic.com/v1/messages'), null);

  setHttpConfig({ outbound: { enabled: true, hostDenylist: ['telemetry.example.com'] } });
  assert.strictEqual(isOutboundEnabled('https://telemetry.example.com/collect'), null);
  assert.ok(isOutboundEnabled('https://api.openai.com/v1'));

  // A malformed URL can't be matched against either list, and is exactly the
  // kind of thing the wire log exists to surface — so it is still recorded.
  setHttpConfig({ outbound: { enabled: true, hostAllowlist: ['api.openai.com'] } });
  assert.ok(isOutboundEnabled('ministral'), 'an unparseable URL should still be recorded');
});

// ---------------------------------------------------------------------------
// Auto-disable
// ---------------------------------------------------------------------------

await check('capture stops once autoDisableAfterMinutes has elapsed', () => {
  setHttpConfig({ inbound: { enabled: true }, outbound: { enabled: true } });
  assert.ok(isInboundEnabled({ method: 'GET', path: '/api/apps' }), 'active inside the window');

  setEnabledSinceForTests(Date.now() - 61 * 60_000); // default window is 60 min
  assert.strictEqual(isInboundEnabled({ method: 'GET', path: '/api/apps' }), null);
  assert.strictEqual(isOutboundEnabled('https://api.openai.com/v1'), null);

  // Expiry is worth one info line so the operator sees why records stopped.
  const notices = emitted.filter(e => /auto-disabled/.test(e.message || ''));
  assert.strictEqual(notices.length, 1, 'expiry should be announced exactly once');
});

await check('autoDisableAfterMinutes: 0 never expires', () => {
  setHttpConfig({ inbound: { enabled: true }, autoDisableAfterMinutes: 0 });
  setEnabledSinceForTests(Date.now() - 30 * 24 * 60 * 60_000); // a month ago
  assert.ok(isInboundEnabled({ method: 'GET', path: '/api/apps' }));
});

// ---------------------------------------------------------------------------
// Content-type gating
// ---------------------------------------------------------------------------

await check('streamed and binary response bodies are refused, text is allowed', () => {
  assert.ok(isStreamContentType('text/event-stream'));
  assert.ok(isStreamContentType('text/event-stream; charset=utf-8'));
  assert.strictEqual(isCapturableContentType('text/event-stream'), false);

  assert.ok(isCapturableContentType('application/json'));
  assert.ok(isCapturableContentType('application/json; charset=utf-8'));
  assert.ok(isCapturableContentType('application/vnd.api+json'));
  assert.ok(isCapturableContentType('text/plain'));
  assert.ok(isCapturableContentType('application/x-www-form-urlencoded'));

  assert.strictEqual(isCapturableContentType('application/octet-stream'), false);
  assert.strictEqual(isCapturableContentType('image/png'), false);
  assert.strictEqual(isCapturableContentType('application/pdf'), false);
  assert.strictEqual(isCapturableContentType(undefined), false);
});

// ---------------------------------------------------------------------------
// Inbound middleware against a real HTTP server
// ---------------------------------------------------------------------------

/** Serve one request through the middleware and return the emitted record. */
async function serveOnce(handler, requestOptions = {}, requestBody = undefined) {
  const server = http.createServer((req, res) => {
    // Stand in for express.json() + the request context opened in setup.js.
    req.path = req.url.split('?')[0];
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      try {
        req.body = raw ? JSON.parse(raw) : {};
      } catch {
        req.body = raw;
      }
      runWithContext({ requestId: 'test-request-id' }, () => {
        httpInterceptorMiddleware(req, res, () => handler(req, res));
      });
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, ...requestOptions }, res => {
        res.resume();
        res.on('end', resolve);
        res.on('error', reject);
      });
      req.on('error', reject);
      if (requestBody) req.write(requestBody);
      req.end();
    });
    // res.on('finish') fires on the server side; give it a tick to land.
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  return records().find(r => r.direction === 'inbound');
}

await check('the inbound middleware records method, status, timing and bodies', async () => {
  setHttpConfig(ALL_ON);
  const record = await serveOnce(
    (req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, sessionId: 'sess-shouldbemasked' }));
    },
    {
      method: 'POST',
      path: '/api/chat?key=SECRETKEY',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-longtokenvalue' }
    },
    JSON.stringify({ prompt: 'hello', password: 'hunter2hunter2' })
  );

  assert.ok(record, 'a record should have been emitted');
  assert.strictEqual(record.method, 'POST');
  assert.strictEqual(record.status, 200);
  assert.strictEqual(record.requestId, 'test-request-id');
  assert.ok(typeof record.durationMs === 'number' && record.durationMs >= 0);
  assert.ok(record.url.includes('key=[REDACTED]'), `URL secret leaked: ${record.url}`);
  assert.ok(!JSON.stringify(record).includes('SECRETKEY'));
  assert.ok(!record.requestHeaders.authorization.includes('longtokenvalue'));
  assert.ok(record.requestBody.includes('hello'), 'prompt should be captured');
  assert.ok(!record.requestBody.includes('hunter2hunter2'), 'body secret leaked');
  assert.ok(record.responseBody.includes('"ok":true'), 'response body should be captured');
  assert.ok(
    !record.responseBody.includes('sess-shouldbemasked'),
    'response bodies are redacted too'
  );
});

await check('an SSE response is marked, never buffered', async () => {
  setHttpConfig(ALL_ON);
  const record = await serveOnce((req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.write('data: {"chunk":1}\n\n');
    res.write(`data: ${'x'.repeat(200000)}\n\n`);
    res.end();
  });

  assert.ok(record, 'a record should still be emitted for a stream');
  assert.strictEqual(record.responseBody, STREAM_BODY_MARKER);
  assert.strictEqual(record.status, 200);
});

await check('a static asset request is skipped', async () => {
  setHttpConfig(ALL_ON);
  const record = await serveOnce(
    (req, res) => {
      res.setHeader('content-type', 'application/javascript');
      res.end('console.log(1)');
    },
    { method: 'GET', path: '/assets/index-abc123.js' }
  );
  assert.strictEqual(record, undefined, 'static assets should not be recorded');
});

await check('response bodies are not captured when the switch is off', async () => {
  setHttpConfig({
    ...ALL_ON,
    inbound: { ...ALL_ON.inbound, includeRequestBody: false, includeResponseBody: false }
  });
  const record = await serveOnce((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ secretish: 'should-not-appear' }));
  });

  assert.ok(record, 'the record itself is still written');
  assert.strictEqual(record.responseBody, undefined);
  assert.strictEqual(record.requestBody, undefined);
  assert.ok(record.responseHeaders, 'headers are independent of bodies');
  assert.ok(!JSON.stringify(record).includes('should-not-appear'));
});

// ---------------------------------------------------------------------------
// Outbound wrapper
// ---------------------------------------------------------------------------

/** Minimal node-fetch-shaped response with a working clone()/tee. */
function fakeResponse(body, { status = 200, contentType = 'application/json' } = {}) {
  const make = text => ({
    status,
    headers: new Map([['content-type', contentType]]),
    clone: () => make(text),
    body: {
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(text);
      },
      destroy() {}
    }
  });
  return make(body);
}

await check('interceptedFetch records request, response and timing', async () => {
  setHttpConfig(ALL_ON);
  const fetchFn = async () =>
    fakeResponse(JSON.stringify({ choices: [], access_token: 'ya29.leakcheck' }));

  const response = await interceptedFetch(
    fetchFn,
    'https://api.openai.com/v1/chat/completions?key=URLSECRET',
    {
      method: 'POST',
      headers: { authorization: 'Bearer sk-outboundsecret' },
      body: JSON.stringify({ model: 'gpt-4', api_key: 'sk-bodysecret' })
    },
    isOutboundEnabled('https://api.openai.com/v1/chat/completions'),
    'httpFetch'
  );

  assert.strictEqual(response.status, 200, 'the caller still gets its response');
  // The response body is peeked off a detached clone, so the record lands a
  // tick later than the call returns.
  await new Promise(resolve => setTimeout(resolve, 20));

  const record = records().find(r => r.direction === 'outbound');
  assert.ok(record, 'an outbound record should have been emitted');
  assert.strictEqual(record.transport, 'httpFetch');
  assert.strictEqual(record.method, 'POST');
  assert.strictEqual(record.status, 200);
  assert.ok(typeof record.durationMs === 'number');
  assert.ok(record.url.includes('key=[REDACTED]'));

  const serialized = JSON.stringify(record);
  assert.ok(!serialized.includes('URLSECRET'), 'URL secret leaked');
  assert.ok(!serialized.includes('sk-outboundsecret'), 'header secret leaked');
  assert.ok(!serialized.includes('sk-bodysecret'), 'request-body secret leaked');
  assert.ok(!serialized.includes('ya29.leakcheck'), 'response-body secret leaked');
  assert.ok(record.requestBody.includes('gpt-4'), 'the model should still be visible');
  assert.ok(record.responseBody.includes('choices'));
});

await check('a streamed outbound response is marked without being read', async () => {
  setHttpConfig(ALL_ON);
  let cloned = false;
  const response = {
    status: 200,
    headers: new Map([['content-type', 'text/event-stream']]),
    clone: () => {
      cloned = true;
      throw new Error('clone() must not be called for a stream');
    },
    body: null
  };

  await interceptedFetch(
    async () => response,
    'https://api.anthropic.com/v1/messages',
    { method: 'POST' },
    isOutboundEnabled('https://api.anthropic.com/v1/messages'),
    'httpFetch'
  );

  const record = records().find(r => r.direction === 'outbound');
  assert.strictEqual(cloned, false, 'a streamed body must never be teed');
  assert.strictEqual(record.responseBody, STREAM_BODY_MARKER);
});

await check('a failed outbound call is recorded with its error and rethrown', async () => {
  setHttpConfig(ALL_ON);
  await assert.rejects(
    interceptedFetch(
      async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:11434');
      },
      'http://localhost:11434/v1/chat/completions',
      { method: 'POST' },
      isOutboundEnabled('http://localhost:11434/v1/chat/completions'),
      'httpFetch'
    ),
    /ECONNREFUSED/
  );

  const record = records().find(r => r.direction === 'outbound');
  assert.ok(record, 'a failed call must still be recorded');
  assert.match(record.error, /ECONNREFUSED/);
  assert.strictEqual(record.status, undefined);
});

await check('an inbound request and the outbound calls it caused share a requestId', async () => {
  setHttpConfig(ALL_ON);
  await new Promise(resolve => {
    runWithContext({ requestId: 'shared-correlation-id' }, async () => {
      recordInbound({
        settings: isInboundEnabled({ method: 'POST', path: '/api/chat' }),
        method: 'POST',
        url: '/api/chat',
        status: 200,
        durationMs: 12
      });
      await interceptedFetch(
        async () => fakeResponse('{"ok":true}'),
        'https://api.openai.com/v1/chat/completions',
        { method: 'POST' },
        isOutboundEnabled('https://api.openai.com/v1/chat/completions'),
        'httpFetch'
      );
      setTimeout(resolve, 20);
    });
  });

  const ids = records().map(r => r.requestId);
  assert.ok(ids.length >= 2, `expected both directions, got ${ids.length}`);
  assert.ok(
    ids.every(id => id === 'shared-correlation-id'),
    `requestIds diverged: ${JSON.stringify(ids)}`
  );
});

await check('raw mode reaches the emitted record end to end', async () => {
  setHttpConfig({ ...ALL_ON, rawBodies: true, maxBodyBytes: 8 });
  recordOutbound({
    settings: isOutboundEnabled('https://api.openai.com/v1'),
    transport: 'httpFetch',
    method: 'POST',
    url: 'https://api.openai.com/v1?key=RAWSECRET',
    headers: { authorization: 'Bearer sk-rawmode-token' },
    body: JSON.stringify({ password: 'hunter2hunter2' }),
    status: 200
  });

  const record = records().find(r => r.direction === 'outbound');
  assert.ok(record.url.includes('RAWSECRET'), 'raw mode leaves the URL alone by design');
  assert.strictEqual(record.requestHeaders.authorization, 'Bearer sk-rawmode-token');
  assert.ok(record.requestBody.includes('hunter2hunter2'));
  assert.ok(!record.requestBody.includes('TRUNCATED'), 'raw mode ignores maxBodyBytes');
});

// ---------------------------------------------------------------------------
// httpFetch: the transport/observation split
// ---------------------------------------------------------------------------
//
// httpFetch was split into proxiedFetch (applies proxy/SSL, sends) plus a thin
// httpFetch wrapper (observes). These check the seam did not drop anything:
// scheme validation moved into proxiedFetch, and interception has to be
// transparent to the caller in both directions.

const { httpFetch } = await import('../utils/httpConfig.js');

/** Serve one canned response and return its URL. */
async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

await check('httpFetch still rejects a non-http(s) scheme, interception on or off', async () => {
  setHttpConfig(undefined);
  await assert.rejects(httpFetch('ministral'), /Unsupported URL scheme "ministral"/);

  // Enabled too: the predicate runs first now, so a bad scheme must still reach
  // the caller as the same error rather than being swallowed by the wrapper.
  setHttpConfig(ALL_ON);
  await assert.rejects(httpFetch('ministral'), /Unsupported URL scheme "ministral"/);
  await new Promise(resolve => setTimeout(resolve, 20));
  const record = records().find(r => r.direction === 'outbound');
  assert.ok(record, 'a rejected scheme is worth a record — it is a real failure mode');
  assert.match(record.error, /Unsupported URL scheme/);
});

await check('httpFetch is transparent when the interceptor is disabled', async () => {
  setHttpConfig({ inbound: { enabled: false }, outbound: { enabled: false } });
  await withServer(
    (req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, path: req.url, method: req.method }));
    },
    async base => {
      const response = await httpFetch(`${base}/v1/models`, { method: 'GET' });
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(await response.json(), {
        ok: true,
        path: '/v1/models',
        method: 'GET'
      });
    }
  );
  assert.strictEqual(records().length, 0, 'a disabled interceptor must emit nothing');
});

await check('httpFetch is transparent when the interceptor is enabled, and records', async () => {
  setHttpConfig(ALL_ON);
  await withServer(
    (req, res) => {
      let raw = '';
      req.on('data', chunk => (raw += chunk));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ echoed: JSON.parse(raw || '{}') }));
      });
    },
    async base => {
      const response = await httpFetch(`${base}/v1/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer sk-transparency' },
        body: JSON.stringify({ model: 'gpt-4' })
      });
      // The caller's body must still be readable: the interceptor peeks a clone.
      assert.deepStrictEqual(await response.json(), { echoed: { model: 'gpt-4' } });
    }
  );

  await new Promise(resolve => setTimeout(resolve, 30));
  const record = records().find(r => r.direction === 'outbound');
  assert.ok(record, 'the call should have been recorded');
  assert.strictEqual(record.status, 200);
  assert.strictEqual(record.method, 'POST');
  assert.ok(record.requestBody.includes('gpt-4'));
  assert.ok(!JSON.stringify(record).includes('sk-transparency'), 'header secret leaked');
  // `lookup` is a proxiedFetch-only option and an agent is noise in a log; the
  // record should show what the caller asked for.
  assert.strictEqual(record.requestHeaders['content-type'], 'application/json');
});

await check("httpFetch still applies the SSRF guard's pinned DNS lookup", async () => {
  setHttpConfig(ALL_ON);
  await withServer(
    (req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    },
    async base => {
      let pinnedFor = null;
      // A hostname, not an IP literal: Node skips DNS resolution entirely for
      // `127.0.0.1`, so the lookup would never be consulted.
      const url = base.replace('127.0.0.1', 'localhost');
      const response = await httpFetch(`${url}/ping`, {
        method: 'GET',
        lookup: (hostname, opts, cb) => {
          pinnedFor = hostname;
          if (opts && opts.all) cb(null, [{ address: '127.0.0.1', family: 4 }]);
          else cb(null, '127.0.0.1', 4);
        }
      });
      assert.strictEqual(response.status, 200);
      // `lookup` is a proxiedFetch-only option: it has to reach the agent and
      // must not be forwarded to node-fetch. If the split dropped it, workflow
      // HTTP nodes would silently lose their DNS pinning.
      assert.strictEqual(pinnedFor, 'localhost', 'the pinned lookup was not applied');
    }
  );
});

logger.debug = realDebug;
logger.info = realInfo;

if (failed) {
  console.error('\nhttpInterceptor tests failed');
  process.exit(1);
}
console.log('\nAll httpInterceptor tests passed');
