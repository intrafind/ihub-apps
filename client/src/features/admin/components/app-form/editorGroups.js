// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The groups of the app editor: which there are, which group shows a field,
 * what a collapsed group says about its values, and whether those values
 * differ from a new app. Pure (no React). The editor page and the app form
 * share it; the open state lives in `useEditorGroups`.
 *
 * @module features/admin/components/app-form/editorGroups
 */

import { newAppDefaults } from '../../../../../../shared/appDefaults.js';
import { ALL_INTEGRATIONS_KEY } from '../../../../../../shared/appWildcards.js';
import { getLocalizedContent } from '../../../../utils/localizeContent';

const ALL_TYPES = Object.freeze(['chat', 'iframe', 'redirect']);
const CHAT_ONLY = Object.freeze(['chat']);

const group = (id, labelKey, defaultOpen, types) =>
  Object.freeze({ id, labelKey, defaultOpen, types });

/**
 * The groups in page order; `access` is last and is rendered by the page, the
 * others by the form. `types` names the app types a group is rendered for.
 * @type {ReadonlyArray<{id: string, labelKey: string, defaultOpen: boolean, types: readonly string[]}>}
 */
export const EDITOR_GROUPS = Object.freeze([
  group('basics', 'admin.apps.edit.groups.basics', true, ALL_TYPES),
  group('instructions', 'admin.apps.edit.groups.instructions', true, CHAT_ONLY),
  group('model', 'admin.apps.edit.groups.model', false, CHAT_ONLY),
  group('knowledge', 'admin.apps.edit.groups.knowledge', false, CHAT_ONLY),
  group('chat', 'admin.apps.edit.groups.chat', false, CHAT_ONLY),
  group('input', 'admin.apps.edit.groups.input', false, CHAT_ONLY),
  group('userSettings', 'admin.apps.edit.groups.userSettings', false, CHAT_ONLY),
  group('access', 'admin.apps.edit.groups.access', false, ALL_TYPES)
]);

/** True for the ID of a group. */
export const isEditorGroupId = id => EDITOR_GROUPS.some(entry => entry.id === id);

/**
 * The DOM ids of a group. They carry a prefix so that `model`, `chat` or
 * `input` never collide with a field; the hook resolves the hash `#<group id>`.
 *
 * @param {string} id - A group ID.
 * @returns {{group: string, header: string, panel: string}} Wrapper, header button, panel.
 */
export function groupDomIds(id) {
  return {
    group: `app-group-${id}`,
    header: `app-group-${id}-header`,
    panel: `app-group-${id}-panel`
  };
}

/**
 * The group whose section shows a field, by the longest prefix of its path.
 * A field the form does not show has no entry and counts for Basics.
 */
const FIELD_GROUPS = new Map(
  Object.entries({
    instructions:
      'system prompt messagePlaceholder variables startForm variablesPanel starterPrompts',
    model: 'preferredModel allowedModels preferredOutputFormat',
    knowledge:
      'websearch iassistant integrations toolChoice toolApproval toolSearch workflows apps ' +
      'skills skillSettings projects features.projects features.userProjects',
    chat: 'upload features documentTemplate aiDisclosure usageGuide autoStart ephemeral',
    input: 'inputMode settings.speechRecognition',
    userSettings: 'settings'
  }).flatMap(([id, fields]) => fields.split(' ').map(field => [field, id]))
);

/**
 * The group that shows a field.
 *
 * @param {string} path - A field path as validation reports it.
 * @returns {string} A group ID; `basics` for a field no group shows.
 *
 * @example
 * groupOfField('variables.0.name'); // → 'instructions'
 * groupOfField('settings.speechRecognition.host'); // → 'input'
 * groupOfField('color'); // → 'basics'
 */
export function groupOfField(path) {
  const parts = String(path ?? '')
    .replaceAll(/\[(\w+)\]/g, '.$1')
    .split(/[./]/)
    .filter(Boolean);
  for (let length = parts.length; length > 0; length--) {
    const id = FIELD_GROUPS.get(parts.slice(0, length).join('.'));
    if (id) return id;
  }
  return 'basics';
}

const SEPARATOR = ' · ';
const USER_SETTINGS = ['model', 'outputFormat', 'chatHistory', 'style'];

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isMicrophoneOn = app =>
  (app.inputMode?.microphone?.enabled ?? app.microphone?.enabled) !== false;

