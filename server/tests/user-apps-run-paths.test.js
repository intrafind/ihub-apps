// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Where a personal app runs, and where it does not (feature `userApps`,
 * design sections 7.3 to 7.5).
 *
 * The interactive chat is the only run path. The owner and the people the app
 * is shared with chat through the normal chat route; everyone else gets the
 * 404 of an unknown ID, on an installation with and without the `apps: ["*"]`
 * wildcard. Every other way of running an app (scheduled task, app as a tool,
 * workflow, inference API, MCP, A2A) answers for a personal ID as for an
 * unknown one. And the sites that fall back to a default for an unknown app
 * (the upload policy of a chat, attaching a project, feedback) refuse a
 * personal-shaped ID that does not resolve.
 *
 * The real routes and services run over a populated config cache and a
 * filesystem store in a scratch directory. The only stubs are the model
 * (`runTurn`, `llmClient.complete`) and the API key check.
 *
 * Run: node --test server/tests/user-apps-run-paths.test.js
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import configCache from '../configCache.js';
import RequestBuilder from '../services/chat/RequestBuilder.js';
import { beginTranscriptionTurn } from '../services/chat/transcriptionTurn.js';
import { getAppAsTools, invokeAppTool } from '../services/chat/appToolsGateway.js';
import { RunService, appRunSpec } from '../services/run/RunService.js';
import { HeadlessHost } from '../services/run/hosts/HeadlessHost.js';
import { requestRunContext } from '../services/run/principalResolver.js';
import * as tasks from '../services/scheduler/tasks/taskService.js';
import { executeTaskRun } from '../services/scheduler/tasks/taskExecution.js';
import { getScheduledTaskRepository } from '../services/scheduler/tasks/ScheduledTaskRepository.js';
import { getExecutionRegistry } from '../services/workflow/ExecutionRegistry.js';
import {
  listInvocableApps,
  resolveInferenceTarget
} from '../services/inference/modelIdentifier.js';
import { resolveInvokableApp } from '../services/mcp/appInvoker.js';
import { listA2aSkills } from '../services/mcp/a2aHandler.js';
import conversationApiService from '../services/integrations/ConversationApiService.js';
import { queryAuditLog } from '../services/AuditLogService.js';
import { isUserAppId } from '../../shared/userAppContent.js';
import {
  ADMIN_APP,
  APPS,
  FEATURES,
  SECRET,
  UNKNOWN_PERSONAL_ID,
  chatBody,
  groupsWith,
  member,
  setConfig,
  shape,
  startUserAppsHarness
} from './helpers/userAppsHarness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

let harness;
let user;
let as;

before(async () => {
  harness = await startUserAppsHarness();
  ({ user, as } = harness);
});
after(() => harness.stop());
beforeEach(() => harness.reset());

/** An app of Anna, shared with Ben ("Can use") and Carol ("Can edit"). */
const sharedApp = (options = {}) =>
  harness.createApp('anna', {
    members: [member('ben', 'user'), member('carol', 'editor')],
    ...options
  });

const postChat = (name, appId, body = chatBody(), chatId = randomUUID()) =>
  as(name).post(`/api/apps/${appId}/chat/${chatId}`).send(body);

const WILDCARD = [
  ['with the `apps: ["*"]` wildcard', true],
  ['without the wildcard', false]
];

