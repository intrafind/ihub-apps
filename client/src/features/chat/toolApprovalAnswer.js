// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What an approval card's decision becomes (#2945): the outcome the card
 * shows and the `approvalResponse` the next chat message carries.
 *
 * @module features/chat/toolApprovalAnswer
 */

/**
 * @param {Object} answer - from `ApprovalCard`'s `onDecide`
 * @param {string} answer.interactionId
 * @param {'approve'|'reject'} answer.decision
 * @param {'chat'} [answer.grant] - allow the tool for the rest of the chat (approve only)
 * @returns {{outcome: 'approved'|'approvedForChat'|'rejected',
 *   approvalResponse: {interactionId: string, decision: string, grant?: 'chat'}}|null}
 *   null for an answer that is not one
 * @example toolApprovalAnswer({ interactionId: 'a-1', decision: 'approve', grant: 'chat' })
 *   // { outcome: 'approvedForChat', approvalResponse: { interactionId: 'a-1', decision: 'approve', grant: 'chat' } }
 */
export function toolApprovalAnswer(answer) {
  const interactionId = typeof answer?.interactionId === 'string' ? answer.interactionId : '';
  const decision = answer?.decision;
  if (!interactionId || (decision !== 'approve' && decision !== 'reject')) return null;
  const forChat = decision === 'approve' && answer?.grant === 'chat';
  let outcome = 'approved';
  if (decision === 'reject') outcome = 'rejected';
  else if (forChat) outcome = 'approvedForChat';
  return {
    outcome,
    approvalResponse: { interactionId, decision, ...(forChat ? { grant: 'chat' } : {}) }
  };
}
