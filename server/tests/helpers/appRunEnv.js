// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * An environment for tests of apps that run without a client (an app called as
 * a tool, the MCP gateway, an A2A task) on the real run service: the golden
 * harness (real storage in a temporary directory, the config cache filled, a
 * scripted model) with a small set of apps, groups and integration tools.
 *
 * Nothing of the run service, the gateway, the tool runner or the agent loop is
 * replaced. Import this helper before any server module: the harness isolates
 * the contents directory before the server loads.
 *
 * @module tests/helpers/appRunEnv
 */
import { mock } from 'node:test';
import { startGoldenEnv } from '../golden/harness.js';
import { scriptedModel } from './scriptedModel.js';
import { fixtureInstallation, fixtureTool } from './integrationToolFixture.js';
import integrationRegistry from '../../services/integrations/definitions/IntegrationRegistry.js';

export const MODEL = {
  id: 'golden-model',
  provider: 'openai',
  modelId: 'gpt-golden',
  url: 'https://model.invalid/v1/chat/completions',
  autoDiscovery: false,
  supportsTools: 'auto',
  default: true
};

/** An app of the environment. */
export const app = (id, extra = {}) => ({
  id,
  name: { en: id },
  description: { en: `The ${id} app` },
  system: { en: `You are the ${id}.` },
  preferredModel: MODEL.id,
  enabled: true,
  ...extra
});

/** The usage of one scripted model turn. */
export const USAGE = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };

/** A one-pixel PNG, base64. */
export const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** The PDF the file tool of {@link offerFileTool} returns. */
export const REPORT_PDF = Buffer.from('%PDF-1.4 a fake report');

/** A tool of a connected MCP server that hands back a PDF and a picture. */
export const FILE_TOOL = Object.freeze({
  id: 'render_report',
  name: 'Render report',
  description: 'Renders the report as a PDF with a chart',
  parameters: { type: 'object', properties: {} },
  _mcp: { serverId: 'reports', originalName: 'render' }
});

/**
 * Offer {@link FILE_TOOL} to every app the run service runs, for one test:
 * the app's run prepares as the product prepares it, and the tool joins its
 * tools; calling it returns the MCP content blocks a server sends (text, an
 * embedded PDF `resource`, an `image`). Nothing else of the run is replaced.
 *
 * @param {import('node:test').TestContext} t
 */
export async function offerFileTool(t) {
  const { runService } = await import('../../services/run/RunService.js');
  const svc = await runService.chatServiceOf();
  const prepare = svc.prepareChatRequest.bind(svc);
  mock.method(svc, 'prepareChatRequest', async request => {
    const prepared = await prepare(request);
    if (prepared.success) prepared.data.tools = [...prepared.data.tools, FILE_TOOL];
    return prepared;
  });
  const runTool = svc.toolRunner.runTool;
  mock.method(svc.toolRunner, 'runTool', (toolId, ...rest) =>
    toolId === FILE_TOOL.id
      ? [
          { type: 'text', text: 'Rendered the report.' },
          {
            type: 'resource',
            resource: {
              uri: 'file:///reports/Report.pdf',
              name: 'Report.pdf',
              mimeType: 'application/pdf',
              blob: REPORT_PDF.toString('base64')
            }
          },
          { type: 'image', data: PNG_B64, mimeType: 'image/png' }
        ]
      : runTool(toolId, ...rest)
  );
  t.after(() => mock.restoreAll());
}

/** What the tools of the environment did, by tool. */
export const toolRuns = { lookup: [], dangerous: [], secret: [] };

/**
 * Start the environment.
 *
 * Apps: `concierge` (lists `specialist`, `restricted`, itself, `missing` and
 * `disabled` as apps), `specialist` (a variable `tone`; the tools `lookup`,
 * `dangerous`, which needs approval, and `ask_user`; lists `helper`), `helper`,
 * `translator` (a prompt template that renders the variable `tone`, in English
 * and German), `restricted` (no group grants it), `disabled`.
 *
 * Groups: `users` (the four apps, the integrations `lookup`, `dangerous`,
 * `ihub`), `everything` (every app, every integration), `no-secret` (like
 * `users`, without the integration `secret`).
 *
 * @param {Object} [options]
 * @param {Object} [options.features] - more feature switches (`appAsTool` is on)
 * @param {Object} [options.platform] - more platform settings
 * @param {Object[]} [options.workflows] - workflows (the group `everything` may run all)
 * @returns {Promise<Object>} the golden environment, with `script(t, turns)` and
 *   `user(id, groups)` added
 */
