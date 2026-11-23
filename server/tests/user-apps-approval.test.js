// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Tool approval in a personal app (feature `userApps`, design 6.3), through
 * the chat route with a scripted model.
 *
 * The instructions of a shared personal app steer the tools of the person
 * chatting. So for everyone but the owner:
 *
 *  - every tool call asks, reads included: the web search and the page reader
 *    `read_url`, which sends a request to any address;
 *  - "allow for this chat" does not exist: the approval event carries
 *    `displayData.grants: []`, and an answer with `grant: 'chat'` approves
 *    that one call only.
 *
 * The owner reads their own instructions: a read runs without a card, a write
 * asks, and a grant for the chat is honoured.
 *
 * Real: the route, the resolver, the ceiling, the request builder, the tool
 * list, the agent loop, the approval seam and the chat store. Stubbed: the
 * transport of the model (a script of answers), the API key check, and the
 * two fixture tools (a web search engine and a tool that writes).
 *
 * Run: node --test server/tests/user-apps-approval.test.js
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import llmClient from '../services/loop/LLMClient.js';
import interactionService from '../services/loop/InteractionService.js';
import integrationRegistry from '../services/integrations/definitions/IntegrationRegistry.js';
import { publishDefinitionTypes } from '../services/integrations/integrationTypes.js';
import mcpClientManager from '../services/mcp/McpClientManager.js';
import { getChatRepository } from '../services/chat/ChatRepository.js';
import { chatApprovalState, prepareChatApproval } from '../services/chat/chatToolApproval.js';
import { chatApprovalOptions } from '../services/chat/chatSeams.js';
import { READ_URL_TOOL_ID } from '../services/tools/webSearchResolver.js';
import { sseResponse } from './loop/helpers/llmFixtures.js';
import {
  fixtureDefinitionId,
  fixtureInstallation,
  fixtureTool,
  registerFixtureTools,
  unregisterFixtureTools
} from './helpers/integrationToolFixture.js';
import { member, setConfig, startUserAppsHarness } from './helpers/userAppsHarness.js';

const SEARCH_TOOL = 'acme__search';
const SEARCH_INSTALLATION = 'acme';
const WRITE_TOOL = 'ticket_create';

/** Every run of a fixture tool. */
const toolRuns = [];

const INTEGRATIONS = {
  installed: [
    fixtureInstallation(SEARCH_INSTALLATION, { definition: fixtureDefinitionId(SEARCH_TOOL) }),
    fixtureInstallation(WRITE_TOOL)
  ],
  security: { blockPrivateIps: true, allowedHosts: [] }
};

/** Web search and the writing tool are allowed for personal apps. */
const configure = () =>
  setConfig({
    integrations: INTEGRATIONS,
    userApps: {
      capabilities: {
        webSearch: true,
        integrations: [{ id: WRITE_TOOL, actions: [WRITE_TOOL] }]
      }
    }
  });

const CONTENT = {
  capabilities: {
    upload: false,
    webSearch: true,
    skills: false,
    integrations: [{ id: WRITE_TOOL, actions: [WRITE_TOOL] }]
  }
};

function textTurn(content) {
  return [
    { choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    '[DONE]'
  ];
}

function toolTurn(name, args, id = `call_${randomUUID().slice(0, 8)}`) {
  return [
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) }
              }
            ]
          },
          finish_reason: null
        }
      ]
    },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    '[DONE]'
  ];
}

let harness;
let as;
/** The answers the model gives, in order; and every request it got. */
let script = [];
let requests = [];
let originalTransport;

/** The names of the tools a model request offers. */
const offered = request =>
  (request?.body?.tools || []).map(tool => tool?.function?.name || tool?.name).filter(Boolean);

before(async () => {
  harness = await startUserAppsHarness({ stubTurns: false });
  ({ as } = harness);
  await integrationRegistry.ensureLoaded();
  await registerFixtureTools([
    fixtureTool(SEARCH_TOOL, {
      action: 'search',
      type: 'web-search',
      description: 'Search the web with Acme.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query']
      },
      run: args => {
        toolRuns.push({ tool: SEARCH_TOOL, args });
        return { results: [{ title: 'A page', url: 'https://example.org/a' }] };
      }
    }),
    fixtureTool(WRITE_TOOL, {
      sideEffect: 'write',
      description: 'Create a ticket.',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title']
      },
      run: args => {
        toolRuns.push({ tool: WRITE_TOOL, args });
        return { created: true, title: args.title };
      }
    })
  ]);
  publishDefinitionTypes(integrationRegistry.list());
  mcpClientManager.listAllTools = async () => [];

  originalTransport = llmClient.transport;
  llmClient.transport = async request => {
    requests.push(request);
    const next = script.shift();
    if (!next) throw new Error(`model script exhausted after ${requests.length} calls`);
    return sseResponse(typeof next === 'function' ? next(request) : next);
  };
});

