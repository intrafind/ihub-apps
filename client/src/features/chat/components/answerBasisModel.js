// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the footer's basis chip and its "About this answer" popover say, as
 * data: the words of each kind, the sentence, the projects of the scope. The
 * server decides what the answer is based on (`run/ended.answerBasis`, and
 * `contributed` per project of `knowledge/scope`); nothing here infers it from a
 * tool id or a source list, this only words it.
 *
 * @module features/chat/components/answerBasisModel
 */

import { knowledgeModeLabel } from '../../projects/utils/knowledgeModes';

/** The icon of each kind. Colour does not tell the kinds apart: the icon and the noun do. */
export const KIND_ICON = Object.freeze({
  project: 'folder',
  web: 'globe-alt',
  ifinder: 'document-text',
  iassistant: 'book-open',
  documents: 'document-duplicate',
  integration: 'link',
  email: 'mail',
  file: 'paper-clip',
  audio: 'microphone',
  model: 'sparkles',
  workflow: 'cog'
});

/** English fallbacks of the nouns on the chip; the strings live in `chatMessage.answerBasis.kind`. */
const KIND_LABEL = {
  project: 'Project',
  web: 'Web',
  ifinder: 'iFinder',
  iassistant: 'iAssistant',
  documents: 'Documents',
  integration: 'Integration',
  email: 'Email',
  file: 'File',
  audio: 'Recording',
  model: 'Model knowledge',
  workflow: 'Workflow'
};

/** English fallbacks of the nouns inside the sentence ("based on project and web"). */
const KIND_PHRASE = {
  project: 'project',
  web: 'web',
  ifinder: 'iFinder',
  iassistant: 'iAssistant',
  documents: 'documents',
  integration: 'a connected system',
  email: 'the email',
  file: 'the uploaded file',
  audio: 'the recording',
  model: "the model's knowledge",
  workflow: 'a workflow'
};

/** The most kinds the chip names; the rest is "+N". */
export const MAX_NAMED_KINDS = 2;

/**
 * The entries the chip names. A workflow answer is named by its workflow alone.
 * Without a basis the server did not name there is nothing to show: a message
 * stored before the field existed shows no chip, and nothing is derived from
 * its other fields.
 *
 * @param {Array<{kind: string, label?: string}>|null|undefined} answerBasis
 * @param {Object|null|undefined} workflowResult
 * @returns {Array<{kind: string, label?: string}>}
 */
export function basisEntries(answerBasis, workflowResult) {
  if (workflowResult) return [{ kind: 'workflow' }];
  return Array.isArray(answerBasis) ? answerBasis.filter(entry => entry?.kind) : [];
}

/** The noun of an entry on the chip: an integration's own label, else the kind's word. */
export function entryLabel(entry, t) {
  if (entry.kind === 'integration' && entry.label) return entry.label;
  return t(`chatMessage.answerBasis.kind.${entry.kind}`, KIND_LABEL[entry.kind] || entry.kind);
}

/** The noun of an entry inside a sentence. */
function entryPhrase(entry, t) {
  if (entry.kind === 'integration' && entry.label) return entry.label;
  return t(`chatMessage.answerBasis.phrase.${entry.kind}`, KIND_PHRASE[entry.kind] || entry.kind);
}

/**
 * "project and web", "Jira, project and web": the kinds as a list in the
 * reader's language.
 */
function listOf(phrases, language) {
  try {
    return new Intl.ListFormat(language || undefined, {
      style: 'long',
      type: 'conjunction'
    }).format(phrases);
  } catch {
    return phrases.join(', ');
  }
}

/**
 * The chip: the first kinds by name and how many more there are.
 *
 * @param {Array<{kind: string, label?: string}>} entries
 * @returns {{named: Array<Object>, more: number}}
 */
export function chipParts(entries) {
  return {
    named: entries.slice(0, MAX_NAMED_KINDS),
    more: Math.max(entries.length - MAX_NAMED_KINDS, 0)
  };
}

