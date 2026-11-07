// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The resources that live as one JSON file each in a directory of `contents/`
 * (apps, models, prompts, workflows, agent profiles, tools, admin projects), and
 * how each is loaded, in one table.
 *
 * Per resource: its log name, its directory, how an item is validated, and,
 * where it has them, a post-processing step over the whole list, an order other
 * than `order` then name, and a diagnostic to run on what was read. The
 * config cache loads every resource through {@link loadResources}.
 */

import {
  createResourceLoader,
  createSchemaValidator,
  createValidator,
  nameOf
} from './utils/resourceLoader.js';
import { appConfigSchema, knownAppKeys } from './validators/appConfigSchema.js';
import { modelConfigSchema, knownModelKeys } from './validators/modelConfigSchema.js';
import { workflowConfigSchema, knownWorkflowKeys } from './validators/workflowConfigSchema.js';
import { agentProfileSchema, knownAgentProfileKeys } from './validators/agentProfileSchema.js';
import logger from './utils/logger.js';

/**
 * Ensure exactly one default model. Only a chat model can be the default:
 * transcription and text-to-speech models never answer a prompt, so picking
 * one as the fallback would route chats to a model that cannot serve them.
 * @param {Array} models - Array of model objects
 * @returns {Array} Array of models with exactly one default
 */
function ensureOneDefaultModel(models) {
  const isChat = model => (model.modelType || 'chat') === 'chat';
  for (const model of models) {
    if (model.default === true && !isChat(model)) model.default = false;
  }
  const defaultModels = models.filter(model => model.default === true);

  if (defaultModels.length === 0) {
    // No default model found, set the first enabled chat model as default
    const enabledModels = models.filter(model => model.enabled === true && isChat(model));
    if (enabledModels.length > 0) {
      enabledModels[0].default = true;
      logger.info(`🎯 Set ${enabledModels[0].id} as default model (no default was configured)`, {
        component: 'ResourceLoaders'
      });
    }
  } else if (defaultModels.length > 1) {
    // Multiple default models found, keep only the first one
    logger.warn(`⚠️ Multiple default models found, keeping only ${defaultModels[0].id}`, {
      component: 'ResourceLoaders'
    });
    for (let i = 1; i < defaultModels.length; i++) {
      defaultModels[i].default = false;
    }
  }

  return models;
}

/**
 * - `resourceName`: the name in log lines
 * - `directory`: under `contents/`
 * - `validateItem(item, source)`: returns the item, as validated or parsed
 * - `postProcess(items)`: over the whole list, before sorting
 * - `sortComparator`: default is `order`, then name
 * - `inspect(items)`: a diagnostic over every item read, disabled ones too
 */
export const RESOURCE_LOADERS = {
  apps: {
    resourceName: 'Apps',
    directory: 'apps',
    validateItem: createSchemaValidator(appConfigSchema, knownAppKeys)
  },
  models: {
    resourceName: 'Models',
    directory: 'models',
    validateItem: createSchemaValidator(modelConfigSchema, knownModelKeys),
    postProcess: ensureOneDefaultModel
  },
  prompts: {
    resourceName: 'Prompts',
    directory: 'prompts',
    validateItem: createValidator(['id', 'name', 'prompt'])
  },
  workflows: {
    resourceName: 'Workflows',
    directory: 'workflows',
    validateItem: createSchemaValidator(workflowConfigSchema, knownWorkflowKeys)
  },
  agents: {
    resourceName: 'Agent Profiles',
    directory: 'agents/profiles',
    validateItem: createSchemaValidator(agentProfileSchema, knownAgentProfileKeys)
  },
  // Admin projects, the successor of `config/sources.json` (#1036): configuration
  // an admin links to apps, workflows and agents. User projects are runtime data
  // and never pass through here.
  projects: {
    resourceName: 'Projects',
    directory: 'projects',
    validateItem: createValidator(['id', 'name']),
    sortComparator: (a, b) => nameOf(a).localeCompare(nameOf(b))
  }
};

const loaders = new Map();

function loaderFor(name) {
  const spec = RESOURCE_LOADERS[name];
  if (!spec) throw new Error(`Unknown resource: ${name}`);
  if (!loaders.has(name)) {
    const { directory, ...options } = spec;
    loaders.set(name, createResourceLoader({ ...options, individualPath: directory }));
  }
  return loaders.get(name);
}

/**
 * Load every item of a resource from its directory.
 *
 * @param {keyof typeof RESOURCE_LOADERS} name - `'apps'`, `'models'`, ...
 * @param {Object} [options]
 * @param {boolean} [options.includeDisabled=false] - Keep items with `enabled: false`
 * @param {boolean} [options.verbose=true] - Log every item
 * @returns {Promise<Object[]>}
 */
export function loadResources(name, { includeDisabled = false, verbose = true } = {}) {
  return loaderFor(name).loadAll(includeDisabled, verbose);
}