after(async () => {
  llmClient.transport = originalTransport;
  await unregisterFixtureTools();
  await harness.stop();
});

beforeEach(async () => {
  await harness.reset();
  configure();
  script = [];
  requests = [];
  toolRuns.length = 0;
});

/** An app of Anna with web search and the writing tool, shared with Ben and Carol. */
const sharedApp = () =>
  harness.createApp('anna', {
    content: CONTENT,
    members: [member('ben', 'user'), member('carol', 'editor')]
  });

const message = (content, extra = {}) => ({
  role: 'user',
  content,
  messageId: `m-${randomUUID()}`,
  ...extra
});

/** One turn of a chat with web search and the bound tool switched on. */
const send = (name, appId, chatId, msg) =>
  as(name)
    .post(`/api/apps/${appId}/chat/${chatId}`)
    .send({
      messages: [msg],
      modelId: 'oa',
      websearchEnabled: true,
      enabledTools: [WRITE_TOOL],
      toolApprovalCapable: true
    });

const answer = (interactionId, decision, grant) =>
  message('', {
    approvalResponse: { interactionId, decision, ...(grant ? { grant } : {}) }
  });

/** The open approval of a chat: the interaction, and what the chat stores. */
async function pendingApproval(chatId) {
  const chat = await getChatRepository().getChat(chatId);
  const state = chatApprovalState(chat);
  const open = (await interactionService.listPending({ chatId, kind: 'approval' })) || [];
  const interaction = state.pending
    ? open.find(entry => entry.id === state.pending.interactionId) || null
    : null;
  return { state, interaction, open };
}

describe('the tools a personal app offers', () => {
  it('a member with web search on is offered the search tool and the page reader', async () => {
    const record = await sharedApp();
    script = [textTurn('Nothing to do.')];
    const res = await send('ben', record.id, randomUUID(), message('hello'));
    assert.equal(res.status, 200, res.text);
    const names = offered(requests[0]);
    assert.ok(names.includes(SEARCH_TOOL), names.join(','));
    assert.ok(names.includes(READ_URL_TOOL_ID), names.join(','));
    assert.ok(names.includes(WRITE_TOOL), names.join(','));
  });

  it('nothing is offered until the person switches it on', async () => {
    const record = await sharedApp();
    script = [textTurn('Nothing to do.')];
    const res = await as('ben')
      .post(`/api/apps/${record.id}/chat/${randomUUID()}`)
      .send({ messages: [message('hello')], modelId: 'oa', toolApprovalCapable: true });
    assert.equal(res.status, 200, res.text);
    const names = offered(requests[0]);
    for (const tool of [SEARCH_TOOL, READ_URL_TOOL_ID, WRITE_TOOL]) {
      assert.equal(names.includes(tool), false, `${tool} in ${names.join(',')}`);
    }
  });
});

