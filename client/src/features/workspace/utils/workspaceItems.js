// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { resolveCitations } from '../../../../../shared/sources/index.js';
import { attachmentIdsOf } from '../../chat/messageAttachments/attachmentViews';

/**
 * What the workspace pane lists, read from the conversation.
 *
 * @module features/workspace/utils/workspaceItems
 */

/**
 * Which answer of the conversation produced each artifact, and which finished
 * answers produced any.
 *
 * Keyed by `runId`: a stored descriptor carries the run that made it, and so
 * does every answer, live or reloaded. Artifact ids a stored message names are
 * kept as a fallback for a descriptor without a run.
 *
 * @param {Object[]} messages
 * @returns {{ byRun: Map<string, number>, byId: Map<string, number>, producedRuns: string[],
 *   messageIdOf: Map<number, string> }}
 */
export function answerIndex(messages) {
  const byRun = new Map();
  const byId = new Map();
  const messageIdOf = new Map();
  const producedRuns = [];
  let answer = 0;
  for (const message of messages || []) {
    if (message?.role !== 'assistant' || message.isGreeting) continue;
    answer += 1;
    if (message.id) messageIdOf.set(answer, message.id);
    if (message.runId && !byRun.has(message.runId)) byRun.set(message.runId, answer);
    for (const artifact of [...(message.artifacts || []), ...(message.generatedFiles || [])]) {
      if (artifact?.id && !byId.has(artifact.id)) byId.set(artifact.id, answer);
    }
    const produced =
      message.artifacts?.length > 0 ||
      message.generatedFiles?.length > 0 ||
      message.images?.length > 0;
    if (produced && message.runId && !message.loading) producedRuns.push(message.runId);
  }
  return { byRun, byId, producedRuns, messageIdOf };
}

/**
 * Ids of the files the questions of a conversation name: when this changes,
 * the list of uploaded files is read again.
 *
 * @param {Object[]} messages
 * @returns {string}
 */
export function uploadedKeyOf(messages) {
  const ids = [];
  for (const message of messages || []) {
    if (message?.role !== 'user') continue;
    ids.push(...attachmentIdsOf(message));
  }
  return ids.join(',');
}

/**
 * The sources the answers cite, once each (the first answer that cites a
 * source numbers it), with the passages of every citing answer merged.
 * Answers still streaming are left out: their citations are not final.
 *
 * @param {Object[]} messages
 * @returns {Array<{ source: Object, answer: number, messageId: string|null }>}
 */
export function collectCitedSources(messages) {
  const out = [];
  const byId = new Map();
  let answer = 0;
  for (const message of messages || []) {
    if (message?.role !== 'assistant' || message.isGreeting) continue;
    answer += 1;
    if (!message.sources || message.loading) continue;
    let cited = [];
    try {
      cited =
        resolveCitations(
          typeof message.content === 'string' ? message.content : '',
          message.sources
        )?.cited || [];
    } catch {
      cited = [];
    }
    for (const source of cited) {
      if (!source?.id) continue;
      if (byId.has(source.id)) continue;
      const entry = { source, answer, messageId: message.id || null };
      byId.set(source.id, entry);
      out.push(entry);
    }
  }
  return out;
}

/**
 * Scroll the chat to one message and highlight it for a moment ("Answer 3"
 * in the Files index). No highlight under reduced motion: the scroll is enough.
 *
 * @param {string|null} messageId
 * @returns {boolean} Whether the message was found.
 */
export function revealMessage(messageId) {
  if (!messageId || typeof document === 'undefined') return false;
  const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(messageId) : messageId;
  // The chat mounts a phone and a desktop copy of the transcript, one of them
  // hidden by CSS: only the one on screen can scroll and show the highlight.
  const element = Array.from(document.querySelectorAll(`[data-message-id="${escaped}"]`)).find(
    candidate => candidate.offsetParent !== null
  );
  if (!element) return false;
  element.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!reduced) {
    element.classList.add('bg-indigo-50', 'dark:bg-indigo-900/30');
    setTimeout(() => element.classList.remove('bg-indigo-50', 'dark:bg-indigo-900/30'), 1600);
  }
  return true;
}
