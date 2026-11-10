// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Labels of the knowledge modes (`shared/knowledgeModes.js`, #3538). The mode a
 * request is answered in is decided on the server and sent with the
 * `knowledge/scope` event; this only words it.
 *
 * @module features/projects/utils/knowledgeModes
 */

import { isKnowledgeMode } from '../../../../../shared/knowledgeModes.js';

const LABELS = {
  auto: 'Automatic',
  context: 'Read everything',
  relevant: 'Best passages',
  tools: 'Look things up',
  pinned: 'Pinned documents only'
};

// One line each, for a narrow menu; the long descriptions are for the settings pages.
const SHORT_DESCRIPTIONS = {
  auto: 'Everything if it fits, otherwise the best parts.',
  context: "All documents, up to the model's limit. Good for a contract.",
  relevant: 'Pinned documents plus the best passages for your question.',
  tools: 'Pinned documents; the model looks up the rest.',
  pinned: 'Only pinned documents. Nothing else is available.'
};

/**
 * The modes a chat's picker offers. `relevant` and `tools` describe how
 * retrieval works rather than what a user wants, so they stay on the project
 * page and the admin link editor.
 */
export const CHAT_KNOWLEDGE_MODES = Object.freeze(['auto', 'context', 'pinned']);

/**
 * The modes the chat's picker lists: the ones it offers that the platform
 * allows, plus the mode the chat already has, so a value set elsewhere is shown
 * and can be left again, not silently replaced.
 *
 * @param {string[]} allowed - `useProjectsAvailability().knowledgeModes`
 * @param {string} [current] - The chat's own mode, '' for none.
 * @returns {string[]}
 */
export function chatKnowledgeModes(allowed, current = '') {
  const offered = CHAT_KNOWLEDGE_MODES.filter(mode => allowed.includes(mode));
  return isKnowledgeMode(current) && !offered.includes(current) ? [...offered, current] : offered;
}

const DESCRIPTIONS = {
  auto: 'Everything when it fits, otherwise the pinned documents and the best sections for the question. The model can search the rest.',
  context:
    'Everything, up to the limit of the model. For small sets that must be read whole: a contract, a policy, a specification.',
  relevant:
    'The pinned documents and the best sections for the question from all documents. Saves a tool round trip; for large projects and models that call tools poorly.',
  tools:
    'The pinned documents only; the model searches the rest. For large libraries and agents that search on purpose.',
  pinned:
    'The pinned documents only, and the model cannot reach the others. A curated subset of a large project.'
};

/**
 * The name of a knowledge mode.
 *
 * @param {Function} t - i18next `t`.
 * @param {string} mode
 * @returns {string}
 */
export function knowledgeModeLabel(t, mode) {
  return t(`projects.knowledgeMode.modes.${mode}.label`, LABELS[mode] || mode);
}

/**
 * What a knowledge mode does, in a line short enough for a menu.
 *
 * @param {Function} t - i18next `t`.
 * @param {string} mode
 * @returns {string}
 */
export function knowledgeModeShortDescription(t, mode) {
  return t(`projects.knowledgeMode.modes.${mode}.short`, SHORT_DESCRIPTIONS[mode] || '');
}

/**
 * What a knowledge mode does, in one sentence.
 *
 * @param {Function} t - i18next `t`.
 * @param {string} mode
 * @returns {string}
 */
export function knowledgeModeDescription(t, mode) {
  return t(`projects.knowledgeMode.modes.${mode}.description`, DESCRIPTIONS[mode] || '');
}
