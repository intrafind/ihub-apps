// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  createElicitationHandler,
  elicitationContent,
  elicitationForm,
  elicitationUrl,
  runWithElicitationScope
} from '../../services/mcp/mcpElicitation.js';
import { buildClientCapabilities } from '../../services/mcp/mcpApps.js';
import { interactionSchema } from '../../services/loop/contracts/interaction.js';
import { setEnvelopeDelivery } from '../../services/loop/RunStream.js';

/**
 * A question an MCP server asks mid-call (elicitation) reaches the chat user
 * as a form on a child run of the chat run, and the answer goes back to the
 * server as `accept` (with the content), `decline` or `cancel`.
 */

const REQUEST = {
  params: {
    message: 'Create the paid project for $25/month?',
    requestedSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Project name', minLength: 3 },
        seats: { type: 'integer', minimum: 1 },
        confirm: { type: 'boolean', title: 'I accept the cost' },
        region: { type: 'string', enum: ['eu', 'us'], enumNames: ['Europe', 'USA'] },
        nested: { type: 'object', properties: {} }
      },
      required: ['name', 'confirm', 'nested']
    }
  }
};

/** An InteractionService stand-in that stores what the real one would. */
function fakeInteractions() {
  let settle;
  const service = {
    raised: null,
    raise: jest.fn(async params => {
      service.raised = interactionSchema.parse({
        ...params,
        status: 'pending',
        createdAt: new Date().toISOString()
      });
      return service.raised;
    }),
    waitForAnswer: jest.fn(
      () =>
        new Promise((resolve, reject) => {
          settle = { resolve, reject };
        })
    ),
    cancel: jest.fn(async () => {}),
    answer: answer => settle.resolve({ ...service.raised, status: 'answered', answer }),
    fail: error => settle.reject(error)
  };
  return service;
}

const user = { id: 'alice', groups: ['users'] };
const parentRunId = 'chat-parent';

/** Run the handler inside a call's scope and answer once the question is up. */
async function ask({ interactions, answerWith, context = {}, request = REQUEST }) {
  const handler = createElicitationHandler({
    serverId: 'supabase',
    serverName: 'Supabase',
    interactionService: interactions,
    runLog: { getRunMeta: () => ({ principalId: 'alice', identityMode: 'default' }) },
    getStreamRun: chatId => (chatId === 'chat-1' ? { runId: parentRunId } : null)
  });
  const pending = runWithElicitationScope(
    { chatId: 'chat-1', user, toolId: 'supabase__create_project', ...context },
    () => handler(request)
  );
  if (answerWith) {
    await new Promise(resolve => setImmediate(resolve));
    answerWith(interactions);
  }
  return pending;
}

describe('elicitationForm', () => {
  it('keeps the flat primitive fields MCP allows, with titled choices', () => {
    const form = elicitationForm(REQUEST.params.requestedSchema);
    expect(Object.keys(form.properties)).toEqual(['name', 'seats', 'confirm', 'region']);
    expect(form.properties.region.oneOf).toEqual([
      { const: 'eu', title: 'Europe' },
      { const: 'us', title: 'USA' }
    ]);
    // A field that is left out cannot be required.
    expect(form.required).toEqual(['name', 'confirm']);
  });
});

describe('elicitationContent', () => {
  it('returns the form fields only, each as its schema type', () => {
    const form = elicitationForm(REQUEST.params.requestedSchema);
    expect(
      elicitationContent(form, {
        name: 'Billing',
        seats: '4',
        confirm: 'true',
        region: 'eu',
        injected: 'x'
      })
    ).toEqual({ name: 'Billing', seats: 4, confirm: true, region: 'eu' });
  });
});