describe('the interactive chat runs a personal app', () => {
  for (const [label, wildcard] of WILDCARD) {
    describe(label, () => {
      beforeEach(() => setConfig({ groups: groupsWith({ wildcard }) }));

      it('the owner and each member chat through the normal chat route', async () => {
        const record = await sharedApp();
        for (const [name, mode] of [
          ['anna', 'writes'],
          ['ben', 'always'],
          ['carol', 'always']
        ]) {
          const res = await postChat(name, record.id);
          assert.equal(res.status, 200, `${name}: ${res.text}`);
          assert.equal(res.body.status, 'streaming', name);
          const turn = harness.turns.at(-1);
          assert.equal(turn.chatId, res.body.chatId, name);
          // The turn runs the app object of the ceiling.
          assert.equal(turn.prep.app.id, record.id, name);
          assert.equal(turn.prep.app.toolApproval.default, mode, name);
          assert.equal(turn.prep.app.features.userProjects, false, name);
          assert.ok(JSON.stringify(turn.prep.llmMessages).includes(SECRET), name);
          assert.equal(turn.toolApproval.chatGrants, name === 'anna', name);
        }
        assert.equal(harness.turns.length, 3);
      });

      it('a user without a share gets the 404 of an unknown ID', async () => {
        const record = await sharedApp();
        const unknown = await postChat('mallory', UNKNOWN_PERSONAL_ID);
        assert.equal(unknown.status, 404);
        for (const name of ['mallory', 'builder', 'benKey', 'benDelegated', 'client', 'agent']) {
          const res = await postChat(name, record.id);
          assert.deepEqual(shape(res, record.id), shape(unknown, UNKNOWN_PERSONAL_ID), name);
          assert.equal(res.text.includes(SECRET), false, name);
        }
        const anonymous = await postChat('anonymous', record.id);
        assert.equal(anonymous.status, 404);
        assert.equal(harness.turns.length, 0);
      });

      it('an admin app is checked as before', async () => {
        const res = await postChat('ben', ADMIN_APP);
        assert.equal(res.status, 200);
        assert.equal(harness.turns.at(-1).prep.app.id, ADMIN_APP);
        // The grant for the chat exists in every chat but a personal app of someone else.
        assert.equal(harness.turns.at(-1).toolApproval.chatGrants, true);
      });
    });
  }

  it('without the wildcard an admin app the groups do not grant still answers 403, not 404', async () => {
    setConfig({ groups: groupsWith({ wildcard: false }) });
    const res = await postChat('ben', 'app-staff');
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'APP_ACCESS_DENIED');
  });

  it('a personal API key runs its user’s own app and gets 404 for a shared one', async () => {
    const own = await harness.createApp('anna');
    const shared = await sharedApp();
    const viaKey = await postChat('annaKey', own.id);
    assert.equal(viaKey.status, 200, viaKey.text);
    assert.equal(harness.turns.at(-1).prep.app.id, own.id);
    const unknown = await postChat('benKey', UNKNOWN_PERSONAL_ID);
    const refused = await postChat('benKey', shared.id);
    assert.deepEqual(shape(refused, shared.id), shape(unknown, UNKNOWN_PERSONAL_ID));
    assert.equal(harness.turns.length, 1);
  });

  it('a full admin who is no member chats, and the audit entry says so', async () => {
    const record = await sharedApp();
    const chatId = randomUUID();
    const res = await postChat('root', record.id, chatBody(), chatId);
    assert.equal(res.status, 200, res.text);
    assert.equal(harness.turns.at(-1).prep.app.toolApproval.default, 'always');
    const { entries } = await queryAuditLog({ resource: 'userApp', action: 'execute', limit: 500 });
    const entry = entries.find(candidate => candidate.details?.chatId === chatId);
    assert.ok(entry, 'an execute entry for this chat');
    assert.equal(entry.resourceId, record.id);
    assert.equal(entry.details.role, 'admin');
    assert.equal(entry.details.ownerId, 'anna');
    assert.equal(entry.details.revision, 2);
    assert.equal(entry.details.contentHash, record.contentHash);
    assert.equal(JSON.stringify(entry).includes(SECRET), false);
  });

  it('writes one audit entry per chat and revision, and notes the use', async () => {
    const record = await sharedApp();
    const chatId = randomUUID();
    const entriesOf = async () =>
      (await queryAuditLog({ resource: 'userApp', action: 'execute', limit: 500 })).entries.filter(
        entry => entry.details?.chatId === chatId
      );
    assert.equal((await postChat('ben', record.id, chatBody(), chatId)).status, 200);
    assert.equal((await postChat('ben', record.id, chatBody(), chatId)).status, 200);
    let entries = await entriesOf();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].details.role, 'user');
    assert.ok((await harness.repo().get(record.id)).lastUsedAt);

    // A save gives the app a new revision: the next turn of the chat is recorded again.
    const saved = await harness
      .repo()
      .update(
        record.id,
        { ...record.content, system: { en: 'Changed instructions.' } },
        { actor: { id: 'anna', name: 'Anna Schmidt' } }
      );
    assert.equal((await postChat('ben', record.id, chatBody(), chatId)).status, 200);
    entries = await entriesOf();
    assert.deepEqual(entries.map(entry => entry.details.revision).sort(), [2, saved.revision]);
    assert.notEqual(entries[0].details.contentHash, entries[1].details.contentHash);
  });

  it('a chat of an admin app writes no such entry', async () => {
    const chatId = randomUUID();
    assert.equal((await postChat('ben', ADMIN_APP, chatBody(), chatId)).status, 200);
    const { entries } = await queryAuditLog({ resource: 'userApp', action: 'execute', limit: 500 });
    assert.equal(entries.filter(entry => entry.details?.chatId === chatId).length, 0);
  });

  it('with the feature off the chat route answers 404 for a personal ID, for the owner too', async () => {
    const record = await sharedApp();
    setConfig({ features: { ...FEATURES, userApps: false } });
    const unknown = await postChat('anna', UNKNOWN_PERSONAL_ID);
    assert.equal(unknown.status, 404);
    for (const name of ['anna', 'ben', 'root']) {
      const res = await postChat(name, record.id);
      assert.deepEqual(shape(res, record.id), shape(unknown, UNKNOWN_PERSONAL_ID), name);
    }
    assert.equal(harness.turns.length, 0);
  });

  it('a switched-off app, a blocked owner and suspended shares answer 404 on the chat route', async () => {
    const off = await sharedApp({
      change: current => ({
        ...current,
        disabled: { at: new Date().toISOString(), by: { id: 'root' }, reason: 'Check first' }
      })
    });
    for (const name of ['anna', 'ben', 'carol']) {
      assert.equal((await postChat(name, off.id)).status, 404, name);
    }
    assert.equal((await postChat('root', off.id)).status, 200);

    const record = await sharedApp();
    setConfig({ userApps: { blockedOwners: ['anna'] } });
    for (const name of ['anna', 'ben', 'carol', 'root']) {
      assert.equal((await postChat(name, record.id)).status, 404, name);
    }
  });

  it('nothing of the request decides: no body field, query or header opens a personal app', async () => {
    const record = await sharedApp();
    const unknown = await postChat('mallory', UNKNOWN_PERSONAL_ID);
    const res = await as('mallory')
      .post(`/api/apps/${record.id}/chat/${randomUUID()}`)
      .query({ owner: 'mallory', role: 'owner', scope: 'mine' })
      .set({ 'x-user-app-owner': 'mallory', 'x-user-app-role': 'owner' })
      .send(
        chatBody({
          userApp: { permissions: { canUse: true } },
          owner: { id: 'mallory' },
          members: [{ type: 'user', id: 'mallory', role: 'editor' }]
        })
      );
    assert.deepEqual(shape(res, record.id), shape(unknown, UNKNOWN_PERSONAL_ID));
    assert.equal(harness.turns.length, 0);
  });

  it('the other chat routes of the app use the same gate', async () => {
    const record = await sharedApp();
    const stop = name => as(name).post(`/api/apps/${record.id}/chat/${randomUUID()}/stop`);
    assert.equal((await stop('mallory')).status, 404);
    assert.notEqual((await stop('ben')).status, 403);
  });
});