describe('the runner is a member', () => {
  it('a read_url call raises an approval, without "allow for this chat"', async () => {
    const record = await sharedApp();
    const chatId = randomUUID();
    script = [toolTurn(READ_URL_TOOL_ID, { url: 'https://example.org/?d=secret' })];
    const res = await send('ben', record.id, chatId, message('Summarise the page'));
    assert.equal(res.status, 200, res.text);

    const { state, interaction } = await pendingApproval(chatId);
    assert.ok(state.pending, 'the turn paused on an approval');
    assert.ok(interaction, 'the approval is an open interaction');
    assert.equal(interaction.source.toolId, READ_URL_TOOL_ID);
    assert.equal(interaction.source.appId, record.id);
    // The card shows the address the app wants to open.
    assert.equal(interaction.prompt.displayData.args.url, 'https://example.org/?d=secret');
    // The server says which grants the card may offer: none.
    assert.deepEqual(interaction.prompt.displayData.grants, []);
    assert.equal(requests.length, 1, 'the model was not asked again');
  });

  it('the search call raises an approval too', async () => {
    const record = await sharedApp();
    const chatId = randomUUID();
    script = [toolTurn(SEARCH_TOOL, { query: 'job ads' })];
    const res = await send('carol', record.id, chatId, message('Search for it'));
    assert.equal(res.status, 200, res.text);
    const { interaction } = await pendingApproval(chatId);
    assert.equal(interaction?.source.toolId, SEARCH_TOOL);
    assert.deepEqual(interaction.prompt.displayData.grants, []);
    assert.equal(toolRuns.length, 0, 'the search did not run');
  });

  it('`grant: "chat"` approves that one call; the next call of the same tool asks again', async () => {
    const record = await sharedApp();
    const chatId = randomUUID();
    script = [toolTurn(SEARCH_TOOL, { query: 'first' })];
    assert.equal((await send('ben', record.id, chatId, message('Search twice'))).status, 200);
    const first = await pendingApproval(chatId);
    assert.equal(first.interaction?.source.toolId, SEARCH_TOOL);

    // Approved "for this chat": the call runs, and the model calls the tool again.
    script = [toolTurn(SEARCH_TOOL, { query: 'second' })];
    const approved = await send(
      'ben',
      record.id,
      chatId,
      answer(first.interaction.id, 'approve', 'chat')
    );
    assert.equal(approved.status, 200, approved.text);
    assert.deepEqual(toolRuns, [{ tool: SEARCH_TOOL, args: toolRuns[0]?.args }]);
    assert.equal(toolRuns[0].args.query, 'first');

    const second = await pendingApproval(chatId);
    assert.ok(second.interaction, 'the second call raised a new approval');
    assert.notEqual(second.interaction.id, first.interaction.id);
    assert.equal(second.interaction.source.toolId, SEARCH_TOOL);
    assert.deepEqual(second.interaction.prompt.displayData.grants, []);
    assert.deepEqual(second.state.grants, [], 'no grant was stored with the chat');
    assert.equal(toolRuns.length, 1, 'the second call did not run');

    // Rejected: it never runs.
    script = [textTurn('Then I stop here.')];
    const rejected = await send('ben', record.id, chatId, answer(second.interaction.id, 'reject'));
    assert.equal(rejected.status, 200, rejected.text);
    assert.equal(toolRuns.length, 1);
    assert.equal((await pendingApproval(chatId)).state.pending, null);
  });

  it('a grant the chat already stores is not honoured', async () => {
    const record = await sharedApp();
    const chatId = await harness.seedChat('ben', record.id);
    await getChatRepository().updateChat(chatId, {
      toolApproval: { grants: [SEARCH_TOOL, READ_URL_TOOL_ID], pending: null }
    });
    script = [toolTurn(SEARCH_TOOL, { query: 'anything' })];
    assert.equal((await send('ben', record.id, chatId, message('Search'))).status, 200);
    const { interaction } = await pendingApproval(chatId);
    assert.equal(interaction?.source.toolId, SEARCH_TOOL);
    assert.equal(toolRuns.length, 0);
  });

  it('a full admin who is no member is asked like a member', async () => {
    const record = await sharedApp();
    const chatId = randomUUID();
    script = [toolTurn(READ_URL_TOOL_ID, { url: 'https://example.org/' })];
    assert.equal((await send('root', record.id, chatId, message('Open it'))).status, 200);
    const { interaction } = await pendingApproval(chatId);
    assert.equal(interaction?.source.toolId, READ_URL_TOOL_ID);
    assert.deepEqual(interaction.prompt.displayData.grants, []);
  });
});

