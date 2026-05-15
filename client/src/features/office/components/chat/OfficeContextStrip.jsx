import { useMemo, useRef, useState } from 'react';
import Icon from '../../../../shared/components/Icon';
import { formatFileSize } from '../../../upload/utils/cloudFileProcessing';
import OfficeMailContextBanner from './OfficeMailContextBanner';
import PinnedEmailsBar from '../PinnedEmailsBar';

// Collapse by default once the strip would otherwise show this many rows
// (visible attachments + pinned emails combined). On a 600 px-tall Outlook
// task pane the full strip can eat 250 px+ of vertical space, pushing the
// chat input off the visible area — see issue #1467.
const AUTO_COLLAPSE_THRESHOLD = 3;

/**
 * Single collapsible strip that hosts the email-context banner (current
 * mail body + attachments) and the pinned-emails toolbar. Replaces the
 * two-component stack the panel used to render directly — one chevron
 * now shows / hides everything so the chat input stays accessible on
 * small Outlook task panes (issue #1467).
 *
 * Renders nothing at all when there's no context to show: no mail body,
 * no attachments, no pinned emails, and no actionable pin buttons. The
 * loading state of the mail snapshot is still surfaced via the banner.
 */
function OfficeContextStrip({
  // Mail snapshot
  ctx,
  loading,
  visibleAttachments,
  removedAttachmentIds,
  onRemoveAttachment,
  onRestoreAttachments,
  includeBody,
  onToggleBody,
  // Pinned-emails toolbar
  pinned,
  onUnpin,
  onClearPinned,
  onPinCurrent,
  onPinSelected,
  canPinCurrent,
  isCurrentPinned,
  isMultiSelectSupported,
  multiSelectLoading
}) {
  const attachments = useMemo(
    () => (Array.isArray(visibleAttachments) ? visibleAttachments : []),
    [visibleAttachments]
  );
  const remainingAttachments = useMemo(
    () => attachments.filter(a => !removedAttachmentIds?.has(a?.id)),
    [attachments, removedAttachmentIds]
  );
  const pinnedList = Array.isArray(pinned) ? pinned : [];

  const hasBody = Boolean(ctx?.bodyText && ctx.bodyText.trim().length > 0);
  const hasAttachments = attachments.length > 0;
  const hasPinned = pinnedList.length > 0;
  const hasPinControls = canPinCurrent || isMultiSelectSupported;

  // Default-collapse threshold counts what the user would actually see
  // once expanded — attachments still in the queue plus pinned emails.
  // We don't count removed attachments because they're not visible anyway.
  const visibleRowCount = remainingAttachments.length + pinnedList.length;
  const shouldDefaultCollapse = visibleRowCount >= AUTO_COLLAPSE_THRESHOLD;

  const [overrideExpanded, setOverrideExpanded] = useState(/** @type {boolean|null} */ (null));
  // Reset the user's expand/collapse override when the underlying email
  // changes, mirroring the pattern used inside the banner before it was
  // hoisted up here. Tracked through a ref so we don't bounce through a
  // useEffect just to clear state during a re-render.
  const itemId = ctx?.itemId ?? null;
  const prevItemIdRef = useRef(itemId);
  if (prevItemIdRef.current !== itemId) {
    prevItemIdRef.current = itemId;
    if (overrideExpanded !== null) setOverrideExpanded(null);
  }
  const expanded = overrideExpanded === null ? !shouldDefaultCollapse : overrideExpanded;

  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="mx-3 mt-2 mb-1 flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600"
      >
        <svg className="animate-spin h-3 w-3 text-slate-400" fill="none" viewBox="0 0 24 24">
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
        Reading current email…
      </div>
    );
  }

  // Nothing to surface: no email context, nothing pinned, no pin buttons.
  // Keep the strip out of the DOM entirely so the chat input flushes up.
  if (!hasBody && !hasAttachments && !hasPinned && !hasPinControls) {
    return null;
  }

  const subject = (ctx?.subject || '').trim() || 'Current email';
  const totalAttachmentSize = remainingAttachments.reduce(
    (sum, a) => sum + (Number(a?.size) || 0),
    0
  );

  // Build the always-visible summary line — same content in collapsed and
  // expanded states so users always see what's queued at a glance.
  const summaryParts = [];
  if (hasBody) {
    summaryParts.push(includeBody !== false ? 'Email body' : 'Body excluded');
  }
  if (hasAttachments) {
    if (remainingAttachments.length === 0) {
      summaryParts.push('no attachments');
    } else {
      summaryParts.push(
        `${remainingAttachments.length} attachment${
          remainingAttachments.length === 1 ? '' : 's'
        } (${formatFileSize(totalAttachmentSize)})`
      );
    }
  }
  if (hasPinned) {
    summaryParts.push(`${pinnedList.length} pinned email${pinnedList.length === 1 ? '' : 's'}`);
  }
  const summaryLine = summaryParts.join(' • ');
  // Hide the header subject when the current email is empty (e.g. only
  // pinned items, or no live context at all) so the row doesn't read
  // "Current email" with no real backing.
  const headerTitle = hasBody || hasAttachments ? subject : 'Email context';

  return (
    <div className="mx-3 mt-2 mb-1 rounded-lg border border-slate-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setOverrideExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-slate-50 transition-colors rounded-t-lg"
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse email context' : 'Expand email context'}
        title={expanded ? 'Collapse email context' : 'Expand email context'}
      >
        <Icon name="mail" size="sm" className="flex-shrink-0 text-slate-500" />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-slate-900 truncate" title={headerTitle}>
            {headerTitle}
          </div>
          {summaryLine && <div className="text-[11px] text-slate-500 truncate">{summaryLine}</div>}
        </div>
        <Icon
          name={expanded ? 'chevronUp' : 'chevronDown'}
          size="sm"
          className="flex-shrink-0 text-slate-400"
          aria-hidden
        />
      </button>

      {expanded && (
        <div className="border-t border-slate-100">
          {(hasBody || hasAttachments) && (
            <OfficeMailContextBanner
              ctx={ctx}
              loading={false}
              visibleAttachments={visibleAttachments}
              removedAttachmentIds={removedAttachmentIds}
              onRemoveAttachment={onRemoveAttachment}
              onRestoreAttachments={onRestoreAttachments}
              includeBody={includeBody}
              onToggleBody={onToggleBody}
              embedded
            />
          )}

          {(hasPinned || hasPinControls) && (
            <PinnedEmailsBar
              pinned={pinnedList}
              onUnpin={onUnpin}
              onClearAll={onClearPinned}
              onPinCurrent={onPinCurrent}
              onPinSelected={onPinSelected}
              canPinCurrent={canPinCurrent}
              isCurrentPinned={isCurrentPinned}
              isMultiSelectSupported={isMultiSelectSupported}
              multiSelectLoading={multiSelectLoading}
              embedded
            />
          )}
        </div>
      )}
    </div>
  );
}

export default OfficeContextStrip;
