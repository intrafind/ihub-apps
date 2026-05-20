import { describe, it, expect } from '@jest/globals';
import { invokeAppNonStreaming } from '../../services/mcp/appInvoker.js';

describe('invokeAppNonStreaming — input validation', () => {
  it('throws when message is missing', async () => {
    await expect(invokeAppNonStreaming({ appId: 'chat', args: {}, user: {} })).rejects.toThrow(
      /Missing required argument/
    );
  });

  it('throws when message is empty', async () => {
    await expect(
      invokeAppNonStreaming({ appId: 'chat', args: { message: '   ' }, user: {} })
    ).rejects.toThrow(/Missing required argument/);
  });

  it('throws when message is not a string', async () => {
    await expect(
      invokeAppNonStreaming({ appId: 'chat', args: { message: 42 }, user: {} })
    ).rejects.toThrow(/Missing required argument/);
  });
});