describe('the runner is the owner', () => {
  it('a read runs without a card', async () => {
    const record = await sharedApp();
    const chatId = randomUUID();
    script = [toolTurn(SEARCH_TOOL, { query: 'job ads' }), textTurn('Here is what I found.')];
    const res = await send('anna', record.id, chatId, message('Search for it'));
    assert.equal(res.status, 200, res.text);
    const { state, open } = await pendingApproval(chatId);
    assert.equal(state.pending, null);
    assert.equal(open.length, 0);
    assert.deepEqual(
      toolRuns.map(run => run.tool),
      [SEARCH_TOOL]
    );
    assert.equal(requests.length, 2, 'the model got the result and answered');
  });

  it('content an editor saved runs under the owner settings too: a read runs without a card', async () => {
    const shared = await sharedApp();
    // Carol ("Can edit") saved the current content; nobody confirms it.
    const record = await harness
      .repo()
      .mutate(
        shared.id,
        current => ({ ...current, updatedBy: { id: 'carol', name: 'Carol Shaw' } }),
        { bumpRevision: false }
      );
    assert.equal(record.updatedBy.id, 'carol');
    const chatId = randomUUID();
    script = [toolTurn(SEARCH_TOOL, { query: 'job ads' }), textTurn('Here is what I found.')];
    const res = await send('anna', record.id, chatId, message('Search for it'));
    assert.equal(res.status, 200, res.text);
    const { state, open } = await pendingApproval(chatId);
    assert.equal(state.pending, null);
    assert.equal(open.length, 0);
  });

  it('a read_url call runs without a card', async () => {
    const record = await sharedApp();
    const chatId = randomUUID();
    // The address is one the page reader refuses to open: the call runs, and
    // nothing leaves the machine.
    script = [
      toolTurn(READ_URL_TOOL_ID, { url: 'http://127.0.0.1:9/page' }),
      textTurn('I could not open the page.')
    ];
    const res = await send('anna', record.id, chatId, message('Open the page'));
    assert.equal(res.status, 200, res.text);
    const { state, open } = await pendingApproval(chatId);
    assert.equal(state.pending, null, 'no approval was raised');
    assert.equal(open.length, 0);
    assert.equal(requests.length, 2, 'the call ran and the model was asked again');
    const toolMessages = (requests[1].body.messages || []).filter(msg => msg.role === 'tool');
    assert.equal(toolMessages.length, 1);
    assert.equal(/APPROVAL/.test(JSON.stringify(toolMessages)), false);
  });

  it('a write asks, and `grant: "chat"` is honoured', async () => {
    const record = await sharedApp();
    const chatId = randomUUID();
    script = [toolTurn(WRITE_TOOL, { title: 'First' })];
    assert.equal((await send('anna', record.id, chatId, message('Create a ticket'))).status, 200);
    const first = await pendingApproval(chatId);
    assert.equal(first.interaction?.source.toolId, WRITE_TOOL);
    // Today's behaviour: the event says nothing about grants, the card offers the button.
    assert.equal(Object.hasOwn(first.interaction.prompt.displayData, 'grants'), false);
    assert.equal(toolRuns.length, 0);

    // Approved for the chat: this call runs, and so does the next one of the tool.
    script = [toolTurn(WRITE_TOOL, { title: 'Second' }), textTurn('Both tickets exist.')];
    const approved = await send(
      'anna',
      record.id,
      chatId,
      answer(first.interaction.id, 'approve', 'chat')
    );
    assert.equal(approved.status, 200, approved.text);
    assert.deepEqual(
      toolRuns.map(run => run.args.title),
      ['First', 'Second']
    );
    const after = await pendingApproval(chatId);
    assert.equal(after.state.pending, null);
    assert.deepEqual(after.state.grants, [WRITE_TOOL]);
  });
});

describe('the grants option of the approval files', () => {
  const chatWith = grants => ({ toolApproval: { grants, pending: null } });
  const services = {
    interactionService: { listPending: async () => [] },
    authorizeInteraction: async () => true
  };

  it('prepareChatApproval hands the stored grants on, unless the chat has none to give', async () => {
    const base = {
      chatId: 'c1',
      user: { id: 'ben' },
      chat: chatWith(['read_url']),
      lastMessage: { role: 'user', content: 'hello' },
      repository: {},
      ...services
    };
    assert.deepEqual((await prepareChatApproval(base)).grants, ['read_url']);
    assert.deepEqual((await prepareChatApproval({ ...base, chatGrants: true })).grants, [
      'read_url'
    ]);
    assert.deepEqual((await prepareChatApproval({ ...base, chatGrants: false })).grants, []);
  });

  it('chatApprovalOptions honours a grant by default, and none with `chatGrants: false`', () => {
    const options = chatGrants =>
      chatApprovalOptions({
        chatId: 'c1',
        headless: false,
        grants: ['read_url'],
        ...(chatGrants === undefined ? {} : { chatGrants }),
        buildLogData: () => ({}),
        logInteraction: async () => {}
      });
    const call = { toolId: 'read_url', call: { id: 'call_1' }, args: {} };
    assert.equal(options(undefined).isGranted(call), true);
    assert.equal(options(true).isGranted(call), true);
    assert.equal(options(false).isGranted(call), false);
  });

  it('with `chatGrants: false` the call a person just approved still runs once', () => {
    const { isGranted } = chatApprovalOptions({
      chatId: 'c1',
      headless: false,
      grants: ['read_url'],
      chatGrants: false,
      approvedCall: { callId: 'call_1', args: { url: 'https://example.org/' } },
      buildLogData: () => ({}),
      logInteraction: async () => {}
    });
    const approved = {
      toolId: 'read_url',
      call: { id: 'call_1' },
      args: { url: 'https://example.org/' }
    };
    assert.equal(isGranted(approved), true);
    assert.equal(isGranted(approved), false, 'once');
    assert.equal(
      isGranted({ toolId: 'read_url', call: { id: 'call_2' }, args: { url: 'https://x.test/' } }),
      false
    );
  });
});