describe('the routes the chat page calls', () => {
  it('magic prompt: a member gets it, a user without a share the 404 of an unknown app', async () => {
    const record = await sharedApp();
    const ask = (name, appId) =>
      as(name).post('/api/magic-prompt').send({ input: 'make it better', appId });
    setConfig({ groups: groupsWith({ wildcard: false }) });
    assert.equal((await ask('ben', record.id)).status, 200);
    const unknown = await ask('mallory', UNKNOWN_PERSONAL_ID);
    assert.equal(unknown.status, 404);
    assert.deepEqual(
      shape(await ask('mallory', record.id), record.id),
      shape(unknown, UNKNOWN_PERSONAL_ID)
    );
  });

  it('integration scopes, picker and preferences: the same', async () => {
    const record = await sharedApp();
    setConfig({ groups: groupsWith({ wildcard: false }) });
    const sites = [
      (name, appId) => as(name).get('/api/integrations/scopes').query({ appId }),
      (name, appId) => as(name).get('/api/integrations/picker').query({ app: appId }),
      (name, appId) => as(name).get('/api/integrations/preferences').query({ app: appId })
    ];
    for (const [index, send] of sites.entries()) {
      assert.equal((await send('ben', record.id)).status, 200, `site ${index}`);
      const unknown = await send('mallory', UNKNOWN_PERSONAL_ID);
      assert.equal(unknown.status, 404, `site ${index}`);
      assert.deepEqual(
        shape(await send('mallory', record.id), record.id),
        shape(unknown, UNKNOWN_PERSONAL_ID),
        `site ${index}`
      );
    }
  });

  it('the audio turn: a member’s turn is taken, a user without a share is not permitted', async () => {
    const record = await sharedApp();
    setConfig({ groups: groupsWith({ wildcard: false }) });
    const turn = name =>
      beginTranscriptionTurn({
        user: user(name),
        chatId: randomUUID(),
        appId: record.id,
        modelId: 'oa',
        clientMessageId: 'm1',
        attachment: { name: 'audio.wav' }
      });
    assert.equal((await turn('ben')).ok, true);
    assert.deepEqual(await turn('mallory'), { ok: false, code: 'not-permitted' });
    assert.deepEqual(
      await beginTranscriptionTurn({
        user: user('ben'),
        chatId: randomUUID(),
        appId: UNKNOWN_PERSONAL_ID,
        modelId: 'oa',
        clientMessageId: 'm1',
        attachment: { name: 'audio.wav' }
      }),
      { ok: false, code: 'not-permitted' }
    );
  });

  it('deleting a conversation of a personal app the caller can no longer use stays possible', async t => {
    const record = await sharedApp();
    const deleted = [];
    const original = conversationApiService.deleteConversation;
    conversationApiService.deleteConversation = async (id, options) => {
      deleted.push({ id, baseUrl: options.baseUrl });
    };
    t.after(() => {
      conversationApiService.deleteConversation = original;
    });
    const send = (name, appId) => as(name).delete(`/apps/${appId}/conversations/conv-1`);
    const forMember = await send('ben', record.id);
    const forStranger = await send('mallory', record.id);
    // Neither is answered "App not found": the conversation is the caller's own.
    for (const res of [forMember, forStranger]) {
      assert.notEqual(res.status, 404);
      assert.equal(res.text.includes(SECRET), false);
    }
    assert.equal(forMember.status, forStranger.status);
    // An unknown admin app is still refused.
    assert.equal((await send('ben', 'no-such-app')).status, 404);
  });
});