export async function startAppRunEnv({ features = {}, platform = {}, workflows = [] } = {}) {
  const env = await startGoldenEnv({
    features: { appAsTool: true, chatPersistence: true, ...features },
    platform: { chats: { enabled: true }, auth: {}, ...platform },
    workflows,
    models: [MODEL],
    apps: [
      app('concierge', {
        name: { en: 'Concierge', de: 'Empfang' },
        apps: ['specialist', 'restricted', 'concierge', 'missing', 'disabled']
      }),
      app('specialist', {
        name: { en: 'Claims specialist', de: 'Schadensspezialist' },
        description: { en: 'Answers claims questions' },
        variables: [{ name: 'tone', type: 'string', label: { en: 'Tone of the answer' } }],
        apps: ['helper'],
        integrations: { lookup: {}, dangerous: {}, secret: {}, ihub: { actions: ['ask_user'] } }
      }),
      app('helper'),
      app('translator', {
        variables: [{ name: 'tone', type: 'string', label: { en: 'Tone of the answer' } }],
        prompt: {
          en: 'Tone: {{tone}}. Text: {{content}}',
          de: 'Ton: {{tone}}. Text: {{content}}'
        }
      }),
      app('restricted'),
      app('disabled', { enabled: false })
    ],
    groups: {
      groups: {
        users: {
          id: 'users',
          permissions: {
            apps: ['concierge', 'specialist', 'helper', 'translator'],
            models: ['*'],
            prompts: [],
            integrations: ['lookup', 'dangerous', 'secret', 'ihub']
          }
        },
        'no-secret': {
          id: 'no-secret',
          permissions: {
            apps: ['concierge', 'specialist', 'helper', 'translator'],
            models: ['*'],
            prompts: [],
            integrations: ['lookup', 'dangerous', 'ihub']
          }
        },
        everything: {
          id: 'everything',
          permissions: {
            apps: ['*'],
            models: ['*'],
            prompts: [],
            integrations: ['*'],
            workflows: ['*']
          }
        }
      }
    },
    tools: [
      fixtureTool('lookup', {
        description: 'Look up a record',
        parameters: { type: 'object', properties: { key: { type: 'string' } } },
        run: (args, ctx) => {
          // The scope the call ran in (#3050), when the run is bound to one.
          toolRuns.lookup.push({ ...args, scope: ctx?.scope?.id ?? null });
          return {
            found: args.key,
            sources: [
              {
                id: `record:${args.key}`,
                kind: 'item',
                title: `Record ${args.key}`,
                snippet: 'a long excerpt of the record',
                passages: [{ text: 'a long passage' }]
              }
            ]
          };
        }
      }),
      fixtureTool('dangerous', {
        description: 'Does something with side effects',
        requiresApproval: true,
        run: args => {
          toolRuns.dangerous.push(args);
          return { done: true };
        }
      }),
      fixtureTool('secret', {
        description: 'Reads a secret record',
        run: args => {
          toolRuns.secret.push(args);
          return { secret: 'value' };
        }
      })
    ],
    integrations: () => ({
      installed: [
        fixtureInstallation('lookup'),
        fixtureInstallation('dangerous'),
        fixtureInstallation('secret'),
        fixtureInstallation('ihub', {
          definition: 'com.intrafind/ihub',
          definitionVersion: integrationRegistry.get('com.intrafind/ihub').definition.version
        })
      ],
      security: { blockPrivateIps: true, allowedHosts: [] }
    })
  });
  return Object.assign(env, {
    /** Script the model for one test; the script must be used exactly. */
    script(t, turns) {
      const model = scriptedModel(turns);
      env.model = model;
      t.after(() => model.assertDone());
      return model;
    },
    /** A signed-in user of these groups, with resolved permissions. */
    user(id, groups = ['users']) {
      return env.principal({ id, name: id, groups });
    },
    /**
     * Change the installed integrations from here on, as every reader sees
     * them (the raw cache and `installedIntegrationService`); undone by
     * `mock.restoreAll()`.
     *
     * @param {(installed: Object[]) => Object[]} change - the new list from the current one
     */
    changeInstallations(change) {
      const original = env.configCache.get.bind(env.configCache);
      mock.method(env.configCache, 'get', key => {
        const entry = original(key);
        if (key !== 'config/integrations.json' || !entry?.data) return entry;
        return { ...entry, data: { ...entry.data, installed: change(entry.data.installed) } };
      });
    },
    /** Disable one installation from here on; undone by `mock.restoreAll()`. */
    disableInstallation(instanceId) {
      env.changeInstallations(installed =>
        installed.map(instance =>
          instance.id === instanceId ? { ...instance, enabled: false } : instance
        )
      );
    },
    /** Forget what the tools did and what the ledger holds. */
    reset() {
      env.ledger.length = 0;
      for (const runs of Object.values(toolRuns)) runs.length = 0;
    }
  });
}

export default startAppRunEnv;
