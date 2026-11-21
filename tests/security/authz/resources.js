// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The resources of the cross-user authorization suite: how alice creates one of
 * each (`seedAlice`), what of hers must stay unchanged (`aliceSnapshot`), and the
 * attack matrix (`RESOURCES`): every non-admin route with a path parameter that
 * reaches one of her resources, with the request an attacker sends.
 *
 * A matrix entry:
 *
 *   {
 *     route: 'GET /api/chats/:chatId',  // METHOD + the Express path, as registered
 *     data / multipart / headers,       // the request body; a function of `ids` when it needs one
 *     params: { runId: 'taskRunId' },   // path parameter → `ids` key (default: the same name)
 *     stream: true,                     // an event stream: a short timeout, which must not elapse
 *     expect: { bob: check, ... }       // per attacker; the default is DENY (401/403/404)
 *   }
 *
 * A check is an array of allowed statuses or a function `(res, ids) => string|null`
 * that returns why the response is wrong, or `SKIP` (that attacker is left out of
 * that route). Every check also fails a response that contains alice's secret
 * marker (`SECRET`), unless it is marked `mayRevealSecret` (a share's recipient).
 *
 * `EXEMPT_ROUTES` lists the parameterised non-admin routes the matrix does not
 * attack, each with the reason. The coverage guard (`route-coverage.spec.js`)
 * fails on a route that is in neither list.
 */

import { randomUUID } from 'node:crypto';
import { DENY, send, textFile, tinyPng, waitFor } from './harness.js';
import {
  AGENT_PROFILE_ID,
  AUTHZ_USERS,
  SECRET_APP_ID,
  SECRET_MODEL_ID,
  SECRET_PAGE_ID,
  SECRET_PROMPT_ID,
  SECRET_SKILL_ID,
  UNKNOWN_APP_ID,
  UNPUBLISHED_APP_ID,
  WORKFLOW_ID
} from './principals.js';

/** In everything alice writes; never in what an attacker gets back. */
export const SECRET = 'ALICE-TEST-SECRET-7f3a';

const FAKE_ARTIFACT_ID = 'a'.repeat(32);
const FAKE_SHA256 = 'b'.repeat(64);

async function json(response, what) {
  const body = await response.json().catch(() => null);
  if (response.status() >= 300) {
    throw new Error(`${what}: ${response.status()} ${JSON.stringify(body)}`);
  }
  return body;
}

/**
 * Create one of every resource as alice. Returns the ids (and alice's API key)
 * the matrix fills its paths with.
 *
 * @param {import('@playwright/test').APIRequestContext} alice
 */
export async function seedAlice(alice) {
  const ids = { appId: 'chat', carolId: AUTHZ_USERS.carol.id };

  // A stored chat: a file uploaded first (which creates the chat), then one turn
  // through the chat route that attaches it (the model is the local stub).
  ids.chatId = randomUUID();
  ids.fileId = (
    await json(
      await alice.post(`/api/chats/${ids.chatId}/files`, {
        multipart: { file: textFile('alice.txt', `${SECRET} chat file`), appId: 'chat' }
      }),
      'chat file'
    )
  ).id;
  const turn = await send(alice, {
    method: 'POST',
    url: `/api/apps/chat/chat/${ids.chatId}`,
    data: {
      messages: [
        {
          role: 'user',
          content: `${SECRET} chat question`,
          messageId: 'm1',
          fileIds: [ids.fileId]
        }
      ]
    },
    headers: { accept: 'text/event-stream' },
    timeout: 30_000
  });
  if (turn.status !== 200) throw new Error(`chat turn: ${turn.status} ${turn.text}`);
  const chat = await waitFor(
    async () => {
      const body = await json(await alice.get(`/api/chats/${ids.chatId}`), 'read chat');
      return body.messages?.length >= 2 && !body.chat.activeRunId ? body : null;
    },
    { what: 'the chat turn to be stored' }
  );
  ids.runId = chat.chat.runIds[0];
  ids.messageId = chat.messages.find(message => message.role === 'assistant').id;

  // A chat share addressed to carol only (`users` mode).
  ids.shareId = (
    await json(
      await alice.post(`/api/chats/${ids.chatId}/shares`, {
        data: { mode: 'users', recipients: [ids.carolId], uploadedFilesAccess: 'original' }
      }),
      'chat share'
    )
  ).id;

  ids.code = (
    await json(
      await alice.post('/api/shortlinks', { data: { appId: 'chat', path: `/apps/chat` } }),
      'short link'
    )
  ).code;

  // A user prompt and a user skill, both shared with carol for use (not edit).
  ids.promptId = (
    await json(
      await alice.post('/api/prompts', {
        data: { name: 'Alice prompt', prompt: `${SECRET} prompt text` }
      }),
      'user prompt'
    )
  ).id;
  await json(
    await alice.put(`/api/prompts/${ids.promptId}/shares`, {
      data: { shares: [{ type: 'user', id: ids.carolId, permission: 'use' }] }
    }),
    'share prompt'
  );
  ids.skillId = (
    await json(
      await alice.post('/api/user-skills', {
        data: {
          name: `alice-skill-${Date.now()}`,
          description: 'Alice skill',
          body: `${SECRET} skill body`
        }
      }),
      'user skill'
    )
  ).id;
  await json(
    await alice.put(`/api/user-skills/${ids.skillId}/shares`, {
      data: { shares: [{ type: 'user', id: ids.carolId, permission: 'use' }] }
    }),
    'share skill'
  );

  // A project with one uploaded item.
  ids.projectId = (
    await json(await alice.post('/api/projects', { data: { name: 'Alice project' } }), 'project')
  ).id;
  ids.itemId = (
    await json(
      await alice.post(`/api/projects/${ids.projectId}/items`, {
        multipart: { file: textFile('alice-doc.txt', `${SECRET} project document`) }
      }),
      'project item'
    )
  ).id;
  await waitFor(
    async () => {
      const item = await json(
        await alice.get(`/api/projects/${ids.projectId}/items/${ids.itemId}`),
        'item'
      );
      return item.status === 'ready';
    },
    { what: 'the project item to be extracted' }
  );

  // A scheduled task with memory, a file and one finished run.
  ids.taskId = (
    await json(
      await alice.post('/api/scheduled-tasks', {
        data: {
          name: 'Alice task',
          appId: 'chat',
          instructions: `${SECRET} task instructions`,
          schedule: { type: 'manual' },
          memory: { enabled: true }
        }
      }),
      'scheduled task'
    )
  ).id;
  await json(
    await alice.put(`/api/scheduled-tasks/${ids.taskId}/memory`, {
      data: { content: `${SECRET} task memory`, expectedVersion: 0 }
    }),
    'task memory'
  );
  ids.taskFileId = (
    await json(
      await alice.post(`/api/scheduled-tasks/${ids.taskId}/files`, {
        multipart: { file: textFile('task.txt', `${SECRET} task file`) }
      }),
      'task file'
    )
  ).id;
  ids.taskRunId = (
    await json(await alice.post(`/api/scheduled-tasks/${ids.taskId}/_run`, { data: {} }), 'run')
  ).id;
  await waitFor(
    async () => {
      const run = await json(
        await alice.get(`/api/scheduled-tasks/${ids.taskId}/runs/${ids.taskRunId}`),
        'task run'
      );
      return ['succeeded', 'failed'].includes(run.status);
    },
    { what: 'the task run to finish' }
  );

  // A workflow execution paused at a human checkpoint (a pending interaction).
  ids.executionId = (
    await json(
      await alice.post(`/api/workflows/${WORKFLOW_ID}/execute`, {
        data: { initialData: { topic: SECRET } }
      }),
      'workflow execution'
    )
  ).executionId;
  ids.interactionId = await waitFor(
    async () => {
      const pending = await json(await alice.get('/api/interactions/pending'), 'pending');
      return pending.items.find(item => item.runId === ids.executionId)?.id;
    },
    { what: 'the workflow checkpoint' }
  );

  // An agent run of the same workflow.
  ids.agentRunId = (
    await json(
      await alice.post(`/api/agents/profiles/${AGENT_PROFILE_ID}/runs`, {
        data: { brief: `${SECRET} agent brief` }
      }),
      'agent run'
    )
  ).executionId;
  await waitFor(
    async () => {
      const run = await json(await alice.get(`/api/agents/runs/${ids.agentRunId}`), 'agent run');
      return run.status === 'paused';
    },
    { what: 'the agent run to pause' }
  );

  // OpenAI-compatible conversation and file.
  ids.conversationId = (
    await json(
      await alice.post('/api/inference/v1/conversations', {
        data: { items: [{ type: 'message', role: 'user', content: `${SECRET} conversation` }] }
      }),
      'conversation'
    )
  ).id;
  ids.conversationItemId = (
    await json(
      await alice.get(`/api/inference/v1/conversations/${ids.conversationId}/items`),
      'conversation items'
    )
  ).data[0].id;
  ids.inferenceFileId = (
    await json(
      await alice.post('/api/inference/v1/files', {
        multipart: {
          file: textFile('alice-inference.txt', `${SECRET} inference file`),
          purpose: 'user_data'
        }
      }),
      'inference file'
    )
  ).id;

  // A personal API key (an OAuth client of hers).
  const key = await json(
    await alice.post('/api/integrations/api-keys', { data: { name: 'alice key' } }),
    'api key'
  );
  ids.keyId = key.key.id;
  ids.clientId = key.key.id;
  ids.apiKey = key.secrets.apiKey;

  // An integration request (one open request per definition and user: a
  // second seed in the same server finds the first).
  const requested = await alice.post('/api/integrations/requests', {
    data: { definition: 'com.intrafind/brave-search', reason: `${SECRET} request` }
  });
  ids.requestId =
    requested.status() === 409
      ? (await json(await alice.get('/api/integrations/requests'), 'requests')).items.find(
          entry => entry.definition === 'com.intrafind/brave-search'
        ).request.id
      : (await json(requested, 'integration request')).id;

  // A tools-service (OCR) job.
  ids.jobId = (
    await json(
      await alice.post('/api/tools-service/ocr/process', {
        multipart: {
          files: { name: 'alice.png', mimeType: 'image/png', buffer: tinyPng() },
          modelId: 'e2e-stub'
        }
      }),
      'ocr job'
    )
  ).items[0].jobId;

  return ids;
}

/**
 * What of alice's must not change while an attacker is at work: read back as
 * alice after each attacker's run of the matrix.
 *
 * @param {import('@playwright/test').APIRequestContext} alice
 * @param {Object} ids
 */
export async function aliceSnapshot(alice, ids) {
  const read = async url => {
    const res = await alice.get(url);
    return { status: res.status(), body: await res.json().catch(() => null) };
  };
  const chat = await read(`/api/chats/${ids.chatId}`);
  const chatFiles = await read(`/api/chats/${ids.chatId}/files`);
  const shares = await read(`/api/chats/${ids.chatId}/shares`);
  const link = await read(`/api/shortlinks/${ids.code}`);
  const prompt = await read(`/api/prompts/${ids.promptId}`);
  const skill = await read(`/api/user-skills/${ids.skillId}`);
  const project = await read(`/api/projects/${ids.projectId}`);
  const task = await read(`/api/scheduled-tasks/${ids.taskId}`);
  const memory = await read(`/api/scheduled-tasks/${ids.taskId}/memory`);
  const taskFiles = await read(`/api/scheduled-tasks/${ids.taskId}/files`);
  const taskRuns = await read(`/api/scheduled-tasks/${ids.taskId}/runs`);
  const execution = await read(`/api/workflows/executions/${ids.executionId}`);
  const agentRun = await read(`/api/agents/runs/${ids.agentRunId}`);
  const conversation = await read(`/api/inference/v1/conversations/${ids.conversationId}/items`);
  const file = await read(`/api/inference/v1/files/${ids.inferenceFileId}`);
  const key = await read(`/api/integrations/api-keys/${ids.keyId}`);
  const request = await read(`/api/integrations/requests/${ids.requestId}`);
  const job = await read(`/api/tools-service/jobs/${ids.jobId}/progress`);
  const run = await read(`/api/runs/${ids.runId}`);
  return {
    chat: [chat.status, chat.body?.chat?.title, chat.body?.messages?.length],
    chatFiles: [chatFiles.status, chatFiles.body?.items?.map(item => item.id)],
    shares: [
      shares.status,
      shares.body?.items?.map(share => [share.id, share.mode, share.revokedAt ?? null])
    ],
    link: [link.status, link.body?.url, link.body?.ownerId],
    prompt: [prompt.status, prompt.body?.prompt, prompt.body?.owner?.id, prompt.body?.revision],
    promptShares: prompt.body?.shares,
    skill: [skill.status, skill.body?.owner?.id, skill.body?.revision],
    skillShares: skill.body?.shares,
    project: [
      project.status,
      project.body?.name,
      project.body?.owner?.id,
      project.body?.members,
      project.body?.items?.map(item => [item.id, item.name])
    ],
    task: [task.status, task.body?.name, task.body?.status, task.body?.instructions],
    memory: [memory.status, memory.body?.body, memory.body?.version],
    taskFiles: [taskFiles.status, taskFiles.body?.items?.map(item => item.id)],
    taskRuns: [taskRuns.status, taskRuns.body?.items?.map(item => [item.id, item.status])],
    execution: [execution.status, execution.body?.status],
    agentRun: [agentRun.status, agentRun.body?.status],
    conversation: [conversation.status, conversation.body?.data?.length],
    file: [file.status, file.body?.id],
    key: [key.status, key.body?.id, key.body?.active, key.body?.lastRotated],
    request: [request.status, request.body?.status],
    job: [job.status],
    run: [run.status]
  };
}

// --- Checks ----------------------------------------------------------------

/** 200 with nothing of alice's in it: a route that answers every caller for their own data. */
export const callerScoped = res =>
  res.status >= 200 && res.status < 300 ? null : `expected 2xx (caller-scoped), got ${res.status}`;

/** The by-design answer of `GET /api/shortlinks/:code` to a non-owner: the code, nothing else. */
const codeOnly = (res, ids) => {
  if (res.status !== 200) return `expected 200 { code }, got ${res.status}`;
  const keys = Object.keys(res.json || {});
  return keys.length === 1 && res.json.code === ids.code
    ? null
    : `non-owner got more than the code: ${res.text.slice(0, 200)}`;
};

/** Allowed: carol is a `use` recipient of the share. */
export const allowed = res =>
  res.status >= 200 && res.status < 300
    ? null
    : `expected 2xx (shared with carol), got ${res.status}`;
/** What carol may read of a share addressed to her contains alice's content, by design. */
allowed.mayRevealSecret = true;

const SIGNED_IN_ONLY = [401];

/** Leaves one attacker out of one route. */
export const SKIP = 'skip';
const recipient = (check, rest = DENY) => ({ carol: check, bob: rest });

// --- The matrix ------------------------------------------------------------

const chatTurn = { messages: [{ role: 'user', content: 'pwned', messageId: 'x1' }] };

export const RESOURCES = [
  {
    name: 'chat (durable chat, transcript, files, artifacts, evidence)',
    routes: [
      { route: 'GET /api/chats/:chatId' },
      { route: 'PATCH /api/chats/:chatId', data: { title: 'pwned' } },
      { route: 'DELETE /api/chats/:chatId' },
      { route: 'GET /api/chats/:chatId/artifacts' },
      { route: 'POST /api/chats/:chatId/artifacts/zip', data: {} },
      {
        route: 'GET /api/chats/:chatId/artifacts/:artifactId',
        params: { artifactId: 'fakeArtifactId' },
        ownerSkip: 'the stub model makes no artifacts: a placeholder id'
      },
      {
        route: 'GET /api/chats/:chatId/artifacts/:artifactId/provenance',
        params: { artifactId: 'fakeArtifactId' },
        ownerSkip: 'the stub model makes no artifacts: a placeholder id'
      },
      { route: 'GET /api/chats/:chatId/evidence/:messageId' },
      {
        route: 'GET /api/chats/:chatId/evidence/:messageId/content/:sha256',
        params: { sha256: 'fakeSha256' },
        ownerSkip: 'no evidence is recorded for a stub answer'
      },
      {
        route: 'POST /api/chats/:chatId/files',
        multipart: { file: textFile('pwned.txt', 'pwned') }
      },
      { route: 'GET /api/chats/:chatId/files' },
      { route: 'GET /api/chats/:chatId/files/:fileId' },
      { route: 'DELETE /api/chats/:chatId/files/:fileId' },
      { route: 'POST /api/chats/:chatId/shares', data: { mode: 'public' } },
      {
        route: 'POST /api/chats/:chatId/artifacts/:artifactId/shares',
        params: { artifactId: 'fakeArtifactId' },
        data: { mode: 'public' }
      },
      { route: 'GET /api/chats/:chatId/shares' }
    ]
  },
  {
    name: 'chat session (live stream, turn, stop, status)',
    routes: [
      { route: 'GET /api/apps/:appId/chat/:chatId', stream: true },
      {
        route: 'POST /api/apps/:appId/chat/:chatId',
        data: chatTurn,
        headers: { accept: 'text/event-stream' },
        stream: true
      },
      { route: 'POST /api/apps/:appId/chat/:chatId/stop', data: {} },
      { route: 'GET /api/apps/:appId/chat/:chatId/status' }
    ]
  },
  {
    name: 'run (ledger, events, evidence, interactions)',
    routes: [
      { route: 'GET /api/runs/:runId' },
      { route: 'GET /api/runs/:runId/events' },
      { route: 'DELETE /api/runs/:runId' },
      {
        route: 'GET /api/runs/:runId/evidence',
        ownerSkip: 'no evidence is recorded for a stub answer'
      },
      {
        route: 'GET /api/runs/:runId/evidence/content/:sha256',
        params: { sha256: 'fakeSha256' },
        ownerSkip: 'no evidence is recorded for a stub answer'
      },
      { route: 'GET /api/runs/:runId/interactions', params: { runId: 'executionId' } },
      {
        route: 'POST /api/runs/:runId/interactions/:interactionId/answer',
        params: { runId: 'executionId' },
        data: { value: 'approve' }
      },
      { route: 'POST /api/runs/:runId/human-events', data: { kind: 'stop' } }
    ]
  },
  {
    name: 'chat share (addressed to carol)',
    routes: [
      { route: 'GET /api/shares/:shareId', expect: recipient(allowed) },
      { route: 'GET /api/shares/:shareId/files', expect: recipient(allowed) },
      { route: 'GET /api/shares/:shareId/files/:fileId', expect: recipient(allowed) },
      { route: 'GET /api/shares/:shareId/artifacts', expect: recipient(allowed) },
      { route: 'POST /api/shares/:shareId/artifacts/zip', data: {} },
      {
        route: 'GET /api/shares/:shareId/artifacts/:artifactId',
        params: { artifactId: 'fakeArtifactId' },
        ownerSkip: 'the stub model makes no artifacts: a placeholder id'
      },
      {
        route: 'GET /api/shares/:shareId/artifacts/:artifactId/provenance',
        params: { artifactId: 'fakeArtifactId' },
        ownerSkip: 'the stub model makes no artifacts: a placeholder id'
      },
      // A recipient views; only the owner (or an admin) revokes.
      { route: 'DELETE /api/shares/:shareId' },
      {
        route: 'GET /share/:shareId/embed',
        ownerSkip: 'embeds single-artifact shares only, with embedding on (off here)'
      }
    ]
  },
  {
    name: 'short link',
    routes: [
      {
        route: 'GET /api/shortlinks/:code',
        // Any signed-in user may learn that a code is taken (the share dialog's
        // check of a custom code); only the owner and admins see the link.
        expect: { bob: codeOnly, carol: codeOnly, anonymous: SIGNED_IN_ONLY }
      },
      { route: 'PUT /api/shortlinks/:code', data: { url: 'https://evil.example/' } },
      { route: 'DELETE /api/shortlinks/:code' }
    ]
  },
  {
    name: 'user prompt (shared with carol for use)',
    routes: [
      { route: 'GET /api/prompts/:promptId', expect: recipient(allowed) },
      { route: 'PUT /api/prompts/:promptId', data: { name: 'pwned', prompt: 'pwned' } },
      { route: 'DELETE /api/prompts/:promptId' },
      {
        route: 'POST /api/prompts/:promptId/_duplicate',
        data: {},
        // A `use` recipient may copy what was shared with them.
        expect: recipient(allowed)
      },
      {
        route: 'PUT /api/prompts/:promptId/shares',
        data: { shares: [{ type: 'everyone', permission: 'edit' }] }
      },
      { route: 'PUT /api/prompts/:promptId/owner', data: { ownerId: AUTHZ_USERS.bob.id } },
      { route: 'GET /api/prompts/:promptId/versions' },
      {
        route: 'POST /api/prompts/:promptId/versions/:revision/restore',
        params: { revision: 'revision' },
        data: {}
      },
      {
        // Records the id in the caller's own "recently used" list; it reads
        // nothing of the prompt (see the list checks for what bob sees after).
        route: 'POST /api/prompts/:promptId/usage',
        data: {},
        expect: { bob: callerScoped, carol: callerScoped, anonymous: SIGNED_IN_ONLY }
      }
    ]
  },
  {
    name: 'user skill (shared with carol for use)',
    routes: [
      { route: 'GET /api/user-skills/:skillId', expect: recipient(allowed) },
      {
        route: 'PUT /api/user-skills/:skillId',
        data: { name: 'pwned-skill', description: 'pwned', body: 'pwned' }
      },
      { route: 'DELETE /api/user-skills/:skillId' },
      {
        route: 'PUT /api/user-skills/:skillId/shares',
        data: { shares: [{ type: 'everyone', permission: 'edit' }] }
      },
      { route: 'PUT /api/user-skills/:skillId/owner', data: { ownerId: AUTHZ_USERS.bob.id } },
      {
        route: 'POST /api/user-skills/:skillId/_duplicate',
        data: () => ({ name: `copy-${Date.now()}` }),
        expect: recipient(allowed)
      },
      { route: 'GET /api/user-skills/:skillId/versions' },
      {
        route: 'GET /api/user-skills/:skillId/versions/:revision',
        params: { revision: 'revision' }
      },
      {
        route: 'POST /api/user-skills/:skillId/versions/:revision/restore',
        params: { revision: 'revision' },
        data: {}
      }
    ]
  },
  {
    name: 'project and its items',
    routes: [
      { route: 'GET /api/projects/:projectId' },
      { route: 'PATCH /api/projects/:projectId', data: { name: 'pwned' } },
      { route: 'DELETE /api/projects/:projectId' },
      { route: 'GET /api/projects/:projectId/items' },
      {
        route: 'POST /api/projects/:projectId/items',
        multipart: { file: textFile('pwned.txt', 'pwned') }
      },
      { route: 'GET /api/projects/:projectId/items/:itemId' },
      { route: 'PATCH /api/projects/:projectId/items/:itemId', data: { name: 'pwned.txt' } },
      { route: 'GET /api/projects/:projectId/items/:itemId/text' },
      { route: 'PUT /api/projects/:projectId/items/:itemId/text', data: { text: 'pwned' } },
      { route: 'POST /api/projects/:projectId/items/:itemId/_refresh', data: {} },
      { route: 'DELETE /api/projects/:projectId/items/:itemId' },
      { route: 'POST /api/projects/:projectId/estimate', data: {} },
      {
        route: 'PUT /api/projects/:projectId/members',
        data: { members: [{ type: 'user', id: AUTHZ_USERS.bob.id, role: 'owner' }] }
      },
      { route: 'POST /api/projects/:projectId/transfer', data: { ownerId: AUTHZ_USERS.bob.id } },
      { route: 'PUT /api/projects/:projectId/catalog', data: { listed: true } },
      { route: 'POST /api/projects/:projectId/subscription', data: {} },
      {
        // Unsubscribes the caller (their own flag); the project is not read.
        route: 'DELETE /api/projects/:projectId/subscription',
        expect: { bob: callerScoped, carol: callerScoped, anonymous: SIGNED_IN_ONLY }
      },
      { route: 'GET /api/projects/:projectId/chats' }
    ]
  },
  {
    name: 'scheduled task (memory, files, runs)',
    params: { runId: 'taskRunId', fileId: 'taskFileId' },
    routes: [
      { route: 'GET /api/scheduled-tasks/:taskId' },
      {
        route: 'PUT /api/scheduled-tasks/:taskId',
        data: {
          name: 'pwned',
          appId: 'chat',
          instructions: 'pwned',
          schedule: { type: 'manual' }
        }
      },
      { route: 'PATCH /api/scheduled-tasks/:taskId', data: { name: 'pwned' } },
      { route: 'DELETE /api/scheduled-tasks/:taskId' },
      { route: 'POST /api/scheduled-tasks/:taskId/_run', data: {} },
      { route: 'POST /api/scheduled-tasks/:taskId/_pause', data: {} },
      { route: 'POST /api/scheduled-tasks/:taskId/_resume', data: {} },
      { route: 'POST /api/scheduled-tasks/:taskId/_duplicate', data: {} },
      { route: 'GET /api/scheduled-tasks/:taskId/memory' },
      {
        route: 'PUT /api/scheduled-tasks/:taskId/memory',
        data: { content: 'pwned', expectedVersion: 1 }
      },
      { route: 'DELETE /api/scheduled-tasks/:taskId/memory' },
      { route: 'GET /api/scheduled-tasks/:taskId/files' },
      {
        route: 'POST /api/scheduled-tasks/:taskId/files',
        multipart: { file: textFile('pwned.txt', 'pwned') }
      },
      { route: 'GET /api/scheduled-tasks/:taskId/files/:fileId' },
      { route: 'DELETE /api/scheduled-tasks/:taskId/files/:fileId' },
      { route: 'GET /api/scheduled-tasks/:taskId/runs' },
      { route: 'GET /api/scheduled-tasks/:taskId/runs/:runId' },
      { route: 'DELETE /api/scheduled-tasks/:taskId/runs/:runId' },
      { route: 'DELETE /api/scheduled-tasks/:taskId/runs' },
      { route: 'POST /api/scheduled-tasks/:taskId/runs/:runId/_cancel', data: {} },
      {
        route: 'POST /api/scheduled-tasks/:taskId/runs/:runId/approval',
        data: { decision: 'approve', alwaysAllow: true }
      },
      {
        route: 'DELETE /api/scheduled-tasks/:taskId/allowed-tools/:toolId',
        params: { toolId: 'toolId' }
      }
    ]
  },
  {
    name: 'workflow execution',
    params: { appId: 'appId' },
    routes: [
      { route: 'GET /api/workflows/executions/:executionId' },
      {
        route: 'POST /api/workflows/executions/:executionId/chat/:appId',
        data: { messages: [{ role: 'user', content: 'pwned' }] }
      },
      { route: 'POST /api/workflows/executions/:executionId/_restart', data: {} },
      { route: 'POST /api/workflows/executions/:executionId/_cancel', data: {} },
      { route: 'DELETE /api/workflows/executions/:executionId' },
      { route: 'PATCH /api/workflows/executions/:executionId', data: { archived: true } },
      { route: 'GET /api/workflows/executions/:executionId/export' },
      { route: 'GET /api/workflows/executions/:executionId/stream', stream: true }
    ]
  },
  {
    name: 'agent run',
    params: { runId: 'agentRunId', name: 'artifactName' },
    routes: [
      { route: 'GET /api/agents/runs/:runId' },
      { route: 'GET /api/agents/runs/:runId/stream', stream: true },
      { route: 'POST /api/agents/runs/:runId/_cancel', data: {} },
      { route: 'POST /api/agents/runs/:runId/_resume', data: {} },
      {
        route: 'GET /api/agents/runs/:runId/artifacts',
        ownerSkip: 'the run wrote no artifacts (its owner gets 400 "invalid run id")'
      },
      {
        route: 'GET /api/agents/runs/:runId/artifacts/:name',
        ownerSkip: 'the run wrote no artifacts (its owner gets 400 "invalid run id")'
      }
    ]
  },
  {
    name: 'inference API conversation and file (/api/inference/v1)',
    params: { itemId: 'conversationItemId', file_id: 'inferenceFileId' },
    routes: [
      { route: 'GET /api/inference/v1/conversations/:conversationId' },
      {
        route: 'POST /api/inference/v1/conversations/:conversationId',
        data: { metadata: { owner: 'bob' } }
      },
      { route: 'DELETE /api/inference/v1/conversations/:conversationId' },
      { route: 'GET /api/inference/v1/conversations/:conversationId/items' },
      {
        route: 'POST /api/inference/v1/conversations/:conversationId/items',
        data: { items: [{ type: 'message', role: 'user', content: 'pwned' }] }
      },
      { route: 'GET /api/inference/v1/conversations/:conversationId/items/:itemId' },
      { route: 'DELETE /api/inference/v1/conversations/:conversationId/items/:itemId' },
      { route: 'GET /api/inference/v1/files/:file_id' },
      { route: 'GET /api/inference/v1/files/:file_id/content' },
      { route: 'DELETE /api/inference/v1/files/:file_id' }
    ]
  },
  {
    name: 'personal API key and OAuth connection',
    routes: [
      { route: 'GET /api/integrations/api-keys/:keyId' },
      { route: 'POST /api/integrations/api-keys/:keyId/_rotate', data: {} },
      { route: 'DELETE /api/integrations/api-keys/:keyId' },
      // Alice's key is an OAuth client of hers; bob has no connection to it.
      { route: 'DELETE /api/integrations/connections/:clientId' }
    ]
  },
  {
    name: 'integration request',
    routes: [{ route: 'GET /api/integrations/requests/:requestId' }]
  },
  {
    name: 'tools-service job',
    routes: [
      { route: 'GET /api/tools-service/jobs/:jobId/progress' },
      { route: 'GET /api/tools-service/jobs/:jobId/download' },
      { route: 'POST /api/tools-service/jobs/:jobId/_cancel', data: {} }
    ]
  }
];

/**
 * Config resources one group may use and carol's may not (the secret app,
 * model, prompt, skill, page and workflow). Attacked by carol and anonymous;
 * bob (in `users`) and alice may use them. Their path parameters are covered
 * here rather than in `RESOURCES`.
 */
export const GROUP_GATED = [
  { route: 'GET /api/apps/:appId', params: { appId: 'secretAppId' } },
  { route: 'GET /api/models/:modelId', params: { modelId: 'secretModelId' } },
  {
    route: 'GET /api/models/:modelId/chat/test',
    params: { modelId: 'secretModelId' },
    // Answers with a model call: a short stream.
    stream: true
  },
  {
    route: 'POST /api/apps/:appId/chat/:chatId',
    params: { appId: 'secretAppId', chatId: 'freshChatId' },
    data: { messages: [{ role: 'user', content: 'hello', messageId: 'g1' }] },
    headers: { accept: 'text/event-stream' },
    stream: true
  },
  {
    route: 'GET /api/scheduled-tasks/_apps/:appId/tools',
    params: { appId: 'secretAppId' }
  },
  { route: 'GET /api/prompts/:promptId', params: { promptId: 'secretPromptId' } },
  { route: 'GET /api/skills/:name', params: { name: 'secretSkillId' } },
  { route: 'GET /api/skills/:name/content', params: { name: 'secretSkillId' } },
  {
    route: 'GET /api/skills/:name/files/*filePath',
    params: { name: 'secretSkillId', filePath: 'skillFilePath' }
  },
  { route: 'POST /api/skills/:name/_duplicate', params: { name: 'secretSkillId' }, data: {} },
  { route: 'GET /api/pages/:pageId', params: { pageId: 'secretPageId' } },
  { route: 'GET /api/workflows/:id', params: { id: 'workflowId' } },
  {
    route: 'POST /api/workflows/:id/execute',
    params: { id: 'workflowId' },
    data: { initialData: { topic: 'x' } }
  },
  {
    route: 'POST /api/agents/profiles/:profileId/runs',
    params: { profileId: 'agentProfileId' },
    data: { brief: 'x' },
    // Agent profiles carry no group permission; any signed-in user may start one.
    expect: { carol: callerScoped }
  },
  {
    route: 'GET /a2a/skills/:skillId/.well-known/agent-card.json',
    params: { skillId: 'secretA2aSkillId' },
    bearer: true,
    // Without a token the card is public and names no skill.
    expect: {
      anonymous: res =>
        res.status === 200 && !res.text.includes('Authz secret app') && !res.json?.skills?.length
          ? null
          : `expected the public card without the skill, got ${res.status}`
    }
  },
  {
    route: 'POST /a2a/skills/:skillId',
    params: { skillId: 'secretA2aSkillId' },
    bearer: true,
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'message/send',
      params: {
        message: {
          kind: 'message',
          messageId: 'g1',
          role: 'user',
          parts: [{ kind: 'text', text: 'hello' }]
        }
      }
    },
    // JSON-RPC: refused in the body, not by the status.
    expect: {
      carol: res =>
        res.json?.error && !res.json?.result ? null : `expected a JSON-RPC error: ${res.text}`
    }
  }
];

