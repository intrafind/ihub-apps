// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A legacy prompt node with a list of `apps` offers them as `app__<id>` tools
 * only inside an Agent Factory run, whose principal names an agent profile
 * (`PromptNodeExecutor`, frozen). Since the Agent Factory was removed (#3773)
 * no run carries such a principal, so no workflow run offers an app as a tool,
 * whatever the apps-as-tools flag says. This pins that; the second case shows
 * that the first one is not passing for another reason.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import configCache from '../configCache.js';
import { PromptNodeExecutor } from '../services/workflow/executors/PromptNodeExecutor.js';
import { fakeLlmClient } from './helpers/fakeLlmClient.js';

const MODEL = {
  id: 'stub-model',
  modelId: 'stub-model',
  provider: 'openai',
  name: { en: 'Stub model' },
  enabled: true,
  default: true,
  supportsTools: true,
  maxOutputTokens: 1024
};
const APP = {
  id: 'faq',
  name: { en: 'FAQ' },
  description: { en: 'Answers questions about the handbook.' },
  enabled: true,
  system: { en: 'Answer.' }
};
const PROFILE = { id: 'legacy-agent', name: { en: 'Legacy agent' }, apps: ['faq'] };

const NODE = {
  id: 'agent',
  type: 'prompt',
  config: { system: 'Use the apps you have.', prompt: 'What does the handbook say?', apps: ['faq'] }
};

const originals = {};
before(() => {
  for (const name of ['getModels', 'getApps', 'getFeatures', 'getAgentProfiles']) {
    originals[name] = configCache[name];
  }
  configCache.getModels = () => ({ data: [MODEL] });
  configCache.getApps = () => ({ data: [APP] });
  // The apps-as-tools flag is on: only the missing agent principal keeps the apps away.
  configCache.getFeatures = () => ({ appAsTool: true, skills: false });
  configCache.getAgentProfiles = () => ({ data: [PROFILE] });
});
after(() => Object.assign(configCache, originals));

/** Run the node once and return the tool ids the model was offered. */
async function toolsOffered(user) {
  const offered = [];
  let calls = 0;
  const executor = new PromptNodeExecutor({
    llmClient: fakeLlmClient(async ({ options }) => {
      calls += 1;
      offered.push(...(options?.tools || []).map(tool => tool?.id || tool?.function?.name));
      return {
        content: 'done',
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1 }
      };
    })
  });
  const result = await executor.execute(
    NODE,
    { executionId: 'wf-exec-app-tools', data: {}, history: [] },
    { user, executionId: 'wf-exec-app-tools', chatId: 'wf-exec-app-tools', language: 'en' }
  );
  return { result, offered, calls };
}

test('a workflow run registers no app__ tool for a prompt node with apps', async () => {
  const { result, offered, calls } = await toolsOffered({
    id: 'alice',
    groups: ['users'],
    permissions: { apps: new Set(['*']), models: new Set(['*']) }
  });
  assert.notEqual(result.status, 'failed', result.error);
  assert.equal(calls, 1, 'the model was asked once');
  assert.deepEqual(
    offered.filter(id => typeof id === 'string' && id.startsWith('app__')),
    []
  );
});

test('an agent principal (what only the removed Agent Factory started) would have', async () => {
  const { offered } = await toolsOffered({
    id: 'agent:legacy-agent',
    isAgent: true,
    profileId: PROFILE.id,
    groups: ['authenticated'],
    permissions: { apps: new Set(['*']), models: new Set(['*']) }
  });
  assert.ok(offered.includes('app__faq'), `offered: ${offered.join(', ')}`);
});
