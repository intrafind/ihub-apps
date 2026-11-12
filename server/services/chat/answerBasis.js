// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What an answer is based on, named by the server so the chat only draws it
 * (`run/ended.answerBasis`). The footer's basis chip shows the **kinds** of
 * source the turn used — a project, the web, iFinder, Jira — and nothing else:
 * no names, modes or prefix. An answer that used none is named as the model's
 * own knowledge, never as "no sources".
 *
 * Two inputs decide it, both recorded while the turn ran:
 *  - the knowledge sources (`websearch`, `project`, `integration`, …) of
 *    `knowledgeSourceSeam`, the prompt and the uploads, and
 *  - the names of the connected systems that informed it.
 *
 * `knowledgeSources` itself stays what it was: the ledger's and analytics' list.
 *
 * @module services/chat/answerBasis
 */

import { ANSWER_BASIS_KINDS, MODEL_KNOWLEDGE_SOURCE } from '../../../shared/runEvents.js';
import { boundedText } from '../../utils/toolIntegrationLabel.js';

/** The kind a knowledge source stands for. Anything else (`llm`) is not a source. */
const KIND_OF_SOURCE = Object.freeze({
  project: 'project',
  websearch: 'web',
  // The provider's own search (Google Search grounding) is the web as well.
  grounding: 'web',
  ifinder: 'ifinder',
  iassistant: 'iassistant',
  // What an admin configured (`sources`): "Documents".
  sources: 'documents',
  integration: 'integration',
  email: 'email',
  file: 'file',
  audio: 'audio'
});

/** Most entries a stored answer keeps. */
const MAX_BASIS_ENTRIES = 12;

/**
 * The basis of an answer.
 *
 * One entry per kind, and one per connected system (named by `label`). `model`
 * stands alone, when nothing was used. A passthrough answer is the tool's own
 * output, not the model's (`byModel: false`): it is named by what it used and
 * has no basis when that is nothing.
 *
 * @param {Object} input
 * @param {string[]} [input.knowledgeSources] - The turn's knowledge sources
 * @param {string[]} [input.integrations] - Names of the connected systems that informed it ('' for one without)
 * @param {boolean} [input.byModel=true] - Whether the model wrote the answer
 * @returns {Array<{kind: string, label?: string}>}
 */
export function answerBasisOf({ knowledgeSources = [], integrations = [], byModel = true } = {}) {
  const kinds = new Set(
    (knowledgeSources || [])
      .filter(source => source !== MODEL_KNOWLEDGE_SOURCE)
      .map(source => KIND_OF_SOURCE[source])
      .filter(Boolean)
  );
  const names = [...new Set((integrations || []).map(name => boundedText(name) || ''))];
  // A connected system was used, whether or not its name is known.
  if (names.length > 0) kinds.add('integration');

  const basis = [];
  for (const kind of ANSWER_BASIS_KINDS) {
    if (!kinds.has(kind)) continue;
    if (kind !== 'integration') {
      basis.push({ kind });
      continue;
    }
    // Named systems first, one entry each; the unnamed ones are one entry.
    const named = names.filter(Boolean);
    for (const label of named) basis.push({ kind, label });
    if (named.length === 0 || names.includes('')) basis.push({ kind });
  }
  if (basis.length === 0 && byModel) return [{ kind: 'model' }];
  // The bound of a stored answer, so the live chip and the reopened one agree.
  return boundAnswerBasis(basis) ?? [];
}

/**
 * The basis as a stored message keeps it: only known kinds, a bounded label,
 * a bounded list. Whatever else a caller handed over is dropped.
 *
 * @param {unknown} basis
 * @returns {Array<{kind: string, label?: string}>|undefined} undefined when nothing is left
 */
export function boundAnswerBasis(basis) {
  if (!Array.isArray(basis)) return undefined;
  const out = [];
  for (const entry of basis) {
    if (!ANSWER_BASIS_KINDS.includes(entry?.kind)) continue;
    const label = entry.kind === 'integration' ? boundedText(entry.label) : null;
    out.push(label ? { kind: entry.kind, label } : { kind: entry.kind });
    if (out.length >= MAX_BASIS_ENTRIES) break;
  }
  return out.length > 0 ? out : undefined;
}