/**
 * An app that is not published (`enabled: false`, `UNPUBLISHED_APP_ID`): one
 * entry per route that looks an app up with `configCache.getAppForRequest`,
 * which lets a content admin try such an app in the interactive chat. For a
 * user, an API key and an anonymous visitor the answer must be the one an id
 * that names no app gets (`UNKNOWN_APP_ID`): same status, same body.
 *
 * `request(appId, context)` builds the request for an app id; it may send
 * requests of its own first (a chat that belongs to the app).
 */
export const UNPUBLISHED_APP = [
  {
    route: 'GET /api/apps/:appId',
    request: appId => ({ method: 'GET', url: `/api/apps/${appId}` })
  },
  {
    // Without `Accept: text/event-stream`: the refusal is one JSON body.
    route: 'POST /api/apps/:appId/chat/:chatId',
    request: appId => ({
      method: 'POST',
      url: `/api/apps/${appId}/chat/${randomUUID()}`,
      data: { messages: [{ role: 'user', content: 'hello', messageId: 'u1' }] }
    })
  },
  {
    route: 'POST /api/magic-prompt',
    request: appId => ({
      method: 'POST',
      url: '/api/magic-prompt',
      data: { input: 'make it better', appId }
    })
  },
  {
    route: 'GET /api/integrations/scopes',
    request: appId => ({ method: 'GET', url: `/api/integrations/scopes?appId=${appId}` })
  },
  {
    route: 'GET /api/integrations/picker',
    request: appId => ({ method: 'GET', url: `/api/integrations/picker?app=${appId}` })
  },
  {
    route: 'GET /api/integrations/preferences',
    request: appId => ({ method: 'GET', url: `/api/integrations/preferences?app=${appId}` })
  },
  {
    route: 'PUT /api/integrations/preferences',
    request: appId => ({
      method: 'PUT',
      url: `/api/integrations/preferences?app=${appId}`,
      data: { enabledTools: [], websearchEnabled: false }
    })
  },
  {
    route: 'DELETE /apps/:appId/conversations/:conversationId',
    request: appId => ({ method: 'DELETE', url: `/apps/${appId}/conversations/authz-conversation` })
  },
  {
    // The app named with a first upload decides how the file is stored.
    route: 'POST /api/chats/:chatId/files',
    request: appId => ({
      method: 'POST',
      url: `/api/chats/${randomUUID()}/files`,
      multipart: { file: textFile('note.txt', 'a note'), appId }
    })
  },
  {
    // The chat's app decides whether projects can be attached to it.
    route: 'PATCH /api/chats/:chatId',
    request: async (appId, context) => {
      const chatId = randomUUID();
      await send(context, {
        method: 'POST',
        url: `/api/chats/${chatId}/files`,
        multipart: { file: textFile('note.txt', 'a note'), appId }
      });
      return {
        method: 'PATCH',
        url: `/api/chats/${chatId}`,
        data: { attachedProjectIds: ['authz-no-such-project'] }
      };
    }
  },
  {
    // Another way of running an app: it never knows an unpublished one.
    route: 'GET /api/scheduled-tasks/_apps/:appId/tools',
    request: appId => ({ method: 'GET', url: `/api/scheduled-tasks/_apps/${appId}/tools` })
  },
  {
    route: 'POST /api/inference/v1/chat/completions',
    request: appId => ({
      method: 'POST',
      url: '/api/inference/v1/chat/completions',
      data: { model: `app:${appId}`, messages: [{ role: 'user', content: 'hello' }] }
    })
  }
];

