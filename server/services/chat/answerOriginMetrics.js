// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The counters of where an answer came from (#3668), recorded once per answer
 * with the basis the footer shows and the sources the turn found:
 *
 *  - `ihub.answer.basis{kinds_bucket}`: how many kinds of source the basis names;
 *  - `ihub.answer.origin.mismatch`: a source names an origin that the basis
 *    leaves out, so the footer and the Sources panel would disagree.
 *
 * @module services/chat/answerOriginMetrics
 */

import { recordAnswerBasis, recordAnswerOriginMismatch } from '../../telemetry/metrics.js';
import { ANSWER_BASIS_KINDS } from '../../../shared/runEvents.js';

/** What a basis entry says the answer rests on; `model` is the fallback, not a source. */
function sourceKindsOf(answerBasis) {
  return new Set(
    (Array.isArray(answerBasis) ? answerBasis : [])
      .map(entry => entry?.kind)
      .filter(kind => ANSWER_BASIS_KINDS.includes(kind) && kind !== 'model')
  );
}

/** The origin kinds the turn's sources carry (set by the server from the call that found each). */
function originKindsOf(sources) {
  const items = Array.isArray(sources?.items) ? sources.items : [];
  return new Set(items.map(item => item?.origin?.kind).filter(Boolean));
}

/**
 * The origins the sources name and the basis does not. A web page found by a
 * search the answer then did not use is still a source of the turn; the
 * comparison is of kinds, never of counts.
 *
 * @param {Array<{kind: string}>|undefined} answerBasis
 * @param {{items?: Object[]}|undefined} sources
 * @returns {string[]}
 */
export function originsMissingFromBasis(answerBasis, sources) {
  const basis = sourceKindsOf(answerBasis);
  return [...originKindsOf(sources)].filter(kind => !basis.has(kind));
}

/**
 * Count one finished answer. Never throws: telemetry must not fail a turn.
 *
 * @param {Array<{kind: string}>|undefined} answerBasis
 * @param {{items?: Object[]}|undefined} sources - the turn's sources (`result.sources`)
 */
export function recordAnswerOriginMetrics(answerBasis, sources) {
  try {
    recordAnswerBasis(sourceKindsOf(answerBasis).size);
    if (originsMissingFromBasis(answerBasis, sources).length > 0) recordAnswerOriginMismatch();
  } catch {
    /* telemetry only */
  }
}

/**
 * What a search or fetch came to, for the call counter: an error, no results
 * (a declared zero, or a read that delivered no text), results, or unknown when
 * the result did not say. Nothing is inferred from an empty source list.
 */
export function toolCallOutcomeOf(outcome, verdict) {
  if (verdict?.failed || outcome?.error) return 'error';
  if (outcome?.resultCount === 0 || outcome?.readOutcome === 'empty') return 'empty';
  if (outcome?.resultCount > 0 || outcome?.readOutcome === 'opened') return 'results';
  return 'unknown';
}
