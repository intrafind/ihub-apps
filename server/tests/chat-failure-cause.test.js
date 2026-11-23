// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A failed chat turn names the cause of its model call (`failureCause`) with
 * the keys the admin model test uses, so the chat can say "the certificate is
 * not trusted" instead of "openai API service error". The host that was called
 * and the socket or certificate code reach an administrator only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chatFailureCause, describeChatError } from '../services/chat/chatErrors.js';
import { LLMError, LLM_ERROR_CODES } from '../services/loop/contracts/errors.js';
import { toLLMError } from '../services/loop/LLMClient.js';

const model = {
  id: 'corp-gpt',
  provider: 'openai',
  url: 'https://llm.corp.local:8443/v1/chat/completions'
};

/** What undici throws for a server whose certificate chain ends in a private CA. */
function untrustedCertificateError() {
  const socketError = Object.assign(new Error('self-signed certificate in certificate chain'), {
    code: 'SELF_SIGNED_CERT_IN_CHAIN'
  });
  return toLLMError(Object.assign(new TypeError('fetch failed'), { cause: socketError }), {
    model
  });
}

/** An `LLMError` as `LLMClient._httpError` builds it from an upstream HTTP status. */
function httpError(status, code, providerCode) {
  return new LLMError(`status ${status}`, {
    code,
    providerCode,
    status,
    provider: model.provider,
    modelId: model.id
  });
}

test('an untrusted TLS certificate is certificateUntrusted; the host and code go to an admin only', () => {
  const err = untrustedCertificateError();
  assert.equal(err.code, LLM_ERROR_CODES.NETWORK, 'precondition: fetch failed is a network error');

  assert.deepEqual(chatFailureCause(err, { model }), { failureCause: 'certificateUntrusted' });
  assert.deepEqual(chatFailureCause(err, { model, revealEndpoint: true }), {
    failureCause: 'certificateUntrusted',
    host: 'llm.corp.local:8443',
    errorCode: 'SELF_SIGNED_CERT_IN_CHAIN'
  });
});

test('a 401 is authenticationFailed, and apiKeyRequired when the model has no key', () => {
  const err = httpError(401, LLM_ERROR_CODES.AUTH_FAILED, 'AUTH_FAILED');
  assert.deepEqual(chatFailureCause(err, { model }), {
    failureCause: 'authenticationFailed',
    upstreamStatus: 401
  });
  assert.deepEqual(chatFailureCause(err, { model, keyless: true }), {
    failureCause: 'apiKeyRequired',
    upstreamStatus: 401
  });
});

test('a 404 is modelNotFound', () => {
  const err = httpError(404, LLM_ERROR_CODES.MODEL_NOT_FOUND, 'MODEL_NOT_FOUND');
  assert.deepEqual(chatFailureCause(err, { model }), {
    failureCause: 'modelNotFound',
    upstreamStatus: 404
  });
});

test('an upstream 5xx is serverError with its status', () => {
  for (const [status, providerCode] of [
    [500, 'SERVICE_ERROR'],
    [502, 'SERVICE_ERROR'],
    [503, 'SERVICE_UNAVAILABLE']
  ]) {
    const err = httpError(status, LLM_ERROR_CODES.PROVIDER_ERROR, providerCode);
    assert.deepEqual(chatFailureCause(err, { model }), {
      failureCause: 'serverError',
      upstreamStatus: status
    });
  }
});

test('a 429 is rateLimitExceeded', () => {
  const err = httpError(429, LLM_ERROR_CODES.RATE_LIMITED, 'RATE_LIMIT');
  assert.equal(chatFailureCause(err, { model }).failureCause, 'rateLimitExceeded');
});

test('a timeout is requestTimeout; a connect that never answered is connectionTimeout', () => {
  const slow = toLLMError(new Error('aborted'), { model, timedOut: true, timeoutMs: 1000 });
  assert.deepEqual(chatFailureCause(slow, { model }), { failureCause: 'requestTimeout' });

  const blackholed = toLLMError(
    Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
    }),
    { model }
  );
  assert.equal(chatFailureCause(blackholed, { model }).failureCause, 'connectionTimeout');
  assert.equal(
    chatFailureCause(blackholed, { model, revealEndpoint: true }).errorCode,
    'UND_ERR_CONNECT_TIMEOUT'
  );
});

test('a model without a key configured is apiKeyNotConfigured', () => {
  const err = new LLMError('API key for openai not found', {
    code: LLM_ERROR_CODES.AUTH_FAILED,
    providerCode: 'API_KEY_MISSING'
  });
  assert.deepEqual(chatFailureCause(err, { model }), { failureCause: 'apiKeyNotConfigured' });
});

