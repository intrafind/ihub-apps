// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What refers to a model or an app by its id, so that the admin is told before
 * deleting it what will lose its reference (AI-B12).
 *
 * Every function here is pure: it takes the configuration lists and returns
 * the references it finds. The admin routes read the lists (the config cache,
 * the authored `groups.json`) and answer `GET …/_dependants` with the result.
 * Nothing is blocked by a reference: the server copes with every one of them
 * (an app falls back to the default model, a group entry naming no app grants
 * nothing), so the admin is warned, not stopped.
 *
 * @module utils/resourceDependants
 */

/** Only a chat model can be the default; transcription and TTS models never answer a prompt. */
const isChatModel = model => (model?.modelType || 'chat') === 'chat';

/**
 * Every node of a workflow, nested ones (loop bodies) included.
 *
 * @param {Array<Object>|undefined} nodes
 * @returns {Object[]}
 */
function allNodes(nodes) {
  if (!Array.isArray(nodes)) return [];
  return nodes.flatMap(node => [node, ...allNodes(node?.nodes), ...allNodes(node?.config?.nodes)]);
}

/**
 * The groups of the authored `groups.json` whose permissions name `id`
 * explicitly in `permissions[kind]`. A wildcard (`*`) is not a reference: it
 * keeps granting whatever exists.
 *
 * @param {Object|null|undefined} groupsConfig - `groups.json` as stored (`{ groups: { [id]: group } }`)
 * @param {'apps'|'models'} kind
 * @param {string} id
 * @returns {Array<{id: string, name: string}>}
 */
export function groupsNaming(groupsConfig, kind, id) {
  const groups =
    groupsConfig?.groups && typeof groupsConfig.groups === 'object' ? groupsConfig.groups : {};
  return Object.entries(groups)
    .filter(([, group]) => {
      const listed = group?.permissions?.[kind];
      return Array.isArray(listed) && listed.includes(id);
    })
    .map(([groupId, group]) => ({ id: group?.id || groupId, name: group?.name || groupId }));
}

/**
 * The chat model that becomes the default when `exceptId` goes away or stops
 * being the default: the first enabled chat model of `models` other than it.
 * The order of `models` decides, so callers pass them in the order the server
 * promotes in (stored files sorted by order, then name).
 *
 * @param {Array<Object>} models
 * @param {string} [exceptId]
 * @returns {string|null}
 */
export function defaultSuccessorId(models, exceptId) {
  const next = (models || []).find(
    model => model?.id !== exceptId && model?.enabled !== false && isChatModel(model)
  );
  return next ? next.id : null;
}

/**
 * The id of the model that answers when an app names none: the enabled chat
 * model flagged `default`, else the first enabled chat model (what the config
 * loader promotes in memory when no default is configured, and what chat falls
 * back to). A disabled model flagged `default` does not count: chat skips it,
 * and `@default` must grant the model chat actually uses.
 *
 * @param {Array<Object>} models
 * @returns {string|null}
 */
export function effectiveDefaultModelId(models) {
  const list = models || [];
  const flagged = list.find(
    model => model?.default === true && model.enabled !== false && isChatModel(model)
  );
  if (flagged) return flagged.id;
  const first = list.find(model => model?.enabled === true && isChatModel(model));
  return first ? first.id : null;
}

/**
 * What refers to a model.
 *
 * - `apps`: apps that name it, with the fields that do (`preferredModel`,
 *   `allowedModels`, `speechRecognition` for the transcription model of voice
 *   input, `voiceMode` for the read-aloud model).
 * - `workflows`: workflows that name it as their default model or in a node.
 * - `groups`: groups whose model permissions list it explicitly.
 * - `isDefault`: it is the platform's default model; with `nextDefaultModelId`,
 *   the model that takes over (absent when none can).
 *
 * @param {string} modelId
 * @param {Object} lists
 * @param {Array<Object>} [lists.apps]
 * @param {Array<Object>} [lists.workflows]
 * @param {Object|null} [lists.groupsConfig] - `groups.json` as stored
 * @param {Array<Object>} [lists.models] - The models as the server lists them, in the
 *   order it promotes a new default in
 * @returns {{
 *   apps: Array<{id: string, name: *, references: string[]}>,
 *   workflows: Array<{id: string, name: *, references: string[]}>,
 *   groups: Array<{id: string, name: string}>,
 *   isDefault: boolean,
 *   nextDefaultModelId?: string
 * }}
 *
 * @example
 * findModelDependants('gpt-4o', { apps, workflows, groupsConfig, models });
 * // { apps: [{ id: 'chat', name: {...}, references: ['preferredModel'] }], workflows: [], groups: [], isDefault: false }
 */