/** Admin-only routes outside `/api/admin` (a signed-in user must not reach them). */
export const ADMIN_ONLY = [
  {
    route: 'PUT /api/workflows/:id',
    params: { id: 'workflowId' },
    data: { id: WORKFLOW_ID, name: { en: 'pwned' }, nodes: [], edges: [] }
  },
  { route: 'DELETE /api/workflows/:id', params: { id: 'workflowId' } },
  { route: 'POST /api/workflows/:id/publish', params: { id: 'workflowId' }, data: {} }
];

/** Values of the config ids and placeholders the matrices use. */
export const FIXED_IDS = {
  fakeArtifactId: FAKE_ARTIFACT_ID,
  fakeSha256: FAKE_SHA256,
  revision: '1',
  toolId: 'ask_user',
  artifactName: 'report.md',
  secretAppId: SECRET_APP_ID,
  unpublishedAppId: UNPUBLISHED_APP_ID,
  unknownAppId: UNKNOWN_APP_ID,
  secretModelId: SECRET_MODEL_ID,
  secretPromptId: SECRET_PROMPT_ID,
  secretSkillId: SECRET_SKILL_ID,
  skillFilePath: 'SKILL.md',
  secretPageId: SECRET_PAGE_ID,
  workflowId: WORKFLOW_ID,
  agentProfileId: AGENT_PROFILE_ID,
  secretA2aSkillId: `app__${SECRET_APP_ID}`
};