describe('the sites that fall back to a default for an unknown app (7.1)', () => {
  const upload = (name, chatId, appId) => {
    const req = as(name).post(`/api/chats/${chatId}/files`);
    return (appId ? req.field('appId', appId) : req).attach(
      'file',
      Buffer.from('some text'),
      'note.txt'
    );
  };
  const withUpload = on => ({
    content: { capabilities: { upload: on, webSearch: false, skills: false, integrations: [] } }
  });

  it('a file upload into a chat of a personal app the caller can no longer use answers 404', async () => {
    const record = await sharedApp(withUpload(true));
    const chatId = await harness.seedChat('ben', record.id);
    assert.equal((await upload('ben', chatId)).status, 201);

    // Ben loses the share: the chat is still his, the app is not.
    await harness.repo().setMembers(record.id, [member('carol', 'editor')], {
      actor: { id: 'anna', name: 'Anna Schmidt' }
    });
    const refused = await upload('ben', chatId);
    assert.equal(refused.status, 404);
    assert.equal(refused.body.code, 'NOT_FOUND');

    // The same for a deleted app, a switched-off feature and an ID nobody has.
    const gone = await harness.seedChat('ben', UNKNOWN_PERSONAL_ID);
    assert.equal((await upload('ben', gone)).status, 404);
    assert.equal((await upload('ben', randomUUID(), UNKNOWN_PERSONAL_ID)).status, 404);
    const carols = await harness.seedChat('carol', record.id);
    setConfig({ features: { ...FEATURES, userApps: false } });
    assert.equal((await upload('carol', carols)).status, 404);
  });

  it('an upload into an app with `upload` off is refused, not given the base policy', async () => {
    const record = await sharedApp(withUpload(false));
    for (const name of ['anna', 'ben']) {
      const res = await upload(name, await harness.seedChat(name, record.id));
      assert.equal(res.body.code, 'UPLOADS_DISABLED', `${name}: ${res.text}`);
      assert.notEqual(res.status, 201, name);
    }
    // Before the first message too, when the request names the app.
    assert.equal((await upload('ben', randomUUID(), record.id)).body.code, 'UPLOADS_DISABLED');
  });

  it('an upload the owner allowed and the installation later switched off is refused', async () => {
    const record = await sharedApp(withUpload(true));
    const chatId = await harness.seedChat('ben', record.id);
    assert.equal((await upload('ben', chatId)).status, 201);
    setConfig({ userApps: { capabilities: { upload: false } } });
    assert.equal((await upload('ben', chatId)).body.code, 'UPLOADS_DISABLED');
  });

  it('an unknown admin app keeps the base policy, as before', async () => {
    assert.equal((await upload('ben', randomUUID(), 'no-such-app')).status, 201);
    assert.equal((await upload('ben', randomUUID())).status, 201);
  });

  it('attaching a project to a chat of a personal app is refused, whether or not the app resolves', async () => {
    const record = await sharedApp();
    const attach = async (name, appId) =>
      as(name)
        .patch(`/api/chats/${await harness.seedChat(name, appId)}`)
        .send({ attachedProjectIds: ['no-such-project'] });

    // Resolves: a personal app takes no projects.
    for (const name of ['anna', 'ben']) {
      const res = await attach(name, record.id);
      assert.equal(res.body.code, 'APP_PROJECTS_DISABLED', `${name}: ${res.text}`);
    }
    // Does not resolve: refused too, instead of skipping the app's check.
    const stranger = await attach('mallory', record.id);
    assert.equal(stranger.status, 404);
    assert.equal(stranger.body.code, 'NOT_FOUND');
    const unknown = await attach('ben', UNKNOWN_PERSONAL_ID);
    assert.equal(unknown.status, 404);
    // An admin app that takes projects still gets to the project check.
    const admin = await attach('ben', ADMIN_APP);
    assert.notEqual(admin.body.code, 'APP_PROJECTS_DISABLED');
    assert.equal(admin.body.detail, 'Project not found');
  });

  it('feedback for a personal app the caller cannot use answers 404, and is accepted from a member', async () => {
    const record = await sharedApp();
    const rate = (name, appId) =>
      as(name)
        .post('/api/feedback')
        .send({ messageId: 'm1', appId, chatId: randomUUID(), rating: 5 });
    assert.equal((await rate('ben', record.id)).status, 204);
    assert.equal((await rate('anna', record.id)).status, 204);
    for (const [name, appId] of [
      ['mallory', record.id],
      ['benKey', record.id],
      ['ben', UNKNOWN_PERSONAL_ID]
    ]) {
      const res = await rate(name, appId);
      assert.equal(res.status, 404, `${name} ${appId}`);
      assert.equal(res.body.code, 'NOT_FOUND');
    }
    setConfig({ features: { ...FEATURES, userApps: false } });
    assert.equal((await rate('ben', record.id)).status, 404);
    // An unknown admin app is still not gated, as before.
    setConfig();
    assert.equal((await rate('ben', 'no-such-app')).status, 204);
  });
});

