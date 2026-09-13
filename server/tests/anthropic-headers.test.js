import AnthropicAdapter from '../adapters/anthropic.js';

describe('AnthropicAdapter request headers', () => {
  const model = {
    modelId: 'claude-4-sonnet',
    url: 'https://api.anthropic.com/v1/messages',
    provider: 'anthropic'
  };
  const messages = [{ role: 'user', content: 'test' }];

  test('does not send an Authorization header', async () => {
    const req = await AnthropicAdapter.createCompletionRequest(model, messages, 'test-key');

    expect(req.headers).not.toHaveProperty('Authorization');

    // A plain object key check isn't sufficient — { Authorization: undefined }
    // passes the check above but still serializes to a real wire header via
    // fetch's Headers class, which is how this bug slipped through originally.
    const headers = new Headers(req.headers);
    expect(headers.has('authorization')).toBe(false);
  });

  test('sends x-api-key and anthropic-version headers', async () => {
    const req = await AnthropicAdapter.createCompletionRequest(model, messages, 'test-key');

    expect(req.headers['x-api-key']).toBe('test-key');
    expect(req.headers['anthropic-version']).toBe('2023-06-01');
    expect(req.headers['Content-Type']).toBe('application/json');
  });
});