describe('the elicitation handler', () => {
  let frames;

  beforeEach(() => {
    frames = [];
    setEnvelopeDelivery((streamId, envelope) => frames.push({ streamId, ...envelope }));
  });

  afterEach(() => setEnvelopeDelivery(null));

  it('asks the chat user on a child run and accepts with the submitted content', async () => {
    const interactions = fakeInteractions();
    const onWaitStart = jest.fn();
    const onWaitEnd = jest.fn();
    const result = await ask({
      interactions,
      context: { onWaitStart, onWaitEnd },
      answerWith: i => i.answer({ value: 'accept', data: { name: 'Billing', confirm: true } })
    });
    expect(result).toEqual({ action: 'accept', content: { name: 'Billing', confirm: true } });

    const raised = interactions.raised;
    expect(raised.kind).toBe('question');
    expect(raised.prompt.inputType).toBe('form');
    expect(raised.prompt.allowSkip).toBe(true);
    expect(raised.source).toMatchObject({
      chatId: 'chat-1',
      principalId: 'alice',
      mcpElicitation: { serverId: 'supabase', serverName: 'Supabase' }
    });
    expect(raised.runId).not.toBe(parentRunId);
    // Not a workflow checkpoint: nothing resumes an execution on its answer.
    expect(raised.source.checkpointId).toBeUndefined();
    expect(raised.source.executionId).toBeUndefined();

    // The chat sees a child run: started under the chat run, the question,
    // paused while it waits, then resumed and ended.
    const types = frames.filter(f => f.runId === raised.runId).map(f => f.type);
    expect(types).toEqual([
      'run/started',
      'interaction/raised',
      'run/paused',
      'run/resumed',
      'run/ended'
    ]);
    expect(frames[0]).toMatchObject({ streamId: 'chat-1', data: { parentRunId } });
    expect(onWaitStart).toHaveBeenCalledTimes(1);
    expect(onWaitEnd).toHaveBeenCalledTimes(1);
  });

  it("names the user as the one who may answer when the chat run's ledger does not", async () => {
    const interactions = fakeInteractions();
    const handler = createElicitationHandler({
      serverId: 'supabase',
      interactionService: interactions,
      runLog: { getRunMeta: () => null },
      getStreamRun: () => ({ runId: parentRunId })
    });
    const pending = runWithElicitationScope({ chatId: 'chat-1', user }, () => handler(REQUEST));
    await new Promise(resolve => setImmediate(resolve));
    interactions.answer({ skipped: true });
    await pending;
    expect(interactions.raised.source.principalId).toBe('alice');
  });

  it('declines when the person declines', async () => {
    const interactions = fakeInteractions();
    const result = await ask({ interactions, answerWith: i => i.answer({ skipped: true }) });
    expect(result).toEqual({ action: 'decline' });
  });

  it('cancels when the question expires', async () => {
    const interactions = fakeInteractions();
    const result = await ask({
      interactions,
      answerWith: i => i.fail(Object.assign(new Error('expired'), { code: 'EXPIRED' }))
    });
    expect(result).toEqual({ action: 'cancel' });
  });

  it('cancels the question and the call when the turn is stopped', async () => {
    const interactions = fakeInteractions();
    const controller = new AbortController();
    const pending = ask({ interactions, context: { signal: controller.signal } });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    expect(await pending).toEqual({ action: 'cancel' });
    expect(interactions.cancel).toHaveBeenCalledWith(interactions.raised.id, 'aborted');
  });

  it('cancels at once when no chat turn can show the question', async () => {
    for (const context of [
      { chatId: undefined },
      { chatId: 'no-turn' },
      { user: { id: 'anonymous' } }
    ]) {
      const interactions = fakeInteractions();
      expect(await ask({ interactions, context })).toEqual({ action: 'cancel' });
      expect(interactions.raise).not.toHaveBeenCalled();
    }
  });

  it('cancels outside any tool call', async () => {
    const interactions = fakeInteractions();
    const handler = createElicitationHandler({
      serverId: 'x',
      interactionService: interactions,
      getStreamRun: () => ({ runId: parentRunId })
    });
    expect(await handler(REQUEST)).toEqual({ action: 'cancel' });
    expect(interactions.raise).not.toHaveBeenCalled();
  });
});