describe('every other run path answers for a personal app as for an unknown ID (7.5)', () => {
  it('no list of the config cache ever holds a personal app', async () => {
    const record = await sharedApp();
    const ids = list => (list?.data || []).map(app => app.id);
    assert.equal(ids(configCache.getApps()).some(isUserAppId), false);
    assert.equal(ids(configCache.getApps(true)).some(isUserAppId), false);
    for (const name of ['anna', 'ben', 'root']) {
      const forUser = await configCache.getAppsForUser(user(name), configCache.getPlatform());
      assert.equal(ids(forUser).includes(record.id), false, name);
    }
    assert.equal(configCache.getAppForRequest(record.id, user('anna')), null);
  });

  it('scheduled task: cannot be created on a personal app, by its owner either', async () => {
    const record = await harness.createApp('anna');
    const issuesOf = async (name, appId) => {
      try {
        await tasks.createTask(user(name), {
          name: 'Digest',
          instructions: 'Report.',
          appId,
          schedule: { type: 'daily', time: '08:00', timezone: 'Europe/Berlin' }
        });
      } catch (error) {
        return (error.details?.issues || []).map(issue => `${issue.field}:${issue.code}`);
      }
      return ['created'];
    };
    const unknown = await issuesOf('anna', 'no-such-app');
    assert.deepEqual(unknown, ['appId:APP_NOT_FOUND']);
    assert.deepEqual(await issuesOf('anna', record.id), unknown);
    assert.deepEqual(await issuesOf('root', record.id), unknown);
  });

  it('scheduled task: a run whose task names a personal app is skipped', async () => {
    const record = await harness.createApp('anna');
    const TASK_APP = 'app-task';
    setConfig({ apps: [...APPS, { ...APPS[0], id: TASK_APP }] });
    const owner = user('anna');
    const task = await tasks.createTask(owner, {
      name: 'Digest',
      instructions: 'Report.',
      appId: TASK_APP,
      schedule: { type: 'daily', time: '08:00', timezone: 'Europe/Berlin' }
    });
    // No route stores such a task; the stored document is changed by hand.
    await getScheduledTaskRepository().mutateTask(task.id, stored => ({
      ...stored,
      appId: record.id
    }));
    const queued = await tasks.requestRun(owner, task.id);
    let prepared = 0;
    const chatService = {
      prepareChatRequest: async () => {
        prepared += 1;
        return { success: false, error: { code: 'TEST', message: 'must not be reached' } };
      },
      runTurn: async () => {
        prepared += 1;
        return { status: 'error' };
      }
    };
    const run = await executeTaskRun({ taskId: task.id, runId: queued.id }, { chatService });
    assert.equal(run.status, 'skipped');
    assert.equal(run.reason.code, 'APP_NOT_AVAILABLE');
    assert.equal(prepared, 0, 'the request was never prepared');
    await tasks.deleteTask(owner, task.id);
  });

  it('app as a tool: an admin app that lists a personal ID does not offer it', async () => {
    const record = await sharedApp();
    const CALLER = 'app-caller';
    setConfig({ apps: [...APPS, { ...APPS[0], id: CALLER, apps: [record.id, ADMIN_APP] }] });
    for (const name of ['anna', 'root']) {
      const offered = await getAppAsTools([record.id, ADMIN_APP], 'en', { user: user(name) });
      assert.deepEqual(
        offered.map(tool => tool.id),
        [`app__${ADMIN_APP}`],
        name
      );
    }
    const prepared = await new RequestBuilder().prepareChatRequest({
      appId: CALLER,
      modelId: 'oa',
      messages: [{ role: 'user', content: 'hello' }],
      language: 'en',
      processMessageTemplates: async messages => messages,
      user: user('anna'),
      chatId: `chat-${randomUUID()}`
    });
    assert.equal(prepared.success, true, prepared.error?.message);
    const toolIds = prepared.data.tools.map(tool => tool.id);
    assert.ok(toolIds.includes(`app__${ADMIN_APP}`), toolIds.join(','));
    assert.equal(toolIds.includes(`app__${record.id}`), false);
    assert.equal(JSON.stringify(prepared.data).includes(SECRET), false);
  });

  it('app as a tool: a call to the tool of a personal app is refused, for its owner too', async () => {
    const record = await sharedApp();
    for (const name of ['anna', 'ben', 'root']) {
      const result = await invokeAppTool({
        toolId: `app__${record.id}`,
        args: { message: 'hello' },
        user: user(name),
        chatId: `chat-${randomUUID()}`
      });
      assert.equal(result.error, true, name);
      assert.equal(JSON.stringify(result).includes(SECRET), false, name);
    }
    // The run service the tool runs through, asked directly with the owner's context.
    const context = requestRunContext(user('anna'));
    assert.equal(context.ok, true, context.message);
    const direct = await new RunService().run(
      appRunSpec({
        context: context.context,
        appId: record.id,
        messages: [{ role: 'user', content: 'hello' }]
      }),
      new HeadlessHost()
    );
    assert.equal(direct.status, 'error');
    assert.equal(direct.error.code, 'APP_NOT_FOUND');
    assert.equal(JSON.stringify(direct).includes(SECRET), false);
    assert.equal(harness.turns.length, 0);
  });

  it('the request builder without the route’s app: scheduled tasks, tools and the inference API get "not found"', async () => {
    const record = await sharedApp();
    const prepare = (appId, name) =>
      new RequestBuilder().prepareChatRequest({
        appId,
        modelId: 'oa',
        messages: [{ role: 'user', content: 'hello' }],
        language: 'en',
        processMessageTemplates: async messages => messages,
        user: user(name),
        chatId: `chat-${randomUUID()}`
      });
    for (const name of ['anna', 'ben', 'root']) {
      const result = await prepare(record.id, name);
      assert.equal(result.success, false, name);
      assert.equal(result.error.code, 'APP_NOT_FOUND', name);
    }
  });

  it('workflow chat route: as for an unknown ID', async () => {
    const record = await sharedApp();
    setConfig({ features: { ...FEATURES, workflows: true } });
    const executionId = `wf-exec-${randomUUID()}`;
    getExecutionRegistry().register(executionId, {
      userId: 'anna',
      workflowId: 'some-workflow',
      workflowName: { en: 'Some workflow' },
      status: 'completed',
      startedAt: new Date().toISOString()
    });
    const ask = appId =>
      as('anna').post(`/api/workflows/executions/${executionId}/chat/${appId}`).send({});
    const unknown = await ask('no-such-app');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.detail, 'App not found');
    assert.deepEqual(shape(await ask(record.id), record.id), shape(unknown, 'no-such-app'));
    // An admin app passes the lookup (and stops later: the run has no state).
    assert.equal((await ask(ADMIN_APP)).body.detail, 'Execution not found');
  });

  it('inference API: a personal app is in no model list and is no target', async () => {
    const record = await sharedApp();
    const findModel = id => configCache.getModels()?.data.find(model => model.id === id);
    for (const name of ['anna', 'annaKey', 'ben', 'root']) {
      const listed = listInvocableApps(user(name)).map(app => app.id);
      assert.equal(listed.includes(record.id), false, name);
      assert.ok(listed.includes(ADMIN_APP), name);
    }
    const target = identifier =>
      resolveInferenceTarget({ model: identifier, user: user('annaKey'), findModel });
    const outcome = identifier => {
      try {
        const resolved = target(identifier);
        return { ok: true, appId: resolved?.app?.id ?? null, error: resolved?.error ?? null };
      } catch (error) {
        return { ok: false, code: error.code ?? null, message: error.message };
      }
    };
    const blank = (value, id) => JSON.parse(JSON.stringify(value).split(id).join('<app>'));
    const personal = outcome(`app:${record.id}`);
    assert.notEqual(personal.appId, record.id);
    assert.deepEqual(blank(personal, record.id), blank(outcome('app:no-such-app'), 'no-such-app'));
    assert.equal(outcome(`app:${ADMIN_APP}`).appId, ADMIN_APP);
  });

  it('MCP and A2A: the invoker does not find a personal app, and no skill names one', async () => {
    const record = await sharedApp();
    assert.throws(() => resolveInvokableApp(record.id), /App not found/);
    assert.throws(() => resolveInvokableApp('no-such-app'), /App not found/);
    assert.equal(resolveInvokableApp(ADMIN_APP).id, ADMIN_APP);
    const platform = { ...configCache.getPlatform(), mcpServer: { expose: { apps: true } } };
    for (const name of ['anna', 'client', 'agent']) {
      const skills = listA2aSkills(user(name), platform, { language: 'en' });
      assert.equal(JSON.stringify(skills).includes(record.id), false, name);
    }
  });
});

