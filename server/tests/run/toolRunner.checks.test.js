// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The checks of the tool runner, one test per row of the table in
 * docs/agent-loop.md ("Tool runner") and in the pull request that added the
 * runner (#3772, S10).
 *
 * Every check ran before on some of the paths a tool call takes (the chat
 * turn, an app run as a tool, the passthrough seam, the MCP gateway, inbound
 * A2A, the legacy prompt node); the runner applies the union to every caller.
 * A row's id is the name its test carries.
 *
 * The rows from `runToolChecks` exercise the real `runTool` behind the runner:
 * those checks stayed in `services/tools/runTool.js` and the runner must reach
 * them on every path.
 *
 * Run: node --test server/tests/run/toolRunner.checks.test.js
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import configCache from '../../configCache.js';
import mcpClientManager from '../../services/mcp/McpClientManager.js';
import a2aClientManager from '../../services/a2a/A2aClientManager.js';
import {
  APPROVAL_DECIDERS,
  ToolCallRefusedError,
  ToolRunner,
  TOOL_REFUSAL_CODES,
  buildToolParams,
  workflowToolDef
} from '../../services/run/ToolRunner.js';
import { WORKFLOW_TOOL_ID_PREFIX } from '../../services/tools/catalog.js';
import { RESERVED_TOOL_CONTEXT_KEYS } from '../../utils/toolCallContext.js';
import { createPageReadGate, PAGE_READ_LIMIT_CODE } from '../../services/chat/pageReadLimit.js';
import { APPROVAL_ERROR_CODES } from '../../../shared/toolApproval.js';

/** A runner whose `runTool` and app gateway record their calls. */
function spyRunner({ platform = {}, result = { ok: true } } = {}) {
  const calls = [];
  const appCalls = [];
  const runner = new ToolRunner({
    runTool: async (toolId, params, options) => {
      calls.push({ toolId, params, options });
      return result;
    },
    invokeAppTool: async request => {
      appCalls.push(request);
      return { content: 'app answer' };
    },
    getPlatform: () => platform
  });
  return { runner, calls, appCalls };
}

const USER = { id: 'alice', permissions: { apps: new Set(['*']) } };
const APP = { id: 'concierge' };
const lookup = {
  id: 'lookup',
  parameters: { type: 'object', properties: { q: { type: 'string' } } }
};

/** The context of a chat turn's call, as ChatService passes it. */
const chatContext = (extra = {}) => ({
  origin: 'chat',
  approval: 'seam',
  principal: USER,
  chatId: 'chat-1',
  appConfig: APP,
  language: 'de',
  integrationScopes: { search: 'profile-a' },
  turnSkills: { note() {} },
  ...extra
});

const refusal = code => err => {
  assert.ok(err instanceof ToolCallRefusedError, `expected a refusal, got ${err}`);
  assert.equal(err.code, code);
  return true;
};

describe('tool runner checks (S10)', () => {
  it('tool-id-valid: a call for an id that is not a safe id never reaches a tool', async () => {
    const { runner, calls, appCalls } = spyRunner();
    for (const toolId of ['../etc/passwd', 'a b', '', undefined, 'app__../x']) {
      await assert.rejects(
        runner.execute(null, {
          toolId,
          toolDef: { id: toolId },
          args: {},
          toolContext: chatContext()
        }),
        refusal(TOOL_REFUSAL_CODES.INVALID_TOOL_ID)
      );
    }
    assert.equal(calls.length + appCalls.length, 0);
  });

  it('resolved-tool: only a tool the caller resolved from what it offers runs', async () => {
    const { runner, calls } = spyRunner();
    // No definition: a name the caller never offered (a hallucinated or forged call).
    await assert.rejects(
      runner.execute(null, { toolId: 'lookup', args: {}, toolContext: chatContext() }),
      refusal(TOOL_REFUSAL_CODES.NOT_RESOLVED)
    );
    // A definition of another tool.
    await assert.rejects(
      runner.execute(null, {
        toolId: 'delete_all',
        toolDef: lookup,
        args: {},
        toolContext: chatContext()
      }),
      refusal(TOOL_REFUSAL_CODES.NOT_RESOLVED)
    );
    assert.equal(calls.length, 0);
    await runner.execute(null, {
      toolId: 'lookup',
      toolDef: lookup,
      args: {},
      toolContext: chatContext()
    });
    assert.equal(calls.length, 1);
  });

  it('approval-decided: a caller states who decides the approval of a call, or it is refused', async () => {
    const { runner, calls } = spyRunner();
    for (const approval of [undefined, 'none', 'auto']) {
      await assert.rejects(
        runner.execute(null, {
          toolId: 'lookup',
          toolDef: lookup,
          args: {},
          toolContext: chatContext({ approval })
        }),
        refusal(TOOL_REFUSAL_CODES.APPROVAL_UNDECIDED)
      );
    }
    assert.equal(calls.length, 0);
    assert.deepEqual([...APPROVAL_DECIDERS], ['seam', 'refuse', 'caller']);
  });

  it('approval-refused-nobody: a gated tool where nobody can approve is refused with APPROVAL_REQUIRED_NO_USER', async () => {
    const { runner, calls } = spyRunner();
    const gated = { id: 'jira_comment', approval: 'always' };
    const open = { id: 'lookup' };
    const gateway = { origin: 'mcp', approval: 'refuse', argsFrom: 'caller', principal: USER };
    await assert.rejects(
      runner.execute(null, { toolId: gated.id, toolDef: gated, args: {}, toolContext: gateway }),
      refusal(APPROVAL_ERROR_CODES.APPROVAL_REQUIRED_NO_USER)
    );
    // The platform default gates every tool: an open tool is refused too.
    await assert.rejects(
      runner.execute(null, {
        toolId: open.id,
        toolDef: open,
        args: {},
        toolContext: { ...gateway, platform: { toolApproval: { defaults: { default: 'always' } } } }
      }),
      refusal(APPROVAL_ERROR_CODES.APPROVAL_REQUIRED_NO_USER)
    );
    assert.equal(calls.length, 0);
    await runner.execute(null, { toolId: open.id, toolDef: open, args: {}, toolContext: gateway });
    // Where the run's approval seam decided (it runs before the call), the runner does not ask again.
    await runner.execute(null, {
      toolId: gated.id,
      toolDef: gated,
      args: {},
      toolContext: chatContext()
    });
    assert.deepEqual(
      calls.map(call => call.toolId),
      ['lookup', 'jira_comment']
    );
  });

  it('page-read-cap: past the turn cap the gate answers a page read itself', async () => {
    const { runner, calls } = spyRunner();
    const reader = { id: 'read_url' };
    const pageReads = createPageReadGate(1);
    const read = () =>
      runner.execute(null, {
        toolId: 'read_url',
        toolDef: reader,
        args: { url: 'https://example.com' },
        toolContext: chatContext({ pageReads })
      });
    assert.deepEqual(await read(), { ok: true });
    const capped = await read();
    assert.equal(capped.code, PAGE_READ_LIMIT_CODE);
    assert.equal(calls.length, 1);
    // Opt-in: a caller without a gate (a single gateway call) is not capped.
    await runner.execute(null, {
      toolId: 'read_url',
      toolDef: reader,
      args: {},
      toolContext: { origin: 'mcp', approval: 'caller', argsFrom: 'caller', principal: USER }
    });
    assert.equal(calls.length, 2);
  });

  it('reserved-keys-caller: arguments of an external caller never carry iHub context', async () => {
    const { runner, calls } = spyRunner();
    const forged = Object.fromEntries(
      RESERVED_TOOL_CONTEXT_KEYS.map(key => [key, `forged-${key}`])
    );
    await runner.execute(null, {
      toolId: 'lookup',
      toolDef: lookup,
      args: { q: 'x', ...forged, user: { id: 'bob' } },
      toolContext: {
        origin: 'mcp',
        approval: 'caller',
        argsFrom: 'caller',
        principal: USER,
        chatId: 'mcp-1'
      }
    });
    const { params } = calls[0];
    assert.equal(params.user, USER);
    assert.equal(params.chatId, 'mcp-1');
    assert.equal(params.q, 'x');
    for (const key of RESERVED_TOOL_CONTEXT_KEYS.filter(k => !['user', 'chatId'].includes(k))) {
      assert.equal(key in params, false, `${key} was passed through`);
    }
  });

  it('reserved-keys-model: a model cannot set iHub context, except a parameter the tool itself declares', async () => {
    const { runner, calls } = spyRunner();
    const workflow = workflowToolDef('report');
    // A workflow started from the chat: before, `runId` named the execution
    // and `_fileData` / `_chatHistory` / `passthrough` reached the workflow.
    await runner.execute(null, {
      toolId: workflow.id,
      toolDef: workflow,
      args: {
        input: 'go',
        runId: 'wf-chosen-by-the-model',
        _fileData: [{ name: 'fake.pdf' }],
        _chatHistory: [{ role: 'user', content: 'fake' }],
        passthrough: true,
        user: { id: 'bob' },
        appConfig: { id: 'other' },
        integrationScopes: { search: 'other' }
      },
      toolContext: chatContext({ chatStored: true })
    });
    const params = calls[0].params;
    assert.equal(params.input, 'go');
    for (const key of ['runId', '_fileData', '_chatHistory', 'passthrough']) {
      assert.equal(key in params, false, `${key} was passed through`);
    }
    assert.equal(params.user, USER);
    assert.equal(params.appConfig, APP);
    assert.deepEqual(params.integrationScopes, { search: 'profile-a' });
    // The evidence tools declare `runId` themselves: it stays theirs.
    const evidence = {
      id: 'evidence_collect',
      parameters: { type: 'object', properties: { runId: { type: 'string' } } }
    };
    await runner.execute(null, {
      toolId: evidence.id,
      toolDef: evidence,
      args: { runId: 'run-7', user: { id: 'bob' } },
      toolContext: chatContext()
    });
    assert.equal(calls[1].params.runId, 'run-7');
    assert.equal(calls[1].params.user, USER);
  });

  it('trusted-context: the context of each caller is set after the arguments and always wins', () => {
    const turnSkills = { note() {} };
    const chat = buildToolParams({
      toolId: 'workflow_report',
      toolDef: { id: 'workflow_report' },
      args: { input: 'go' },
      toolContext: chatContext({ turnSkills, clientTimezone: 'Europe/Berlin', chatStored: false })
    });
    assert.deepEqual(Object.keys(chat), [
      'language',
      'input',
      'chatId',
      'user',
      'appConfig',
      'integrationScopes',
      'turnSkills',
      'clientTimezone',
      '_chatStored'
    ]);
    assert.equal(chat._chatStored, false);
    const passthrough = buildToolParams({
      toolId: 'workflow_report',
      toolDef: { id: 'workflow_report' },
      args: { input: 'go' },
      toolContext: {
        origin: 'chat',
        approval: 'seam',
        principal: USER,
        chatId: 'chat-1',
        passthrough: true,
        appConfig: APP,
        integrationScopes: {},
        fileData: [{ name: 'upload.pdf' }],
        chatStored: true
      }
    });
    assert.deepEqual(Object.keys(passthrough), [
      'input',
      'chatId',
      'user',
      'passthrough',
      'appConfig',
      'integrationScopes',
      '_fileData',
      '_chatStored'
    ]);
    // Workflow plumbing only goes to a workflow.
    const plain = buildToolParams({
      toolId: 'lookup',
      toolDef: lookup,
      args: {},
      toolContext: chatContext({ chatStored: true, fileData: [{}] })
    });
    assert.equal('_chatStored' in plain, false);
    assert.equal('_fileData' in plain, false);
    // An unknown timezone is not set: the model's own default may stand.
    assert.equal(
      buildToolParams({
        toolId: 'lookup',
        toolDef: lookup,
        args: { clientTimezone: 'UTC' },
        toolContext: chatContext()
      }).clientTimezone,
      'UTC'
    );
  });

  it('language: a model may name the language of its call, an external caller may not', () => {
    const model = buildToolParams({
      toolId: 'lookup',
      toolDef: lookup,
      args: { language: 'fr' },
      toolContext: chatContext()
    });
    assert.equal(model.language, 'fr');
    assert.equal(
      buildToolParams({ toolId: 'lookup', toolDef: lookup, args: {}, toolContext: chatContext() })
        .language,
      'de'
    );
    const caller = buildToolParams({
      toolId: 'workflow_report',
      toolDef: { id: 'workflow_report' },
      args: { input: 'go', language: 'fr' },
      toolContext: { origin: 'a2a', approval: 'caller', argsFrom: 'caller', language: 'en' }
    });
    assert.equal(caller.language, 'en');
  });

  it('argument-repair: a raw model call is repaired when the caller hands no parsed arguments', async () => {
    const { runner, calls } = spyRunner();
    await runner.execute(
      { id: 'c1', function: { name: 'lookup', arguments: 'Here: {"q": "claims"} ok' } },
      { toolId: 'lookup', toolDef: lookup, toolContext: chatContext() }
    );
    assert.equal(calls[0].params.q, 'claims');
    // A missing closing brace.
    await runner.execute(
      { id: 'c0', function: { name: 'lookup', arguments: '{"q": "files"' } },
      { toolId: 'lookup', toolDef: lookup, toolContext: chatContext() }
    );
    assert.equal(calls[1].params.q, 'files');
    calls.shift();
    // Parsed arguments win over the raw text.
    await runner.execute(
      { id: 'c2', function: { name: 'lookup', arguments: '{"q":"raw"}' } },
      { toolId: 'lookup', toolDef: lookup, args: { q: 'parsed' }, toolContext: chatContext() }
    );
    assert.equal(calls[1].params.q, 'parsed');
  });

  it('app-tool-routing: an app__ call goes to the app-as-tool gateway with the caller and its abort signal', async () => {
    const { runner, calls, appCalls } = spyRunner();
    const controller = new AbortController();
    const answer = await runner.execute(null, {
      toolId: 'app__specialist',
      toolDef: { id: 'app__specialist' },
      args: { message: 'How do I file a claim?', user: { id: 'bob' } },
      signal: controller.signal,
      toolContext: chatContext()
    });
    assert.deepEqual(answer, { content: 'app answer' });
    assert.equal(calls.length, 0);
    assert.equal(appCalls.length, 1);
    const request = appCalls[0];
    assert.equal(request.toolId, 'app__specialist');
    assert.equal(request.user, USER);
    assert.equal(request.chatId, 'chat-1');
    assert.equal(request.language, 'de');
    assert.equal(request.callerAppId, 'concierge');
    assert.equal(request.abortSignal, controller.signal);
    assert.equal(request.args.message, 'How do I file a claim?');
    assert.equal('user' in request.args, false);
    assert.equal('chatId' in request.args, false);
  });

  it('abort-signal: the caller abort signal and the MCP App sink reach the tool', async () => {
    const { runner, calls } = spyRunner();
    const controller = new AbortController();
    const onMcpAppResult = () => {};
    await runner.execute(null, {
      toolId: 'lookup',
      toolDef: lookup,
      args: {},
      signal: controller.signal,
      toolContext: chatContext({ onMcpAppResult })
    });
    assert.equal(calls[0].options.signal, controller.signal);
    assert.equal(calls[0].options.onMcpAppResult, onMcpAppResult);
    // A caller without either passes no options.
    await runner.execute(null, {
      toolId: 'lookup',
      toolDef: lookup,
      args: {},
      toolContext: { origin: 'mcp', approval: 'caller', argsFrom: 'caller', principal: USER }
    });
    assert.deepEqual(calls[1].options, {});
  });

  it('display: every call is logged with the display fields toolDisplayOf decides', async () => {
    const logger = (await import('../../utils/logger.js')).default;
    const seen = [];
    const original = logger.info;
    logger.info = (message, meta) => {
      if (message === 'Tool call') seen.push(meta);
    };
    try {
      const { runner } = spyRunner();
      const integrationTool = {
        id: 'jira_search',
        _integration: { instanceId: 'jira', action: 'search', actionTitle: 'Search issues' }
      };
      await runner.execute(null, {
        toolId: integrationTool.id,
        toolDef: integrationTool,
        args: {},
        toolContext: { origin: 'mcp', approval: 'caller', argsFrom: 'caller', principal: USER }
      });
      const { toolDisplayOf } = await import('../../utils/toolDisplay.js');
      assert.equal(seen.length, 1);
      assert.equal(seen[0].origin, 'mcp');
      assert.equal(seen[0].userId, 'alice');
      const display = toolDisplayOf(integrationTool);
      for (const key of ['title', 'integration', 'activityKind', 'activityOrigin']) {
        assert.deepEqual(seen[0][key], display[key], key);
      }
      assert.equal(seen[0].title, 'Search issues');
    } finally {
      logger.info = original;
    }
  });

  it('workflow-prefix: the runner knows a workflow tool by the catalog prefix', () => {
    assert.equal(workflowToolDef('x').id, `${WORKFLOW_TOOL_ID_PREFIX}x`);
  });
});

describe('tool runner checks that stay in runTool (S10)', () => {
  const WORKFLOW = {
    id: 'summarize-report',
    name: { en: 'Summarize report' },
    enabled: true,
    chatIntegration: { enabled: true },
    nodes: [],
    edges: []
  };
  const runner = new ToolRunner();
  const caller = user => ({
    origin: 'mcp',
    approval: 'caller',
    argsFrom: 'caller',
    principal: user
  });

  before(() => {
    configCache.getPlatform = () => ({ defaultLanguage: 'en' });
    configCache.getSources = () => ({ data: [] });
    configCache.getSkills = () => ({ data: [], etag: 'e' });
    configCache.getFeatures = () => ({ skills: true });
    configCache.setCacheEntry('config/workflows.json', [WORKFLOW]);
    mcpClientManager.listAllTools = async () => [];
    a2aClientManager.listAllTools = async () => [];
  });

  it('tool-exists: a tool that is neither built in nor installed is not found', async () => {
    await assert.rejects(
      runner.execute(null, {
        toolId: 'no_such_tool',
        toolDef: { id: 'no_such_tool' },
        args: {},
        toolContext: caller(USER)
      }),
      /Tool no_such_tool not found/
    );
  });

  it('workflow-access: a workflow runs only for a principal whose groups grant it', async () => {
    const toolDef = workflowToolDef(WORKFLOW.id, WORKFLOW);
    const outsider = { id: 'user-3', permissions: { workflows: new Set(['other']) } };
    await assert.rejects(
      runner.execute(null, {
        toolId: toolDef.id,
        toolDef,
        args: { input: 'go' },
        toolContext: caller(outsider)
      }),
      /not found/
    );
  });

  it('system-skill-permission: a system skill tool runs only for a user with the skill', async () => {
    await assert.rejects(
      runner.execute(null, {
        toolId: 'create_pdf',
        toolDef: { id: 'create_pdf' },
        args: { title: 't', markdown: 'x' },
        toolContext: caller({ id: 'user-1', permissions: { skills: new Set() } })
      }),
      /not available/
    );
  });

  it('skill-usable: a skill the app or the user may not use is answered like a missing one', async () => {
    const answer = await runner.execute(null, {
      toolId: 'activate_skill',
      toolDef: { id: 'activate_skill' },
      args: { skill_name: 'secret-skill' },
      toolContext: {
        origin: 'chat',
        approval: 'seam',
        principal: { id: 'user-1', permissions: { skills: new Set(['*']) } },
        appConfig: { id: 'writer', skills: [], skillSettings: { enabled: true } }
      }
    });
    assert.match(String(answer), /not found or could not be loaded/);
  });
});

describe('the passthrough seam runs through the tool runner', () => {
  it('passthrough-context: a passthrough call carries the chat context and the upload of a workflow', async () => {
    const { chatPassthroughOptions } = await import('../../services/chat/chatSeams.js');
    const { runner, calls } = spyRunner({ result: 'streamed answer' });
    const options = chatPassthroughOptions({
      chatId: 'chat-1',
      chatStored: true,
      user: USER,
      app: APP,
      userFileData: [{ name: 'upload.pdf' }],
      streaming: false,
      buildLogData: () => ({}),
      logInteraction: async () => {},
      toolRunner: runner
    });
    const controller = new AbortController();
    const toolDef = { id: 'workflow_report', passthrough: true };
    const response = await options.execute(
      {
        toolId: toolDef.id,
        toolDef,
        args: { input: 'go', runId: 'model-run', _chatHistory: [] },
        call: { id: 'c1' }
      },
      { signal: controller.signal }
    );
    assert.equal(response, 'streamed answer');
    const { params, options: runOptions } = calls[0];
    assert.equal(params.passthrough, true);
    assert.equal(params.user, USER);
    assert.equal(params.chatId, 'chat-1');
    assert.deepEqual(params._fileData, [{ name: 'upload.pdf' }]);
    assert.equal(params._chatStored, true);
    assert.equal('runId' in params, false);
    assert.equal('_chatHistory' in params, false);
    assert.equal(runOptions.signal, controller.signal);
  });
});