describe('a question sent outside the call (2025-era session stream)', () => {
  const handlerWith = (interactions, soleCall) =>
    createElicitationHandler({
      serverId: 'billing',
      interactionService: interactions,
      runLog: { getRunMeta: () => null },
      getStreamRun: () => ({ runId: parentRunId }),
      soleCall
    });

  it('goes to the one call running on the connection', async () => {
    setEnvelopeDelivery(() => {});
    const interactions = fakeInteractions();
    const pending = handlerWith(interactions, () => ({ chatId: 'chat-1', user }))(REQUEST);
    await new Promise(resolve => setImmediate(resolve));
    interactions.answer({ skipped: true });
    expect(await pending).toEqual({ action: 'decline' });
    expect(interactions.raised.source.chatId).toBe('chat-1');
    setEnvelopeDelivery(null);
  });

  it('is cancelled when no single call can be named', async () => {
    const interactions = fakeInteractions();
    expect(await handlerWith(interactions, () => null)(REQUEST)).toEqual({ action: 'cancel' });
    expect(interactions.raise).not.toHaveBeenCalled();
  });
});

describe('a page the server asks the person to open (URL mode)', () => {
  const PAGE = {
    params: {
      mode: 'url',
      message: 'Sign in to Billing to continue.',
      url: 'https://billing.example.com/connect?state=abc',
      elicitationId: 'el-1'
    }
  };

  let frames;
  beforeEach(() => {
    frames = [];
    setEnvelopeDelivery((streamId, envelope) => frames.push({ streamId, ...envelope }));
  });
  afterEach(() => setEnvelopeDelivery(null));

  it('is declared next to form mode', () => {
    expect(buildClientCapabilities(false, { elicitation: true }).elicitation).toEqual({
      form: {},
      url: {}
    });
  });

  it('shows only https addresses without credentials', () => {
    expect(elicitationUrl('https://billing.example.com/connect?x=1')).toBe(
      'https://billing.example.com/connect?x=1'
    );
    for (const unsafe of [
      'http://billing.example.com/connect',
      'https://user:secret@billing.example.com/',
      'javascript:alert(1)',
      'data:text/html,hi',
      'not a url',
      `https://example.com/${'a'.repeat(2100)}`,
      42
    ]) {
      expect(elicitationUrl(unsafe)).toBeNull();
    }
  });

  it('puts the page on the card and answers accept, without content, when the person is done', async () => {
    const interactions = fakeInteractions();
    const result = await ask({
      interactions,
      request: PAGE,
      answerWith: i => i.answer({ value: 'accept' })
    });
    expect(result).toEqual({ action: 'accept' });
    const raised = interactions.raised;
    expect(raised.prompt).toMatchObject({ inputType: 'confirm', allowSkip: true });
    expect(raised.prompt.message).toBe('Sign in to Billing to continue.');
    expect(raised.source.mcpElicitation).toMatchObject({
      serverId: 'supabase',
      mode: 'url',
      url: 'https://billing.example.com/connect?state=abc'
    });
    expect(frames.filter(f => f.runId === raised.runId).map(f => f.type)).toEqual([
      'run/started',
      'interaction/raised',
      'run/paused',
      'run/resumed',
      'run/ended'
    ]);
  });

  it('declines when the person declines', async () => {
    const interactions = fakeInteractions();
    const result = await ask({
      interactions,
      request: PAGE,
      answerWith: i => i.answer({ skipped: true })
    });
    expect(result).toEqual({ action: 'decline' });
  });

  it('declines a page it will not show, without asking', async () => {
    const interactions = fakeInteractions();
    const result = await ask({
      interactions,
      request: { params: { ...PAGE.params, url: 'http://billing.example.com/connect' } }
    });
    expect(result).toEqual({ action: 'decline' });
    expect(interactions.raise).not.toHaveBeenCalled();
  });

  it('ends the question when the server reports the person finished there', async () => {
    const interactions = fakeInteractions();
    const handler = createElicitationHandler({
      serverId: 'billing',
      interactionService: interactions,
      runLog: { getRunMeta: () => null },
      getStreamRun: () => ({ runId: parentRunId })
    });
    const pending = runWithElicitationScope({ chatId: 'chat-1', user }, () => handler(PAGE));
    await new Promise(resolve => setImmediate(resolve));
    expect(handler.complete('someone-else')).toBe(false);
    expect(handler.complete('el-1')).toBe(true);
    expect(await pending).toEqual({ action: 'accept' });
    expect(interactions.cancel).toHaveBeenCalledWith(interactions.raised.id, 'completed');
    // Once ended, the same notice finds nothing to finish.
    expect(handler.complete('el-1')).toBe(false);
  });
});