test('failures that are not the endpoint’s fault carry no cause', () => {
  const causeless = [
    httpError(400, LLM_ERROR_CODES.CONTEXT_WINDOW_EXCEEDED, 'CONTEXT_WINDOW_EXCEEDED'),
    httpError(503, LLM_ERROR_CODES.CONTEXT_WINDOW_EXCEEDED, 'CONTEXT_WINDOW_EXCEEDED'),
    httpError(400, LLM_ERROR_CODES.INVALID_REQUEST, 'INVALID_REQUEST'),
    new LLMError('quota', { code: LLM_ERROR_CODES.QUOTA_EXCEEDED }),
    toLLMError(new Error('stalled'), {
      model,
      streamIdleTimedOut: true,
      streamIdleTimeoutMs: 1000
    }),
    Object.assign(new Error('tool failed'), { code: 'TOOL_ERROR' }),
    null
  ];
  for (const err of causeless) {
    assert.equal(chatFailureCause(err, { model, revealEndpoint: true }), null, String(err?.code));
  }
});

test('describeChatError keeps its message and adds the failure; a user never gets the host', async () => {
  const err = httpError(502, LLM_ERROR_CODES.PROVIDER_ERROR, 'SERVICE_ERROR');
  const forUser = await describeChatError(err, { model, language: 'en' });
  assert.equal(forUser.message, 'status 502', 'the message stays the fallback');
  assert.deepEqual(forUser.failure, { failureCause: 'serverError', upstreamStatus: 502 });
  assert.equal(JSON.stringify(forUser.failure).includes('llm.corp.local'), false);

  const forAdmin = await describeChatError(err, { model, language: 'en', revealEndpoint: true });
  assert.deepEqual(forAdmin.failure, {
    failureCause: 'serverError',
    upstreamStatus: 502,
    host: 'llm.corp.local:8443'
  });
});

/** What undici throws when the model host does not resolve. */
function dnsError() {
  const socketError = Object.assign(new Error('getaddrinfo ENOTFOUND llm.corp.local'), {
    code: 'ENOTFOUND',
    hostname: 'llm.corp.local'
  });
  return toLLMError(Object.assign(new TypeError('fetch failed'), { cause: socketError }), {
    model
  });
}

/** Translations the way `ErrorHandler.getLocalizedError` returns them, with the params shown. */
async function getLocalizedError(key, params) {
  return `${key} ${JSON.stringify(params)}`;
}

test('a user never gets the raw failure text; an administrator does, live only', async () => {
  const err = dnsError();
  const forUser = await describeChatError(err, { model, language: 'en', getLocalizedError });
  for (const text of [forUser.message, forUser.storedMessage, JSON.stringify(forUser.details)]) {
    assert.equal(String(text).includes('llm.corp.local'), false, text);
    assert.equal(String(text).includes('ENOTFOUND'), false, text);
  }
  assert.match(forUser.message, /^dnsResolutionFailedNoHost /);
  assert.equal(forUser.details, undefined);
  assert.match(forUser.logMessage + forUser.logDetails, /ENOTFOUND llm\.corp\.local/);

  const forAdmin = await describeChatError(err, {
    model,
    language: 'en',
    getLocalizedError,
    revealEndpoint: true
  });
  assert.match(forAdmin.message, /llm\.corp\.local/, 'the live message names the host');
  assert.match(forAdmin.details, /ENOTFOUND/);
  assert.equal(forAdmin.storedMessage, forUser.message, 'the stored message never does');
});

test('a network error drops the socket text for a user', async () => {
  const socketError = Object.assign(new Error('read ECONNRESET 10.0.0.7:8443'), {
    code: 'ECONNRESET'
  });
  const err = toLLMError(Object.assign(new TypeError('fetch failed'), { cause: socketError }), {
    model
  });
  const forUser = await describeChatError(err, { model, language: 'en', getLocalizedError });
  assert.match(forUser.message, /^networkErrorNoDetail /);
  assert.equal(forUser.message.includes('10.0.0.7'), false);
  const forAdmin = await describeChatError(err, {
    model,
    language: 'en',
    getLocalizedError,
    revealEndpoint: true
  });
  assert.match(
    forAdmin.message,
    /^networkError {.*"error":/,
    'an administrator keeps the raw text'
  );
});

test('without translations a user still gets no raw text', async () => {
  const forUser = await describeChatError(dnsError(), { model, language: 'en' });
  assert.equal(forUser.message, 'The model call failed.');
  assert.equal(forUser.storedMessage, 'The model call failed.');
});

test('a provider error body stays out of details for a user; a usage limit keeps its figures', async () => {
  const err = new LLMError('openai API service error.', {
    code: LLM_ERROR_CODES.PROVIDER_ERROR,
    providerCode: 'SERVICE_ERROR',
    status: 500,
    details: '{"error":{"message":"internal: shard db-7.corp failed"}}'
  });
  const forUser = await describeChatError(err, { model, language: 'en', getLocalizedError });
  assert.equal(forUser.message, 'openai API service error.', 'the translated sentence stays');
  assert.equal(forUser.details, undefined);
  assert.match(forUser.logDetails, /db-7\.corp/);

  const quota = new LLMError('quota', {
    code: LLM_ERROR_CODES.QUOTA_EXCEEDED,
    details: { scope: 'check', window: 'day', limit: 10 }
  });
  const quotaForUser = await describeChatError(quota, { model, language: 'en' });
  assert.deepEqual(quotaForUser.details, { scope: 'check', window: 'day', limit: 10 });
});