/**
 * The basis of the answer in words, for the popover's first section and for
 * the chip's accessible name: "project and web", "the model's knowledge".
 *
 * @param {Array<{kind: string, label?: string}>} entries
 * @param {Function} t - i18next `t`
 * @param {string} [language]
 * @returns {string}
 */
export function basisPhrase(entries, t, language) {
  return listOf(
    entries.map(entry => entryPhrase(entry, t)),
    language
  );
}

/** The chip's accessible name: it keeps the full text when the nouns are dropped. */
export function chipAccessibleName(entries, t, language) {
  return t('chatMessage.answerBasis.chipLabel', 'About this answer: based on {{what}}', {
    what: basisPhrase(entries, t, language)
  });
}

/** Whether the answer used no source at all: the model's own knowledge. */
export const isModelOnly = entries => entries.length === 1 && entries[0].kind === 'model';

// ── the projects of the scope ───────────────────────────────────────────────

/** Whether a scope entry is a user project (it has a page to link to). */
export const isUserProject = project =>
  typeof project?.id === 'string' && project.id.startsWith('prj_');

/** A scope entry's name; a project the viewer may not see by name stays anonymous. */
export function projectName(project, t) {
  // An iFinder collection that could not be asked has no name the server remembers.
  if (!project.name && project.id?.startsWith('ifc_')) {
    return t('chatMessage.knowledgeScope.ifinderCollection', 'iFinder collection');
  }
  return (
    project.name || project.id || t('chatMessage.knowledgeScope.privateProject', 'Private project')
  );
}

/**
 * How a project was used, in plain words: *all documents read*, *searched for
 * matching passages*, *only pinned documents*.
 */
export function projectModeText(project, t) {
  if (project.knowledgeMode === 'pinned' || project.mode === 'pinned') {
    return t('chatMessage.answerBasis.mode.pinned', 'only pinned documents');
  }
  if (project.mode === 'loaded') {
    return t('chatMessage.answerBasis.mode.loaded', 'all documents read');
  }
  return t('chatMessage.answerBasis.mode.searched', 'searched for matching passages');
}

/**
 * The diagnostics of a project, as muted text: the knowledge mode and the level
 * that chose it, that the model cannot call tools, that the project is over its
 * budget. Kept for everybody, as the tooltips they replace were.
 *
 * @returns {string[]}
 */
export function projectDiagnostics(project, t) {
  const lines = [];
  if (project.knowledgeMode) {
    lines.push(
      t('chatMessage.answerBasis.knowledgeMode', 'Knowledge mode: {{mode}}', {
        mode: knowledgeModeLabel(t, project.knowledgeMode)
      })
    );
  }
  if (project.modeFallback) {
    lines.push(t('chatMessage.knowledgeScope.noTools', 'the model cannot call tools'));
  }
  if (project.overBudget) lines.push(t('chatMessage.knowledgeScope.overBudget', 'over budget'));
  return lines;
}

/**
 * The projects of the scope split by what the answer did with them. Only a
 * project that `contributed` is a source; the others were in scope and go under
 * "Not used", each with its reason. A project the turn could not read
 * (`unavailable`) is also the amber chip.
 *
 * @param {{projects?: Array<Object>}|null|undefined} scope - `knowledge/scope`
 * @returns {{used: Array<Object>, unused: Array<Object>, unavailable: Array<Object>}}
 */
export function splitScope(scope) {
  const all = Array.isArray(scope?.projects) ? scope.projects : [];
  return {
    used: all.filter(project => project.mode !== 'unavailable' && project.contributed === true),
    unused: all.filter(project => project.contributed !== true),
    unavailable: all.filter(project => project.mode === 'unavailable')
  };
}

/** Why a project in scope was not used. */
export function unusedReason(project, t) {
  if (project.mode === 'unavailable') {
    return project.reason === 'IFINDER_UNAVAILABLE'
      ? t(
          'chatMessage.knowledgeScope.missingIFinder',
          'iFinder could not be reached, so this answer did not use it.'
        )
      : t('chatMessage.knowledgeScope.missingOther', 'This answer did not use it.');
  }
  return t(
    'chatMessage.answerBasis.notUsedReason',
    'It was in scope, but nothing from it went into this answer.'
  );
}