describe('the ratchet of raw app lookups', () => {
  const BASELINE = path.join(here, 'app-unpublished-access.baseline.json');
  const lookups = () => JSON.parse(fsSync.readFileSync(BASELINE, 'utf8')).lookups;

  it('the list did not grow with personal apps', () => {
    // The files of increment 1, and none added: the test of increment 1 fails
    // when a file gains a raw lookup; this one fails when its list gains a file.
    assert.deepEqual(Object.keys(lookups()).sort(), [
      'server/routes/chat/feedbackRoutes.js',
      'server/routes/chatShares.js',
      'server/routes/exports.js',
      'server/routes/generalRoutes.js',
      'server/routes/mcpAppRoutes.js',
      'server/routes/promptRoutes.js',
      'server/routes/scheduledTasks.js',
      'server/routes/voiceRoutes.js',
      'server/routes/workflow/workflowRoutes.js',
      'server/services/chat/RequestBuilder.js',
      'server/services/chat/appToolsGateway.js',
      // Moved from ChatService.invokeAppInternal with the run service.
      'server/services/run/assemble/fromApp.js'
    ]);
    const total = Object.values(lookups()).reduce((sum, entry) => sum + entry.calls, 0);
    assert.equal(total, 15);
  });

  it('every listed site says what it does with a personal-shaped ID', () => {
    for (const [file, entry] of Object.entries(lookups())) {
      assert.match(entry.personal || '', /\S{3,}/, `${file}: no "personal" note in the baseline`);
    }
  });

  it('the converted call sites ask the resolver of personal apps', () => {
    for (const file of [
      // The chat POST resolves its app in the turn start it hands the turn to.
      'server/services/chat/chatTurnStart.js',
      'server/routes/generalRoutes.js',
      'server/routes/magicPromptRoutes.js',
      'server/routes/integrations/scopes.js',
      'server/routes/integrations/userIntegrations.js',
      'server/routes/chat/conversationRoutes.js',
      'server/routes/chat/feedbackRoutes.js',
      'server/routes/chats.js',
      'server/services/chat/transcriptionTurn.js'
    ]) {
      const source = fsSync.readFileSync(path.join(repoRoot, file), 'utf8');
      assert.match(source, /resolveAppForChat\(|readUserAppFor\(/, file);
      // The read route keeps its own lookup for an admin app, after the
      // personal branch; every other site has one lookup, the resolver.
      if (file !== 'server/routes/generalRoutes.js') {
        assert.equal(/configCache\.getAppForRequest\(/.test(source), false, file);
      }
    }
  });
});
