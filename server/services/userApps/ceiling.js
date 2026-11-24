// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The capability ceiling of personal apps.
 *
 * A personal app can never do more than its owner may do and never more than
 * the person chatting may do. This module answers that question in two
 * places: when an app is saved ({@link checkCapabilitiesForSave}) and on
 * every chat request ({@link effectiveUserApp}). The run check is the one
 * that counts, because rights change after a save.
 *
 * {@link effectiveUserApp} also builds the app object a chat runs with. It
 * starts from `personalAppBase(record.id)`, copies the content keys one by
 * one and writes what the ceiling grants. It never spreads a record or a
 * request body, so a key a record should not have cannot reach a chat.
 *
 * Pure: no store, no config cache, no clock of its own. Everything that had
 * to be looked up comes in as `catalog` (`userAppCatalog` in `resolveApp.js`
 * builds it).
 *
 * **The catalog.**
 *
 * ```js
 * {
 *   models: [{ id, enabled, modelType }],          // every model, disabled ones included
 *   installations: [{ id, definition, enabled }],  // every installed integration
 *   features: { skills: true, integrations: true, projects: true, userProjects: true },
 *                                                  // feature flags; `false` withholds
 *   webSearch: { owner: true, runner: true },      // a search engine is available to them
 *   skills: { owner: ['a'], runner: ['a', 'b'] },  // global skills granted to them
 *   projects: { [id]: { exists, ownership, name, owner, runner } }
 *                                                  // who may use each linked project
 * }
 * ```
 *
 * `runner` in the catalog is the person the check is made for: the person
 * chatting on a run, the person saving on a save.
 *
 * Design: concepts/app-builder-rework-2026-11/02-personal-apps.md, section 6.
 *
 * @module services/userApps/ceiling
 */
import { canUserAccessResource } from '../../utils/authorization.js';
import { mayUseIntegration } from '../integrations/integrationAccess.js';
import { placeholdersIn } from '../../../shared/appPlaceholders.js';
import {
  NO_MODEL_AVAILABLE_ID,
  PERSONAL_UPLOAD_OFF,
  PERSONAL_UPLOAD_ON,
  USER_APP_GREETING_KEYS,
  USER_APP_INPUT_MODE_TYPES,
  USER_APP_LIMITS,
  USER_APP_LOCALIZED_KEYS,
  USER_APP_OUTPUT_FORMATS,
  USER_APP_STARTER_PROMPT_KEYS,
  USER_APP_VARIABLE_KEYS,
  personalAppBase
} from '../../../shared/userAppContent.js';
import { isOwnerSnapshotStale } from './userAppAccess.js';

/** The capability IDs that are not a bound installation, in the order they are reported. */
export const USER_APP_CAPABILITY_IDS = Object.freeze([
  'model',
  'models',
  'upload',
  'webSearch',
  'skills'
]);

/** The prefix of the capability ID of one bound installation. */
export const INTEGRATION_CAPABILITY_PREFIX = 'integration:';

/** The prefix of the capability ID of one linked project. */
export const PROJECT_CAPABILITY_PREFIX = 'project:';

/** Why a capability was withheld. */
export const CAPABILITY_REASONS = Object.freeze({
  notRequested: 'notRequested',
  offOnInstallation: 'offOnInstallation',
  ownerMayNot: 'ownerMayNot',
  youMayNot: 'youMayNot',
  ownerInactive: 'ownerInactive',
  ownerStale: 'ownerStale'
});

/**
 * The capability ID of a bound installation.
 *
 * @param {string} installationId
 * @returns {string}
 *
 * @example
 * integrationCapabilityId('jira'); // → 'integration:jira'
 */
export function integrationCapabilityId(installationId) {
  return `${INTEGRATION_CAPABILITY_PREFIX}${installationId}`;
}

/**
 * The capability ID of a linked project.
 *
 * @param {string} projectId
 * @returns {string}
 *
 * @example
 * projectCapabilityId('prj_abc'); // → 'project:prj_abc'
 */