/** The number of bound connected systems, or `'all'` for the binding of everything. */
function connectedSystems(app) {
  const bound = isPlainObject(app.integrations) ? Object.keys(app.integrations) : [];
  if (bound.includes(ALL_INTEGRATIONS_KEY)) return 'all';
  // iAssistant counts while it is on, bound or not (as its panel in the form reads it).
  const unbound = app.iassistant?.enabled === true && !bound.includes('iassistant');
  return bound.length + (unbound ? 1 : 0);
}

/** What a collapsed group says, by group ID: a text, or parts that are joined. */
const SUMMARIES = {
  model(app, t, { models, language }) {
    if (!app.preferredModel) return t('admin.apps.edit.summary.standardModel');
    const model = (Array.isArray(models) ? models : []).find(m => m?.id === app.preferredModel);
    const base = String(language || '').split('-')[0] || undefined;
    return getLocalizedContent(model?.name, base) || app.preferredModel;
  },
  knowledge(app, t) {
    const systems = connectedSystems(app);
    return [
      app.websearch?.enabled
        ? t('admin.apps.edit.summary.webSearchOn')
        : t('admin.apps.edit.summary.webSearchOff'),
      systems === 'all'
        ? t('admin.apps.edit.summary.allConnectedSystems')
        : systems > 0 && t('admin.apps.edit.summary.connectedSystems', { count: systems })
    ];
  },
  chat(app, t) {
    const on = [
      app.features?.export !== false && t('admin.apps.edit.summary.featureExport'),
      app.features?.feedback !== false && t('admin.apps.edit.summary.featureFeedback')
    ].filter(Boolean);
    return [
      app.upload?.enabled
        ? t('admin.apps.edit.summary.uploadOn')
        : t('admin.apps.edit.summary.uploadOff'),
      on.length > 0 && t('admin.apps.edit.summary.featuresOn', { features: on.join(', ') })
    ];
  },
  input(app, t) {
    return [
      app.inputMode?.type === 'multiline'
        ? t('admin.apps.edit.summary.multiLine')
        : t('admin.apps.edit.summary.singleLine'),
      isMicrophoneOn(app)
        ? t('admin.apps.edit.summary.microphoneOn')
        : t('admin.apps.edit.summary.microphoneOff')
    ];
  },
  userSettings(app, t) {
    const on = USER_SETTINGS.filter(key => app.settings?.[key]?.enabled !== false).length;
    return t('admin.apps.edit.summary.settingsOn', { on, total: USER_SETTINGS.length });
  },
  access(_app, t, { access }) {
    if (typeof access === 'string') return access;
    if (!isPlainObject(access)) return '';
    // The two facts of `audience` are independent (see `audienceText`): open to
    // people who are not signed in does not say that every signed-in user has it.
    const anonymous = access.audience?.anonymous === true;
    if (access.audience?.allSignedIn === true) {
      return t(
        anonymous ? 'admin.apps.edit.access.everyone' : 'admin.apps.edit.access.everyoneSignedIn'
      );
    }
    const rows = Array.isArray(access.groups) ? access.groups : [];
    const count = rows.filter(row => row?.effective && !row.implicit).length;
    if (anonymous) {
      return [
        t('admin.apps.edit.access.notSignedIn'),
        count > 0 &&
          t(
            access.scope === 'membership'
              ? 'admin.apps.edit.summary.ownGroups'
              : 'admin.apps.edit.summary.groups',
            { count }
          )
      ];
    }
    // A content admin sees only the groups they manage, so the line says so.
    if (access.scope === 'membership') {
      return count > 0
        ? t('admin.apps.edit.summary.ownGroups', { count })
        : t('admin.apps.edit.summary.noOwnGroups');
    }
    return count > 0
      ? t('admin.apps.edit.summary.groups', { count })
      : t('admin.apps.edit.summary.noGroups');
  }
};

/**
 * The text of a collapsed group's summary line.
 *
 * @param {string} id - A group ID.
 * @param {object|null} app - The app as the editor holds it.
 * @param {function} t - The translation function.
 * @param {object} [extra] - What the app does not hold.
 * @param {Array<{id: string, name: string|object}>} [extra.models] - To name the preferred model.
 * @param {string} [extra.language] - The UI language, for that name.
 * @param {object|string} [extra.access] - The view of
 *   `GET /api/admin/content-access/apps/{id}` (`scope`, `groups`, `audience`),
 *   or a ready text. Without it the access group has no summary.
 * @returns {string} `''` for a group without a summary line (Basics,
 *   Instructions and inputs) and while the data is missing.
 *
 * @example
 * groupSummary('userSettings', { settings: { style: { enabled: false } } }, t); // → '3 of 4 on'
 */
