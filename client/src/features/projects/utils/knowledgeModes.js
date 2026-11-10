// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Labels of the knowledge modes (`shared/knowledgeModes.js`, #3538). The mode a
 * request is answered in is decided on the server and sent with the
 * `knowledge/scope` event; this only words it.
 *
 * @module features/projects/utils/knowledgeModes
 */

const LABELS = {
  auto: 'Automatic',
  context: 'Full context',
  relevant: 'Relevant sections',
  tools: 'Search',
  pinned: 'Pinned only'
};

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
 * What a knowledge mode does, in one sentence.
 *
 * @param {Function} t - i18next `t`.
 * @param {string} mode
 * @returns {string}
 */
export function knowledgeModeDescription(t, mode) {
  return t(`projects.knowledgeMode.modes.${mode}.description`, DESCRIPTIONS[mode] || '');
}
