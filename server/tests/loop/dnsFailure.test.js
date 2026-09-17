/**
 * Hostname resolution failures and connect timeouts are terminal for a model
 * call: retrying repeats the same wait and, for DNS, queues another blocking
 * getaddrinfo on the shared threadpool that stalls other callers. These specs
 * pin the classification and the resulting single attempt.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LLM_ERROR_CODES, LLMError, isLLMError } from '../../services/loop/contracts/errors.js';
import { isTransientLlmError } from '../../services/loop/llmRetry.js';
import { toLLMError } from '../../services/loop/LLMClient.js';
import { dnsTimeoutError } from '../../utils/dnsGuard.js';
import { makeClient } from './helpers/llmFixtures.js';

const messages = [{ role: 'user', content: 'hi' }];

function fetchDnsError(hostname, code = 'ENOTFOUND') {
  // Shape of node-fetch's FetchError for a getaddrinfo failure.
  return Object.assign(
    new Error(`request to http://${hostname}/v1 failed, reason: getaddrinfo ${code} ${hostname}`),
    { name: 'FetchError', type: 'system', code, errno: code, erroredSysCall: 'getaddrinfo' }
  );
}

test('DNS failures are classified as NETWORK/DNS, not as a slow-model timeout', () => {
  const guardTimeout = toLLMError(
    Object.assign(
      new Error('request failed, reason: ' + dnsTimeoutError('vllm.corp.test', 5000).message),
      {
        code: 'EAI_TIMEOUT',
        erroredSysCall: 'getaddrinfo'
      }
    ),
    { model: { id: 'local-vllm', provider: 'openai' } }
  );
  assert.equal(guardTimeout.code, LLM_ERROR_CODES.NETWORK);
  assert.equal(guardTimeout.providerCode, 'DNS');

  const notFound = toLLMError(fetchDnsError('vllm.corp.test'), {
    model: { id: 'm', provider: 'openai' }
  });
  assert.equal(notFound.code, LLM_ERROR_CODES.NETWORK);
  assert.equal(notFound.providerCode, 'DNS');
});

test('DNS failures and connect timeouts are not transient; other network faults still are', () => {
  assert.equal(isTransientLlmError(fetchDnsError('vllm.corp.test')), false);
  assert.equal(isTransientLlmError(fetchDnsError('vllm.corp.test', 'EAI_AGAIN')), false);
  assert.equal(
    isTransientLlmError(
      new LLMError('dns', { code: LLM_ERROR_CODES.NETWORK, providerCode: 'DNS' })
    ),
    false
  );
  assert.equal(
    isTransientLlmError(
      new LLMError('unreachable', {
        code: LLM_ERROR_CODES.TIMEOUT,
        providerCode: 'CONNECT_TIMEOUT'
      })
    ),
    false
  );
  assert.equal(
    isTransientLlmError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })),
    true,
    'a reset connection is still retried'
  );
  assert.equal(
    isTransientLlmError(new LLMError('slow', { code: LLM_ERROR_CODES.TIMEOUT })),
    true,
    'a plain read timeout is still retried'
  );
});

test('an unresolvable host fails after one attempt even with a retry budget', async () => {
  const { client, calls } = makeClient({
    maxRetries: 3,
    transport: () => Promise.reject(fetchDnsError('vllm.corp.test'))
  });
  await assert.rejects(client.execute({ modelId: 'oa', messages, timeoutMs: 5_000 }), err => {
    assert.ok(isLLMError(err));
    assert.equal(err.code, LLM_ERROR_CODES.NETWORK);
    assert.equal(err.providerCode, 'DNS');
    return true;
  });
  assert.equal(calls.length, 1, 'no retries for a DNS failure');
});

test('a blackholed connect fails after one attempt even with a retry budget', async () => {
  const { client, calls } = makeClient({
    connectTimeoutMs: 40,
    maxRetries: 3,
    transport: (request, ctx) =>
      new Promise((_resolve, reject) => {
        ctx.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      })
  });
  const started = Date.now();
  await assert.rejects(client.execute({ modelId: 'oa', messages, timeoutMs: 5_000 }), err => {
    assert.equal(err.code, LLM_ERROR_CODES.TIMEOUT);
    assert.equal(err.providerCode, 'CONNECT_TIMEOUT');
    return true;
  });
  assert.equal(calls.length, 1, 'no retries for a connect timeout');
  assert.ok(Date.now() - started < 1_000, 'fails after the single connect ceiling');
});