/**
 * The ids of the projects whose documents the turn's tools handed over: a
 * search that returned passages, a read. Listing documents reads none.
 *
 * @param {{items?: Array<Object>}|null|undefined} sources - The turn's source set (`result.sources`)
 * @returns {Set<string>}
 */
export function projectIdsReadBy(sources) {
  const ids = new Set();
  for (const item of Array.isArray(sources?.items) ? sources.items : []) {
    if (item?.provider === 'project' && typeof item.ref?.scope === 'string') {
      ids.add(item.ref.scope);
    }
  }
  return ids;
}

/**
 * The turn's knowledge scope with each project's `contributed` settled.
 *
 * The scope is first reported when the turn starts, when only what went into
 * the prompt is known. A searched project contributes when a tool call of the
 * turn returned its documents, which is known when the turn ends: this returns
 * the scope to report then. The same object comes back when nothing changed,
 * so a caller can tell whether to report it again.
 *
 * @param {{projects?: Array<Object>}|null|undefined} scope - `scopeSummary(plan)`
 * @param {{items?: Array<Object>}|null|undefined} sources - The turn's source set
 * @param {Iterable<string>} [alsoRead] - Projects read before an approval paused the turn
 *   (`carriedBasis`)
 * @returns {Object|null|undefined}
 */
export function settleKnowledgeScope(scope, sources, alsoRead = []) {
  if (!Array.isArray(scope?.projects) || scope.projects.length === 0) return scope;
  const read = projectIdsReadBy(sources);
  for (const id of alsoRead || []) read.add(id);
  let changed = false;
  const projects = scope.projects.map(project => {
    const contributed =
      project.mode !== 'unavailable' && (project.contributed === true || read.has(project.id));
    if (contributed === (project.contributed === true)) return project;
    changed = true;
    return { ...project, contributed };
  });
  return changed ? { ...scope, projects } : scope;
}

// ── across an approval pause ────────────────────────────────────────────────

/** Most entries of each list a paused turn carries. */
const MAX_CARRIED = 24;

const stringList = (value, max = MAX_CARRIED) =>
  Array.isArray(value)
    ? [
        ...new Set(value.filter(item => typeof item === 'string').map(item => item.slice(0, 200)))
      ].slice(0, max)
    : [];

/**
 * What the basis of an answer rests on, as a turn that pauses on a tool approval
 * carries it to the turn that continues it. The continuation is a new loop run
 * that starts with nothing recorded, so without this the answer after an approval
 * would be named by the approved call alone: "Model knowledge" for an answer a
 * search before the pause informed.
 *
 * It is cumulative: a continuation that pauses again carries what it inherited.
 *
 * @param {Object} input
 * @param {Object|null} [input.prior] - What the paused turn itself inherited (`resume.basis`)
 * @param {Object} input.result - The loop result of the segment that paused
 * @returns {{knowledgeSources: string[], integrations: string[], projectsRead: string[]}}
 */
export function carriedBasis({ prior = null, result } = {}) {
  return boundCarriedBasis({
    knowledgeSources: [...(prior?.knowledgeSources || []), ...(result?.knowledgeSources || [])],
    integrations: [...(prior?.integrations || []), ...(result?.integrations || [])],
    projectsRead: [...(prior?.projectsRead || []), ...projectIdsReadBy(result?.sources)]
  });
}

/**
 * A carried basis as it is stored and read back: strings only, bounded. Whatever else
 * a stored chat holds under it is dropped.
 *
 * @param {unknown} basis
 * @returns {{knowledgeSources: string[], integrations: string[], projectsRead: string[]}}
 */
export function boundCarriedBasis(basis) {
  return {
    knowledgeSources: stringList(basis?.knowledgeSources),
    // '' stands for a connected system without a name: kept.
    integrations: stringList(basis?.integrations, 12),
    projectsRead: stringList(basis?.projectsRead)
  };
}