export function projectCapabilityId(projectId) {
  return `${PROJECT_CAPABILITY_PREFIX}${projectId}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sameId(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

/** The named actions of a binding: strings, each once. */
function actionNames(actions) {
  if (!Array.isArray(actions)) return [];
  return [
    ...new Set(actions.filter(name => typeof name === 'string' && name !== '' && name !== '*'))
  ];
}

/** The bindings a content object asks for, as `[{ id, actions }]`. Anything else is left out. */
function requestedBindings(content) {
  const list = content?.capabilities?.integrations;
  if (!Array.isArray(list)) return [];
  const bindings = [];
  const seen = new Set();
  for (const entry of list) {
    const id = typeof entry?.id === 'string' ? entry.id : '';
    if (!id || id === '*' || id.includes(':') || seen.has(id)) continue;
    seen.add(id);
    bindings.push({ id, actions: actionNames(entry.actions) });
  }
  return bindings;
}

/** The projects a content object asks for, as `[{ id }]`; each ID once. */
function requestedProjects(content) {
  const list = content?.capabilities?.projects;
  if (!Array.isArray(list)) return [];
  const links = [];
  for (const entry of list) {
    const id = typeof entry?.id === 'string' ? entry.id : '';
    if (id && !links.some(link => link.id === id)) links.push({ id });
  }
  return links;
}

/**
 * The reason the owner's side withholds everything, or null: no owner
 * principal (the account is gone, deactivated or could not be looked up), or
 * a snapshot of the owner's groups that is too old to trust.
 */
function ownerVerdict(owner, stale) {
  if (!owner) return CAPABILITY_REASONS.ownerInactive;
  if (stale) return CAPABILITY_REASONS.ownerStale;
  return null;
}

/**
 * One capability, decided in a fixed order: what the installation allows,
 * then the owner, then the person the check is made for.
 *
 * @param {Object} checks
 * @param {boolean} checks.installation - The installation offers it.
 * @param {string|null} checks.ownerState - `ownerInactive`, `ownerStale` or null.
 * @param {boolean} checks.owner - The owner may use it.
 * @param {boolean} checks.runner - The person chatting (or saving) may use it.
 * @returns {string|null} The reason it is withheld; null when it is granted.
 */
function decide({ installation, ownerState, owner, runner }) {
  if (!installation) return CAPABILITY_REASONS.offOnInstallation;
  if (ownerState) return ownerState;
  if (!owner) return CAPABILITY_REASONS.ownerMayNot;
  if (!runner) return CAPABILITY_REASONS.youMayNot;
  return null;
}

/**
 * Every capability of a content object, decided for one owner and one runner.
 *
 * @returns {{model: Object, models: Object, upload: Object, webSearch: Object, skills: Object,
 *   bindings: Array<Object>}} Each entry is `{ requested, reason }` (`reason`
 *   null when granted); `skills` adds `ids`, `models` adds `ids`, `lock` and
 *   `refuse`, a binding adds `id` and `actions`.
 */
function evaluate(content, { runner, owner, settings, catalog, ownerState, strictActions }) {
  const allowed = settings?.capabilities || {};
  const requested = content?.capabilities || {};
  const features = catalog?.features || {};

  // Preferred model.
  const modelId = typeof content?.preferredModel === 'string' ? content.preferredModel : '';
  const modelEntry = (catalog?.models || []).find(model => sameId(model?.id, modelId));
  const chatModel =
    Boolean(modelEntry) &&
    modelEntry.enabled !== false &&
    (modelEntry.modelType || 'chat') === 'chat';
  const model = {
    requested: modelId !== '',
    id: modelEntry?.id || modelId,
    reason:
      modelId === ''
        ? CAPABILITY_REASONS.notRequested
        : decide({
            installation: allowed.modelChoice === true && chatModel,
            ownerState,
            owner: canUserAccessResource(owner, 'models', modelId),
            runner: canUserAccessResource(runner, 'models', modelId)
          })
  };

  // Which models the app may use, and whether the choice is locked. It only ever narrows:
  // the list is cut to the models the owner and the person the check is made for may both
  // use. When the app restricts its models and none is left, the app does not run for this
  // person (`refuse`): dropping the restriction would give them a model the author excluded.
  const modelsAsked = isPlainObject(requested.models) ? requested.models : {};
  const wantedModels = [
    ...new Set(
      (Array.isArray(modelsAsked.allowed) ? modelsAsked.allowed : []).filter(
        id => typeof id === 'string' && id !== '' && id !== NO_MODEL_AVAILABLE_ID
      )
    )
  ];
  const lockModel = modelsAsked.lock === true;
  const usableModel = (id, who) => {
    const entry = (catalog?.models || []).find(known => sameId(known?.id, id));
    return (
      Boolean(entry) &&
      entry.enabled !== false &&
      (entry.modelType || 'chat') === 'chat' &&
      canUserAccessResource(who, 'models', id)
    );
  };
  const models = {
    requested: wantedModels.length > 0 || lockModel,
    ids: [],
    lock: lockModel,
    refuse: false,
    reason: CAPABILITY_REASONS.notRequested
  };
  if (models.requested) {
    models.reason = decide({
      installation: allowed.modelChoice === true,
      ownerState,
      owner: true,
      runner: true
    });
    if (!models.reason) {
      models.ids = wantedModels.filter(id => usableModel(id, owner) && usableModel(id, runner));
      const noneLeft = wantedModels.length > 0 && models.ids.length === 0;
      // A locked app runs on its preferred model, which both must be able to use and which
      // the list, if there is one, must name.
      const lockBroken =
        lockModel &&
        (Boolean(model.reason) || (wantedModels.length > 0 && !wantedModels.includes(model.id)));
      if (noneLeft || lockBroken) {
        models.refuse = true;
        const ownerCan = wantedModels.some(id => usableModel(id, owner));
        models.reason =
          (noneLeft && ownerCan) || (lockBroken && model.reason === CAPABILITY_REASONS.youMayNot)
            ? CAPABILITY_REASONS.youMayNot
            : CAPABILITY_REASONS.ownerMayNot;
      }
    }
  }

  // File upload: the installation's switch. The owner's state still counts:
  // an app whose owner is gone or stale runs as plain chat.
  const upload = {
    requested: requested.upload === true,
    reason:
      requested.upload === true
        ? decide({ installation: allowed.upload === true, ownerState, owner: true, runner: true })
        : CAPABILITY_REASONS.notRequested
  };

  // Web search: a search engine both can use.
  const webSearch = {
    requested: requested.webSearch === true,
    reason:
      requested.webSearch === true
        ? decide({
            installation: allowed.webSearch === true,
            ownerState,
            owner: catalog?.webSearch?.owner === true,
            runner: catalog?.webSearch?.runner === true
          })
        : CAPABILITY_REASONS.notRequested
  };

  // Skills: the switch, and the global skills granted to both. Personal skills
  // of the person chatting follow their own rule (`skillAccess.js`).
  const ownerSkills = new Set((catalog?.skills?.owner || []).map(String));
  const skills = {
    requested: requested.skills === true,
    ids: [],
    reason:
      requested.skills === true
        ? decide({
            installation: allowed.skills === true && features.skills !== false,
            ownerState,
            owner: true,
            runner: true
          })
        : CAPABILITY_REASONS.notRequested
  };
  if (!skills.reason) {
    skills.ids = [...new Set((catalog?.skills?.runner || []).map(String))].filter(id =>
      ownerSkills.has(id)
    );
  }

  // Connected systems, one decision per binding.
  const bindings = requestedBindings(content).map(binding => {
    const allowedActions = (allowed.integrations || []).find(entry => entry?.id === binding.id);
    const installation = (catalog?.installations || []).find(entry => entry?.id === binding.id);
    const onList = new Set(actionNames(allowedActions?.actions));
    const actions = binding.actions.filter(action => onList.has(action));
    // A save names only actions the admin listed. A run keeps the ones that
    // are still listed, so taking one action off the list does not stop an
    // app that also uses others.
    const actionsFit = strictActions
      ? binding.actions.length > 0 && actions.length === binding.actions.length
      : actions.length > 0;
    return {
      id: binding.id,
      requested: true,
      actions,
      // What the app stores and how the system is called, for the views.
      storedActions: binding.actions,
      name: installation?.name ?? null,
      reason: decide({
        installation:
          features.integrations !== false &&
          Boolean(allowedActions) &&
          Boolean(installation) &&
          installation.enabled !== false &&
          actionsFit,
        ownerState,
        owner: Boolean(owner) && mayUseIntegration(installation, owner),
        runner: mayUseIntegration(installation, runner)
      })
    };
  });

  // Linked projects, one decision per link: the switch, the features, and then whether the owner
  // and the person the check is made for may each use the project in their own right. A
  // personal app never gives access to a project.
  const projects = requestedProjects(content).map(link => {
    const access = catalog?.projects?.[link.id];
    const user = access?.ownership !== 'admin';
    return {
      id: link.id,
      requested: true,
      name: access?.name || null,
      ownership: access?.ownership || null,
      reason: decide({
        installation:
          allowed.projects === true &&
          features.projects !== false &&
          (!user || features.userProjects !== false) &&
          access?.exists === true,
        ownerState,
        owner: access?.owner === true,
        runner: access?.runner === true
      })
    };
  });

  return { model, models, upload, webSearch, skills, bindings, projects };
}

/** One entry of the `capabilities` list of {@link effectiveUserApp}. */
function capabilityEntry(id, { requested, reason }) {
  return reason ? { id, requested, granted: false, reason } : { id, requested, granted: true };
}

/** A localized text as a new object with string values only. */
function localizedCopy(value) {
  if (!isPlainObject(value)) return undefined;
  const copy = {};
  for (const [language, text] of Object.entries(value)) {
    if (typeof text === 'string') copy[language] = text;
  }
  return Object.keys(copy).length > 0 ? copy : undefined;
}

/** A list of objects with only the allowed keys of each. */
function listCopy(value, keys) {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isPlainObject).map(entry => {
    const copy = {};
    for (const key of keys) {
      if (Object.hasOwn(entry, key) && entry[key] !== undefined) {
        copy[key] = structuredClone(entry[key]);
      }
    }
    return copy;
  });
}

/** The greeting as a new object: per language a title and a subtitle, both strings. */
function greetingCopy(value) {
  if (!isPlainObject(value)) return undefined;
  const copy = {};
  for (const [language, entry] of Object.entries(value)) {
    if (!isPlainObject(entry)) continue;
    const [title, subtitle] = USER_APP_GREETING_KEYS.map(key => entry[key]);
    if (typeof title === 'string' && typeof subtitle === 'string') {
      copy[language] = { title, subtitle };
    }
  }
  return Object.keys(copy).length > 0 ? copy : undefined;
}

/**
 * The input line the author set, checked again: the record was validated when
 * it was saved, but the ceiling does not trust a record. A type or a row count
 * outside the app schema is left out, and the base's value stays.
 */
function inputModeCopy(value) {
  if (!isPlainObject(value)) return undefined;
  const copy = {};
  if (USER_APP_INPUT_MODE_TYPES.includes(value.type)) copy.type = value.type;
  if (Number.isInteger(value.rows) && value.rows >= 1 && value.rows <= USER_APP_LIMITS.inputRows) {
    copy.rows = value.rows;
  }
  return Object.keys(copy).length > 0 ? copy : undefined;
}

/**
 * Write what the author chose about how the chat looks and starts into the app
 * object: greeting, input line, output format, start form, input panel and
 * `autoStart`. None of them adds a tool or reach, so no ceiling decides them;
 * each value is still checked, because a record is not trusted. The input line
 * keeps the microphone of {@link personalAppBase}.
 */
function applyLooks(app, content) {
  const greeting = greetingCopy(content.greeting);
  if (greeting) app.greeting = greeting;
  const inputMode = inputModeCopy(content.inputMode);
  if (inputMode) app.inputMode = { ...app.inputMode, ...inputMode };
  if (USER_APP_OUTPUT_FORMATS.includes(content.preferredOutputFormat)) {
    app.preferredOutputFormat = content.preferredOutputFormat;
  }
  if (isPlainObject(content.startForm) && typeof content.startForm.enabled === 'boolean') {
    app.startForm = { enabled: content.startForm.enabled };
    const label = localizedCopy(content.startForm.submitLabel);
    if (label) app.startForm.submitLabel = label;
  }
  if (isPlainObject(content.variablesPanel) && typeof content.variablesPanel.pinned === 'boolean') {
    app.variablesPanel = { pinned: content.variablesPanel.pinned };
  }
  if (content.autoStart === true) app.autoStart = true;
}

/**
 * Whether a person can send the form without typing a message: true when the
 * message template uses an input field (the rule of a generated draft).
 */
function templateUsesField(prompt, variables) {
  const names = new Set((variables || []).map(variable => variable?.name).filter(Boolean));
  if (names.size === 0 || !isPlainObject(prompt)) return false;
  return Object.values(prompt).some(
    text => typeof text === 'string' && placeholdersIn(text).some(used => names.has(used))
  );
}

/**
 * Whether `runner` is the owner of `record`.
 *
 * @param {Object} record - Stored personal app.
 * @param {Object|null|undefined} runner - `req.user`.
 * @returns {boolean}
 */
export function isRunnerOwner(record, runner) {
  const ownerId = record?.owner?.id;
  if (ownerId === null || ownerId === undefined || ownerId === '') return false;
  if (runner?.id === null || runner?.id === undefined) return false;
  return String(ownerId) === String(runner.id);
}

/**
 * What the author set about how the app researches on the web, cut to what the
 * administrator allows: the pages the page reader may open for one answer, and a
 * sentence of guidance. A value that is not of the right kind is left out.
 */
function webSearchTuning(value, settings) {
  if (!isPlainObject(value)) return {};
  const tuning = {};
  const limit = settings?.capabilities?.webSearchLimits?.maxPageReads;
  if (Number.isInteger(value.maxPageReads) && value.maxPageReads >= 1) {
    tuning.maxPageReads = Number.isInteger(limit)
      ? Math.min(value.maxPageReads, limit)
      : value.maxPageReads;
  }
  if (typeof value.researchGuidance === 'string' && value.researchGuidance.trim() !== '') {
    tuning.researchGuidance = value.researchGuidance.slice(0, USER_APP_LIMITS.researchGuidance);
  }
  return tuning;
}

/**
 * The app a chat request runs, with what the ceiling grants this runner.
 *
 * @param {Object} record - Stored personal app.
 * @param {Object} context
 * @param {Object} context.runner - `req.user`, with resolved permissions.
 * @param {Object|null} context.owner - The owner's principal with resolved
 *   permissions (`lookupUserAppOwner(record).principal`), or null when the
 *   owner is inactive or could not be looked up. Ignored when the runner is
 *   the owner: the owner's rights are then those of the request.
 * @param {ReturnType<typeof import('./userAppSettings.js').userAppSettings>} context.settings
 *   The effective `platform.userApps` block.
 * @param {Object} context.catalog - What the caller looked up; see the module description.
 * @param {number} [context.now] - Clock in milliseconds, for the age of the owner snapshot.
 * @returns {{app: Object, capabilities: Array<{id: string, requested: boolean, granted: boolean,
 *   reason?: string}>, bindings: Array<{id: string, name: Object|string|null, actions: string[]}>,
 *   approval: {mode: 'writes'|'always', chatGrants: boolean}}}
 *   `app` passes `appConfigSchema` and has only keys of `USER_APP_RUN_KEYS`.
 *   `capabilities` lists `model`, `models`, `upload`, `webSearch`, `skills`, one `project:<id>`
 *   per linked project and one
 *   `integration:<installationId>` per binding.
 *
 * @example
 * const owner = lookupUserAppOwner(record, { settings });
 * const { app, approval } = effectiveUserApp(record, {
 *   runner: req.user, owner: owner.principal, settings, catalog, now: Date.now()
 * });
 */
export function effectiveUserApp(record, { runner, owner, settings, catalog, now = Date.now() }) {
  const content = isPlainObject(record?.content) ? record.content : {};
  const runnerIsOwner = isRunnerOwner(record, runner);
  const effectiveOwner = runnerIsOwner ? runner : owner || null;
  const stale = !runnerIsOwner && isOwnerSnapshotStale(record, settings, now);
  const decided = evaluate(content, {
    runner,
    owner: effectiveOwner,
    settings,
    catalog: runnerIsOwner
      ? {
          ...catalog,
          webSearch: { owner: catalog?.webSearch?.runner, runner: catalog?.webSearch?.runner },
          skills: { owner: catalog?.skills?.runner, runner: catalog?.skills?.runner }
        }
      : catalog,
    ownerState: ownerVerdict(effectiveOwner, stale),
    strictActions: false
  });

  const app = personalAppBase(record.id);

  // Content: copied key by key, never spread.
  for (const key of USER_APP_LOCALIZED_KEYS) {
    const text = localizedCopy(content[key]);
    if (text) app[key] = text;
  }
  if (typeof content.icon === 'string' && content.icon !== '') app.icon = content.icon;
  if (typeof content.color === 'string' && content.color !== '') app.color = content.color;
  const variables = listCopy(content.variables, USER_APP_VARIABLE_KEYS);
  if (variables) app.variables = variables;
  const starterPrompts = listCopy(content.starterPrompts, USER_APP_STARTER_PROMPT_KEYS);
  if (starterPrompts) app.starterPrompts = starterPrompts;
  app.allowEmptyContent = templateUsesField(app.prompt, app.variables);
  applyLooks(app, content);

  // Capabilities: written here, never copied from the record.
  // The models of the app: a restriction that leaves no model stops the chat (the one entry
  // that no model has, see `NO_MODEL_AVAILABLE_ID`); a list narrows what the chat may pick.
  if (decided.models.refuse) app.allowedModels = [NO_MODEL_AVAILABLE_ID];
  else if (!decided.models.reason) {
    if (decided.models.ids.length > 0) app.allowedModels = [...decided.models.ids];
    if (decided.models.lock) app.disallowModelSelection = true;
  }
  const preferredAllowed =
    !app.allowedModels || app.allowedModels.some(id => sameId(id, decided.model.id));
  if (!decided.model.reason && preferredAllowed) app.preferredModel = decided.model.id;
  app.upload = structuredClone(decided.upload.reason ? PERSONAL_UPLOAD_OFF : PERSONAL_UPLOAD_ON);
  app.websearch = decided.webSearch.reason
    ? { enabled: false }
    : {
        enabled: true,
        provider: 'auto',
        enabledByDefault: false,
        useNativeSearch: false,
        ...webSearchTuning(content.capabilities?.webSearchSettings, settings)
      };
  if (!decided.skills.reason) {
    app.skillSettings = { enabled: true, allowPersonal: true };
    app.skills = [...decided.skills.ids];
  }
  const granted = decided.bindings.filter(binding => !binding.reason);
  if (granted.length > 0) {
    app.integrations = {};
    for (const binding of granted) {
      app.integrations[binding.id] = {
        actions: [...binding.actions],
        required: false,
        enabledByDefault: false
      };
    }
  }
  // Linked projects: the ones both may use. The projects of the run are exactly this list: a
  // chat of a personal app attaches no other project and runs in none (`resolveProjectScope`),
  // and the picker stays off for it (`userProjects: false`).
  const grantedProjects = decided.projects.filter(link => !link.reason).map(link => link.id);
  if (grantedProjects.length > 0) {
    app.projects = grantedProjects;
    app.features = { ...app.features, projects: true, userProjects: false };
  }
  // The owner runs their app under their own approval settings, whoever
  // saved the content: anyone allowed to change the app changes it, and the
  // owner does not confirm an editor's change (design 6.3). Everyone else is
  // asked before every tool call, reads included, and cannot grant a tool
  // for the chat.
  // The one exception: the tools iHub ships that only read and keep the data inside iHub (the
  // project knowledge tools) do not ask. A shared app that answers from a project would
  // otherwise show a card for every search. Web search, the page reader and every connected
  // system keep asking (`utils/toolApproval.js`, `isExemptInternalRead`).
  app.toolApproval = {
    default: runnerIsOwner ? 'writes' : 'always',
    exemptInternalReads: true
  };

  return {
    app,
    capabilities: [
      capabilityEntry('model', decided.model),
      capabilityEntry('models', decided.models),
      capabilityEntry('upload', decided.upload),
      capabilityEntry('webSearch', decided.webSearch),
      capabilityEntry('skills', decided.skills),
      ...decided.bindings.map(binding =>
        capabilityEntry(integrationCapabilityId(binding.id), binding)
      ),
      ...decided.projects.map(link => capabilityEntry(projectCapabilityId(link.id), link))
    ],
    // Per connected system the app asks for: its display name and the
    // functions the app stores, granted or not; per linked project its name.
    // For the views only.
    bindings: [
      ...decided.bindings.map(binding => ({
        id: integrationCapabilityId(binding.id),
        name: binding.name,
        actions: [...binding.storedActions]
      })),
      // A linked project carries its name, so that an editor can tell which one is withheld.
      ...decided.projects.map(link => ({
        id: projectCapabilityId(link.id),
        name: link.name,
        ownership: link.ownership
      }))
    ],
    approval: { mode: runnerIsOwner ? 'writes' : 'always', chatGrants: runnerIsOwner }
  };
}

/**
 * What stands in the way of saving `content`. Runs on the whole content of
 * the app (for a `PATCH`: the merged content), whatever the request changes:
 * the instructions steer the capabilities, so a person who may not use what
 * the app uses may not rewrite it either.
 *
 * @param {Object} content - Validated content (`userAppContentSchema`).
 * @param {Object} context
 * @param {Object} context.actor - `req.user` of the person saving.
 * @param {Object|null} context.owner - The owner's principal; `actor` itself
 *   when the owner saves; null when the owner is inactive.
 * @param {ReturnType<typeof import('./userAppSettings.js').userAppSettings>} context.settings
 * @param {Object} context.catalog - See the module description; its `runner`
 *   entries are about `actor`.
 * @returns {Array<{capability: string, reason: string}>} Empty when the
 *   content may be saved. `capability` is `model`, `upload`, `webSearch`,
 *   `skills` or `integration:<installationId>`.
 *
 * @example
 * const [denied] = checkCapabilitiesForSave(merged, { actor: req.user, owner, settings, catalog });
 * if (denied) throw new ServiceError('USER_APP_CAPABILITY_DENIED', '…', { details: denied });
 */
export function checkCapabilitiesForSave(content, { actor, owner, settings, catalog }) {
  const decided = evaluate(isPlainObject(content) ? content : {}, {
    runner: actor,
    owner: owner || null,
    settings,
    catalog,
    ownerState: ownerVerdict(owner || null, false),
    strictActions: true
  });
  const denied = [];
  const note = (capability, entry) => {
    if (entry.requested && entry.reason) denied.push({ capability, reason: entry.reason });
  };
  note('model', decided.model);
  note('models', decided.models);
  note('upload', decided.upload);
  note('webSearch', decided.webSearch);
  note('skills', decided.skills);
  for (const binding of decided.bindings) note(integrationCapabilityId(binding.id), binding);
  for (const link of decided.projects) note(projectCapabilityId(link.id), link);
  return denied;
}

/**
 * Whether `next` uses nothing that `previous` did not use already, and
 * changes nothing else. A save of this kind by an editor who may not use
 * everything the app uses is accepted: it only takes capabilities away.
 *
 * @param {Object} previous - The stored content.
 * @param {Object} next - The merged content of the save.
 * @returns {boolean}
 */
export function removesCapabilitiesOnly(previous, next) {
  const before = isPlainObject(previous) ? previous : {};
  const after = isPlainObject(next) ? next : {};
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === 'capabilities' || key === 'preferredModel') continue;
    if (!same(before[key], after[key])) return false;
  }
  // The preferred model may stay or go, not change.
  if (after.preferredModel && !same(before.preferredModel, after.preferredModel)) return false;

  const was = before.capabilities || {};
  const is = after.capabilities || {};
  for (const flag of ['upload', 'webSearch', 'skills']) {
    if (is[flag] === true && was[flag] !== true) return false;
  }
  // The choice of models and the settings of web search may stay or go, not change.
  for (const key of ['models', 'webSearchSettings']) {
    if (is[key] !== undefined && !same(was[key], is[key])) return false;
  }
  // Projects may be taken away, not added.
  const wasLinked = new Set(requestedProjects(before).map(link => link.id));
  if (requestedProjects(after).some(link => !wasLinked.has(link.id))) return false;
  const wasBound = new Map(requestedBindings(before).map(binding => [binding.id, binding.actions]));
  for (const binding of requestedBindings(after)) {
    const actions = wasBound.get(binding.id);
    if (!actions) return false;
    if (binding.actions.some(action => !actions.includes(action))) return false;
  }
  return true;
}