export function groupSummary(id, app, t, extra) {
  if (!Object.hasOwn(SUMMARIES, id) || (!app && id !== 'access')) return '';
  const summary = SUMMARIES[id](app, t, extra || {});
  return Array.isArray(summary) ? summary.filter(Boolean).join(SEPARATOR) : summary;
}

/** A switched-off block counts like a missing one. */
const whenOn = block => (block?.enabled ? block : undefined);

/** What a group is set to, by group ID. Absent and default values read the same. */
const GROUP_STATES = {
  model: app => ({
    preferredModel: app.preferredModel,
    allowedModels: app.allowedModels,
    outputFormat: app.preferredOutputFormat !== 'markdown' && app.preferredOutputFormat
  }),
  knowledge: app => ({
    websearch: whenOn(app.websearch),
    iassistant: whenOn(app.iassistant),
    integrations: app.integrations,
    toolChoice: app.toolChoice !== 'auto' && app.toolChoice,
    toolApproval: app.toolApproval,
    toolSearch: app.toolSearch,
    workflows: app.workflows,
    apps: app.apps,
    skills: app.skillSettings?.enabled === true && [app.skillSettings, app.skills],
    projects: app.projects,
    projectsOff: app.features?.projects === false,
    userProjectsOff: app.features?.userProjects === false
  }),
  chat(app) {
    const notice = app.aiDisclosure?.firstTurnNotice;
    return {
      upload: whenOn(app.upload),
      magicPrompt: whenOn(app.features?.magicPrompt),
      exportOff: app.features?.export === false,
      compareModeOff: app.features?.compareMode?.enabled === false,
      feedbackOff: app.features?.feedback === false,
      documentTemplate: app.documentTemplate,
      aiNotice: notice?.enabled === false ? 'off' : notice?.text,
      usageGuide: Object.values(app.usageGuide?.content || {}).some(isSet) && app.usageGuide,
      autoStart: app.autoStart === true,
      ephemeral: app.ephemeral === true
    };
  },
  input(app) {
    const mode = app.inputMode || {};
    const microphone = isMicrophoneOn(app) ? mode.microphone || {} : null;
    const speech = app.settings?.speechRecognition;
    return {
      multiline: mode.type === 'multiline' && (mode.rows || 5),
      microphoneOff: !microphone,
      automatic: microphone?.mode === 'automatic',
      transcriptOff: microphone?.showTranscript === false,
      voiceMode: Object.values(mode.voiceMode || {}).some(isSet) && mode.voiceMode,
      speech: (speech?.service || 'default') !== 'default' && speech
    };
  },
  userSettings: app =>
    Object.fromEntries(USER_SETTINGS.map(key => [key, app.settings?.[key]?.enabled === false]))
};

/** False for a value that says nothing: missing, empty or switched off. */
function isSet(value) {
  if (value === undefined || value === null || value === '' || value === false) return false;
  return typeof value === 'object' ? Object.keys(value).length > 0 : true;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => deepEqual(a[key], b[key]));
}

let defaultStates;

/**
 * Whether a collapsed group differs from a new app (`newAppDefaults()`), so
 * that its summary line carries the "changed" marker. A value that is missing
 * and one that is set to its default read the same, and so does a block that
 * is switched off, whatever it still holds.
 *
 * @param {string} id - A group ID.
 * @param {object|null} app - The app as the editor holds it.
 * @returns {boolean} Always false for Basics and Instructions and inputs, which every app
 *   fills and which have no summary line, and for access, which the app does not store.
 *
 * @example
 * groupChanged('chat', { upload: { enabled: true } }); // → true
 * groupChanged('chat', { upload: { enabled: false, allowMultiple: true } }); // → false
 */
export function groupChanged(id, app) {
  if (!Object.hasOwn(GROUP_STATES, id) || !app) return false;
  defaultStates ??= Object.fromEntries(
    Object.entries(GROUP_STATES).map(([groupId, stateOf]) => [groupId, stateOf(newAppDefaults())])
  );
  const state = GROUP_STATES[id](app);
  const initial = defaultStates[id];
  return Object.keys(state).some(
    key => (isSet(state[key]) || isSet(initial[key])) && !deepEqual(state[key], initial[key])
  );
}