/**
 * Parameterised non-admin routes the matrices do not attack, and why. Keep it
 * short: a route belongs here only when there is no user-owned resource behind
 * its parameter, or exercising it needs an external system.
 */
export const EXEMPT_ROUTES = {
  'GET /api/auth/oidc/:provider': 'Sign-in redirect to a configured OIDC provider; no resource',
  'GET /api/auth/oidc/:provider/callback': 'OIDC sign-in callback; needs an external provider',
  'GET /.well-known/oauth-authorization-server/{*issuerPath}': 'Public OAuth metadata (RFC 8414)',
  'GET /.well-known/oauth-protected-resource/{*resourcePath}': 'Public OAuth metadata (RFC 9728)',
  'GET /api/mcp/oauth/client-metadata/:serverId':
    'Public client metadata document iHub publishes for outbound MCP OAuth',
  'GET /api/mcp/oauth/callback/:serverId':
    'Outbound MCP OAuth callback; state-bound to the caller, needs an external server',
  'GET /api/user-skills/marketplace/:registryId/:name':
    'Marketplace catalog entry (shared, not user-owned); needs a remote registry',
  'POST /api/user-skills/marketplace/:registryId/:name/add':
    'Copies a marketplace entry into the caller’s own skills; needs a remote registry',
  'GET /api/renderers/:id': 'Public renderer code shipped with the server',
  'GET /api/translations/:lang': 'Public UI strings',
  'GET /api/artifact-libraries/:libraryId/source': 'Public library bundles shipped with the server',
  'DELETE /apps/:appId/conversations/:conversationId':
    'Proxies a delete to an external iAssistant conversation API under the caller’s identity',
  'GET /s/:code': 'Public short-link redirect, by design (the link is meant to be shared)',
  'POST /api/workflows/:workflowId/webhooks/:triggerId':
    'Workflow webhook trigger, authenticated by the trigger’s own secret, not a session',
  'GET /api/integrations/:id': 'Admin-installed integration (no user-owned id); per-caller view',
  'GET /api/integrations/:id/icon': 'Icon of an admin-installed integration',
  'POST /api/integrations/:id/_connect':
    'Connects the caller’s own account to an installed integration; needs an OAuth provider',
  'POST /api/integrations/:id/_reconnect':
    'Reconnects the caller’s own account; needs an OAuth provider',
  'POST /api/integrations/:id/_disconnect':
    'Disconnects the caller’s own account; needs an installed OAuth integration',
  'GET /api/integrations/:integration/files':
    'Documents of an external source under the caller’s own token; needs the external system',
  'GET /api/integrations/:integration/files/:id':
    'Document of an external source under the caller’s own token; needs the external system',
  'GET /api/integrations/:integration/files/:id/content':
    'Document of an external source under the caller’s own token; needs the external system',
  'GET /api/integrations/:integration/files/:id/content/:filename':
    'Document of an external source under the caller’s own token; needs the external system',
  'GET /api/integrations/:integrationId/scopes':
    'Scopes (profiles) of an external search system for the caller; needs the external system',
  'GET /api/integrations/jira/attachment/:attachmentId':
    'Jira attachment under the caller’s own Jira token; needs Jira',
  'GET /api/integrations/office365/:providerId/callback': 'OAuth callback; needs Microsoft 365',
  'GET /api/integrations/office365/drives/:source': 'Caller’s own drives; needs Microsoft 365',
  'GET /api/integrations/googledrive/:providerId/callback': 'OAuth callback; needs Google Drive',
  'GET /api/integrations/googledrive/drives/:source': 'Caller’s own drives; needs Google Drive',
  'GET /api/integrations/nextcloud/:providerId/callback': 'OAuth callback; needs Nextcloud',
  'GET /api/integrations/nextcloud/drives/:source': 'Caller’s own drives; needs Nextcloud'
};
