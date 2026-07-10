/**
 * Unit tests for chatBridge.tryHandleMentionWorkflow — extracted from the
 * POST /api/apps/:appId/chat/:chatId handler (routes/chat/sessionRoutes.js)
 * so the @mention dispatch logic is testable without spinning up Express.
 */

import { jest } from '@jest/globals';

const trackError = jest.fn();
const trackChunk = jest.fn();
const trackDone = jest.fn();
const getWorkflowById = jest.fn();
const clientsHas = jest.fn(() => false);
const runWorkflow = jest.fn(async () => {});

jest.unstable_mockModule('../configCache.js', () => ({
  default: { getWorkflowById }
}));

jest.unstable_mockModule('../sse.js', () => ({
  clients: { has: clientsHas }
}));

jest.unstable_mockModule('../actionTracker.js', () => ({
  actionTracker: { trackError, trackChunk, trackDone }
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
}));

jest.unstable_mockModule('../tools/workflowRunner.js', () => ({
  default: runWorkflow
}));

const { tryHandleMentionWorkflow } = await import('../services/workflow/chatBridge.js');

function msg(content, extra = {}) {
  return { role: 'user', content, ...extra };
}

beforeEach(() => {
  jest.clearAllMocks();
  clientsHas.mockReturnValue(false);
});

describe('tryHandleMentionWorkflow', () => {
  it('falls through when the last message has no @mention', async () => {
    const result = await tryHandleMentionWorkflow({
      messages: [msg('hello there')],
      chatId: 'c1',
      modelId: 'm1',
      user: { id: 'u1' },
      clientLanguage: 'en'
    });
    expect(result).toEqual({ handled: false });
    expect(getWorkflowById).not.toHaveBeenCalled();
  });

  it('falls through when the mention does not resolve to a known workflow', async () => {
    getWorkflowById.mockReturnValue(undefined);
    const result = await tryHandleMentionWorkflow({
      messages: [msg('@unknown-workflow do the thing')],
      chatId: 'c1',
      modelId: 'm1',
      user: { id: 'u1' },
      clientLanguage: 'en'
    });
    expect(result).toEqual({ handled: false });
    expect(getWorkflowById).toHaveBeenCalledWith('unknown-workflow');
  });

  it('rejects a disabled workflow with a 400 when there is no active SSE connection', async () => {
    getWorkflowById.mockReturnValue({ enabled: false, name: 'My Flow', chatIntegration: {} });
    clientsHas.mockReturnValue(false);

    const result = await tryHandleMentionWorkflow({
      messages: [msg('@my-flow go')],
      chatId: 'c1',
      modelId: 'm1',
      user: { id: 'u1' },
      clientLanguage: 'en'
    });

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(400);
    expect(result.response).toEqual({
      status: 'error',
      message: 'Workflow "My Flow" is disabled.'
    });
    expect(trackError).toHaveBeenCalledWith('c1', { message: 'Workflow "My Flow" is disabled.' });
    expect(runWorkflow).not.toHaveBeenCalled();
  });

  it('rejects a workflow without chatIntegration via the streaming SSE path when a client is connected', async () => {
    getWorkflowById.mockReturnValue({
      enabled: true,
      name: 'My Flow',
      chatIntegration: { enabled: false }
    });
    clientsHas.mockReturnValue(true);

    const result = await tryHandleMentionWorkflow({
      messages: [msg('@my-flow go')],
      chatId: 'c1',
      modelId: 'm1',
      user: { id: 'u1' },
      clientLanguage: 'en'
    });

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBeUndefined();
    expect(result.response).toEqual({ status: 'streaming', chatId: 'c1' });
    expect(trackChunk).toHaveBeenCalledWith('c1', {
      content: 'Workflow "My Flow" is not configured for chat (chatIntegration.enabled is false).'
    });
    expect(trackDone).toHaveBeenCalledWith('c1', { finishReason: 'error' });
    expect(runWorkflow).not.toHaveBeenCalled();
  });

  it('dispatches an enabled, chat-integrated workflow and strips the mention from the input', async () => {
    getWorkflowById.mockReturnValue({ enabled: true, chatIntegration: { enabled: true } });

    const result = await tryHandleMentionWorkflow({
      messages: [msg('hi'), msg('@my-flow please summarize this')],
      chatId: 'c1',
      modelId: 'm1',
      user: { id: 'u1' },
      clientLanguage: 'en'
    });

    expect(result).toEqual({ handled: true, response: { status: 'streaming', chatId: 'c1' } });

    // Fire-and-forget dispatch happens synchronously up to the await point.
    await Promise.resolve();
    expect(runWorkflow).toHaveBeenCalledWith({
      workflowId: 'my-flow',
      chatId: 'c1',
      user: { id: 'u1' },
      input: 'please summarize this',
      modelId: 'm1',
      _chatHistory: [{ role: 'user', content: 'hi' }],
      _fileData: undefined,
      language: 'en'
    });
  });

  it('tracks an error and returns a handled error response when the workflow run rejects', async () => {
    getWorkflowById.mockReturnValue({ enabled: true, chatIntegration: { enabled: true } });
    let rejectRun;
    runWorkflow.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectRun = reject;
      })
    );

    const result = await tryHandleMentionWorkflow({
      messages: [msg('@my-flow go')],
      chatId: 'c1',
      modelId: 'm1',
      user: { id: 'u1' },
      clientLanguage: 'en'
    });

    expect(result).toEqual({ handled: true, response: { status: 'streaming', chatId: 'c1' } });

    rejectRun(new Error('boom'));
    await Promise.resolve();
    await Promise.resolve();
    expect(trackError).toHaveBeenCalledWith('c1', {
      message: 'Workflow execution failed: boom'
    });
  });
});
