/**
 * Simple tests for log redaction utility
 */
import assert from 'assert';
import logger from '../utils/logger.js';
import {
  redactUrl,
  redactHeaders,
  redactRequestBody,
  redactLogMessage
} from '../utils/logRedactor.js';

logger.info('Running log redaction tests...\n');

// Test redactUrl
logger.info('Testing redactUrl()...');
{
  const url = 'https://api.google.com/v1/models:generateContent?key=AIzaSyABC123xyz789';
  const redacted = redactUrl(url);
  assert.strictEqual(redacted, 'https://api.google.com/v1/models:generateContent?key=[REDACTED]');
  assert.ok(!redacted.includes('AIzaSyABC123xyz789'), 'API key should be redacted');
  logger.info('✓ Google API keys redacted correctly');

  const url2 = 'https://api.example.com?key=abc123&token=xyz789';
  const redacted2 = redactUrl(url2);
  assert.strictEqual(redacted2, 'https://api.example.com?key=[REDACTED]&token=[REDACTED]');
  logger.info('✓ Multiple API keys redacted correctly');

  const url3 = 'https://api.example.com/endpoint?param=value';
  assert.strictEqual(redactUrl(url3), url3);
  logger.info('✓ Non-sensitive URLs preserved');
}

// Test redactHeaders
logger.info('\nTesting redactHeaders()...');
{
  const headers = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer sk-1234567890abcdefghijklmnop'
  };
  const redacted = redactHeaders(headers);
  assert.strictEqual(redacted['Content-Type'], 'application/json');
  assert.ok(redacted.Authorization.includes('[REDACTED]'), 'Authorization should be redacted');
  assert.ok(
    !redacted.Authorization.includes('1234567890abcdefghijklmnop'),
    'API key should be hidden'
  );
  logger.info('✓ Authorization header redacted correctly');

  const headers2 = {
    'x-api-key': 'sk-proj-abcdefghijklmnop1234567890'
  };
  const redacted2 = redactHeaders(headers2);
  assert.ok(redacted2['x-api-key'].includes('[REDACTED]'), 'x-api-key should be redacted');
  logger.info('✓ x-api-key header redacted correctly');
}

// Test redactRequestBody
logger.info('\nTesting redactRequestBody()...');
{
  const body = {
    model: 'gpt-4',
    api_key: 'sk-1234567890',
    messages: [{ role: 'user', content: 'Hello' }]
  };
  const redacted = redactRequestBody(body);
  assert.strictEqual(redacted.model, 'gpt-4');
  assert.strictEqual(redacted.api_key, '[REDACTED]');
  assert.deepStrictEqual(redacted.messages, body.messages);
  logger.info('✓ API key fields redacted in request body');

  const body2 = {
    config: {
      apiKey: 'secret123',
      settings: {
        token: 'token456'
      }
    }
  };
  const redacted2 = redactRequestBody(body2);
  assert.strictEqual(redacted2.config.apiKey, '[REDACTED]');
  assert.strictEqual(redacted2.config.settings.token, '[REDACTED]');
  logger.info('✓ Nested sensitive fields redacted correctly');

  // Ensure original is not modified
  assert.strictEqual(body.api_key, 'sk-1234567890', 'Original should not be modified');
  logger.info('✓ Original object not modified');
}

// Test redactLogMessage
logger.info('\nTesting redactLogMessage()...');
{
  const message = 'Making request to https://api.google.com?key=AIzaSyABC123';
  const redacted = redactLogMessage(message);
  assert.ok(redacted.includes('?key=[REDACTED]'), 'URL key should be redacted');
  assert.ok(!redacted.includes('AIzaSyABC123'), 'API key should be hidden');
  logger.info('✓ URLs with API keys redacted in messages');

  const message2 = 'Authorization: Bearer sk-1234567890abcdef';
  const redacted2 = redactLogMessage(message2);
  assert.ok(redacted2.includes('Bearer [REDACTED]'), 'Bearer token should be redacted');
  assert.ok(!redacted2.includes('sk-1234567890abcdef'), 'Token should be hidden');
  logger.info('✓ Bearer tokens redacted correctly');

  const message3 = 'Using API key: sk-proj-abcdefghij1234567890';
  const redacted3 = redactLogMessage(message3);
  assert.ok(redacted3.includes('sk-[REDACTED]'), 'API key pattern should be redacted');
  assert.ok(!redacted3.includes('abcdefghij1234567890'), 'Key should be hidden');
  logger.info('✓ API key patterns redacted correctly');

  const message4 = 'Processing request with model gpt-4 and temperature 0.7';
  const redacted4 = redactLogMessage(message4);
  assert.strictEqual(redacted4, message4);
  logger.info('✓ Normal text preserved');
}

logger.info('\n✅ All log redaction tests passed!');
