// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useId, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Badge from '../../../shared/components/Badge';
import Icon from '../../../shared/components/Icon';

/** English fallbacks of the side effect and data flow badges. */
const SIDE_EFFECT_TEXT = {
  read: 'Reads',
  write: 'Writes',
  destructive: 'Deletes or overwrites',
  unknown: 'Effect unknown'
};
const DATA_FLOW_TEXT = { internal: 'Internal', external: 'External' };

/** Badge tone per side effect (the shared Badge's suggested mapping). */
const SIDE_EFFECT_TONE = {
  read: 'info',
  write: 'warning',
  destructive: 'danger',
  unknown: 'neutral'
};

/**
 * The arguments of a call as indented JSON text. Rendered as a text child, so
 * React escapes it: a model-written argument can never become markup.
 *
 * @param {unknown} args
 * @returns {string}
 */
export function formatApprovalArgs(args) {
  if (args === undefined || args === null) return '{}';
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

/**
 * ApprovalCard — a tool call that waits for the user's decision (#2945).
 *
 * Shows, in this order: the tool and its integration, what the call does
 * (read / write / destructive / unknown) and where its data goes (internal /
 * external), the exact arguments it will run with, and — labelled as written
 * by the assistant — any text the model wrote before the call. Nothing is
 * sent until the user chooses Approve, Approve and allow for this chat, or
 * Reject.
 *
 * Keyboard: when the card appears it takes focus (it is a region named by its
 * title), so a keyboard or screen-reader user lands on the decision; Tab moves
 * through the three buttons.
 *
 * @param {Object} props
 * @param {Object} props.approval - `message.toolApproval` (see runToMessage.buildToolApproval)
 * @param {(answer: {interactionId: string, decision: 'approve'|'reject', grant?: 'chat'}) => void} [props.onDecide]
 *   Called with the decision; without it the card is read-only (a surface that cannot answer).
 * @param {boolean} [props.disabled] - Buttons disabled (a turn is still running)
 * @param {boolean} [props.allowChatGrant=true] - Offer "Approve & allow for this chat"
 *   (not for an MCP App view's own call, which has no chat-wide grant)
 * @returns {JSX.Element}
 */
function ApprovalCard({ approval, onDecide = null, disabled = false, allowChatGrant = true }) {
  const { t } = useTranslation();
  const titleId = useId();
  const argsId = useId();
  const regionRef = useRef(null);
  const decided = approval?.decision || null;
  const pending = !decided && approval?.status === 'pending';
  const argsText = useMemo(() => formatApprovalArgs(approval?.args), [approval?.args]);

  // Focus only when the card first asks: a re-render must not steal focus back.
  const focusedForRef = useRef(null);
  const interactionId = approval?.interactionId || null;
  const canAnswer = pending && Boolean(onDecide);
  useEffect(() => {
    if (!canAnswer || !regionRef.current || focusedForRef.current === interactionId) return;
    focusedForRef.current = interactionId;
    regionRef.current.focus({ preventScroll: false });
  }, [canAnswer, interactionId]);

  if (!approval) return null;

  const sideEffect = approval.sideEffect || 'unknown';
  const dataFlow = approval.dataFlow === 'external' ? 'external' : 'internal';
  const toolName = approval.toolName || approval.toolId;
  const integrationName = approval.integration?.name || null;
  const decide = (decision, grant) =>
    onDecide?.({
      interactionId: approval.interactionId,
      decision,
      ...(grant ? { grant } : {})
    });

  const decidedText = {
    approved: t('chat.toolApproval.decided.approved', 'You approved this call.'),
    approvedForChat: t(
      'chat.toolApproval.decided.approvedForChat',
      'You approved this call and allowed this tool for the rest of the chat.'
    ),
    rejected: t('chat.toolApproval.decided.rejected', 'You rejected this call. It was not run.')
  }[decided];

  return (
    <section
      ref={regionRef}
      tabIndex={-1}
      aria-labelledby={titleId}
      data-testid="tool-approval-card"
      className="mt-2 w-full max-w-2xl rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-gray-800 p-4 text-sm text-gray-900 dark:text-gray-100 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 id={titleId} className="flex items-center gap-2 font-semibold">
          <Icon name="shield-check" size="sm" className="text-amber-700 dark:text-amber-300" />
          <span>
            {integrationName
              ? t('chat.toolApproval.titleWithIntegration', '{{integration}} · {{tool}}', {
                  integration: integrationName,
                  tool: toolName
                })
              : toolName}
          </span>
        </h3>
        <div className="flex flex-wrap gap-1">
          <Badge tone={SIDE_EFFECT_TONE[sideEffect] || 'neutral'} shape="rounded">
            {t(
              `chat.toolApproval.sideEffect.${sideEffect}`,
              SIDE_EFFECT_TEXT[sideEffect] || sideEffect
            )}
          </Badge>
          <Badge tone={dataFlow === 'external' ? 'highlight' : 'neutral'} shape="rounded">
            {t(`chat.toolApproval.dataFlow.${dataFlow}`, DATA_FLOW_TEXT[dataFlow])}
          </Badge>
        </div>
      </div>

      <p className="mt-2 text-gray-700 dark:text-gray-300">
        {pending
          ? t(
              'chat.toolApproval.intro',
              'The assistant wants to run this tool with the arguments below. Nothing is sent until you choose.'
            )
          : t('chat.toolApproval.introDecided', 'The assistant asked to run this tool.')}
      </p>

      <h4
        id={argsId}
        className="mt-3 text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400"
      >
        {t('chat.toolApproval.arguments', 'Arguments')}
      </h4>
      <pre
        aria-labelledby={argsId}
        data-testid="tool-approval-args"
        className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-2 font-mono text-xs text-gray-800 dark:text-gray-200"
      >
        {argsText}
      </pre>

      {approval.justification && (
        <div className="mt-3" data-testid="tool-approval-justification">
          <p className="text-xs font-semibold text-gray-600 dark:text-gray-400">
            {t(
              'chat.toolApproval.justification',
              'Written by the assistant (not a verified reason)'
            )}
          </p>
          <p className="mt-1 whitespace-pre-wrap break-words italic text-gray-700 dark:text-gray-300">
            {approval.justification}
          </p>
        </div>
      )}

      {decided ? (
        <p className="mt-3 font-medium" role="status" data-testid="tool-approval-decision">
          {decidedText}
        </p>
      ) : pending && onDecide ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => decide('approve')}
            className="inline-flex items-center rounded-md bg-blue-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-800 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:opacity-50 dark:focus-visible:ring-offset-gray-800"
          >
            {t('chat.toolApproval.approve', 'Approve')}
          </button>
          {allowChatGrant && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => decide('approve', 'chat')}
              className="inline-flex items-center rounded-md border border-blue-700 dark:border-blue-400 px-3 py-1.5 text-sm font-medium text-blue-800 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-gray-700 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:opacity-50 dark:focus-visible:ring-offset-gray-800"
            >
              {t('chat.toolApproval.approveForChat', 'Approve & allow for this chat')}
            </button>
          )}
          <button
            type="button"
            disabled={disabled}
            onClick={() => decide('reject')}
            className="inline-flex items-center rounded-md border border-red-700 dark:border-red-400 px-3 py-1.5 text-sm font-medium text-red-800 dark:text-red-300 hover:bg-red-50 dark:hover:bg-gray-700 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 disabled:opacity-50 dark:focus-visible:ring-offset-gray-800"
          >
            {t('chat.toolApproval.reject', 'Reject')}
          </button>
        </div>
      ) : (
        !pending && (
          <p className="mt-3 text-gray-700 dark:text-gray-300" role="status">
            {approval.status === 'expired'
              ? t('chat.toolApproval.expired', 'This approval expired. The call was not run.')
              : t('chat.toolApproval.closed', 'This approval is closed.')}
          </p>
        )
      )}
    </section>
  );
}

export default ApprovalCard;