export function findModelDependants(
  modelId,
  { apps = [], workflows = [], groupsConfig, models = [] }
) {
  const appRefs = apps
    .map(app => {
      const references = [];
      if (app?.preferredModel === modelId) references.push('preferredModel');
      if (Array.isArray(app?.allowedModels) && app.allowedModels.includes(modelId)) {
        references.push('allowedModels');
      }
      if (app?.settings?.speechRecognition?.modelId === modelId) {
        references.push('speechRecognition');
      }
      if (app?.inputMode?.voiceMode?.ttsModelId === modelId) references.push('voiceMode');
      return { id: app?.id, name: app?.name, references };
    })
    .filter(ref => ref.references.length > 0);

  const workflowRefs = workflows
    .map(workflow => {
      const references = [];
      if (workflow?.config?.defaultModelId === modelId) references.push('defaultModel');
      if (allNodes(workflow?.nodes).some(node => node?.config?.modelId === modelId)) {
        references.push('node');
      }
      return { id: workflow?.id, name: workflow?.name, references };
    })
    .filter(ref => ref.references.length > 0);

  const isDefault = effectiveDefaultModelId(models) === modelId;
  const result = {
    apps: appRefs,
    workflows: workflowRefs,
    groups: groupsNaming(groupsConfig, 'models', modelId),
    isDefault
  };
  if (isDefault) {
    const next = defaultSuccessorId(models, modelId);
    if (next) result.nextDefaultModelId = next;
  }
  return result;
}

/**
 * What refers to an app.
 *
 * - `prompts`: prompts that open in it (`appId`).
 * - `apps`: other apps that call it as a tool (`apps`) or inherit from it
 *   (`parentId`), with which of the two.
 * - `workflows`: workflows with a node that calls it as a tool.
 * - `groups`: groups whose app permissions list it explicitly.
 *
 * @param {string} appId
 * @param {Object} lists
 * @param {Array<Object>} [lists.apps]
 * @param {Array<Object>} [lists.prompts]
 * @param {Array<Object>} [lists.workflows]
 * @param {Object|null} [lists.groupsConfig] - `groups.json` as stored
 * @returns {{
 *   prompts: Array<{id: string, name: *}>,
 *   apps: Array<{id: string, name: *, references: string[]}>,
 *   workflows: Array<{id: string, name: *}>,
 *   groups: Array<{id: string, name: string}>
 * }}
 */
export function findAppDependants(
  appId,
  { apps = [], prompts = [], workflows = [], groupsConfig }
) {
  const appRefs = apps
    .filter(app => app?.id !== appId)
    .map(app => {
      const references = [];
      if (Array.isArray(app?.apps) && app.apps.includes(appId)) references.push('tool');
      if (app?.parentId === appId) references.push('parent');
      return { id: app?.id, name: app?.name, references };
    })
    .filter(ref => ref.references.length > 0);

  return {
    prompts: prompts
      .filter(prompt => prompt?.appId === appId)
      .map(prompt => ({ id: prompt.id, name: prompt.name })),
    apps: appRefs,
    workflows: workflows
      .filter(workflow =>
        allNodes(workflow?.nodes).some(
          node => Array.isArray(node?.config?.apps) && node.config.apps.includes(appId)
        )
      )
      .map(workflow => ({ id: workflow.id, name: workflow.name })),
    groups: groupsNaming(groupsConfig, 'apps', appId)
  };
}
