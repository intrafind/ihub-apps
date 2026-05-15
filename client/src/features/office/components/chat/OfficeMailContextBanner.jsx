import { useMemo, useRef, useState } from 'react';
import Icon from '../../../../shared/components/Icon';
import { formatFileSize } from '../../../upload/utils/cloudFileProcessing';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
// Default to compact mode once the banner would otherwise show this many
// attachment rows — at 3+ attachments the full banner can eat 200 px+
// of vertical space, which on a 600 px-tall Outlook task pane pushes the
// chat input off the visible area. Users can still expand on demand.
const COMPACT_DEFAULT_THRESHOLD = 3;

function isImageAttachment(att) {
  if (!att) return false;
  const ct = (att.contentType || '').toLowerCase();
  if (ct.startsWith('image/')) return true;
  const name = (att.name || '').toLowerCase();
  return IMAGE_EXT.test(name);
}

function getAttachmentStatus(att) {
  if (att?.error) return { kind: 'failed', label: att.error };
  if (att?.content) return { kind: 'attached', label: 'Will be sent' };
  return { kind: 'pending', label: 'Loading...' };
}

function shortenBody(text, max = 140) {
  if (!text) return '';
  const cleaned = String(text).replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Banner rendered above the Outlook taskpane chat input. Shows the email
 * body card + each attachment as a removable file card so users can review
 * — and trim — what's about to be sent to the model. Modelled after the
 * Nextcloud "documents queued" banner + `AttachedFilesList` visual language.
 *
 * Empty state (no live mail context, body and attachments both absent)
 * collapses the banner entirely so the chat input sits flush with the
 * message list.
 *
 * Compact mode (issue #1467): when the email has many attachments, the
 * banner auto-collapses to a single summary row to keep the chat input
 * visible on narrow / short Outlook task panes. The user can toggle back
 * to the full view via the chevron button — both states honor the same
 * "Include body" / per-attachment-remove controls so no functionality is
 * lost in compact mode.
 */
function OfficeMailContextBanner({
  ctx,
  loading,
  visibleAttachments,
  removedAttachmentIds,
  onRemoveAttachment,
  onRestoreAttachments,
  includeBody,
  onToggleBody
}) {
  const attachments = useMemo(
    () => (Array.isArray(visibleAttachments) ? visibleAttachments : []),
    [visibleAttachments]
  );
  const remainingAttachments = useMemo(
    () => attachments.filter(a => !removedAttachmentIds?.has(a?.id)),
    [attachments, removedAttachmentIds]
  );
  const removedCount = removedAttachmentIds?.size || 0;

  const hasBody = Boolean(ctx?.bodyText && ctx.bodyText.trim().length > 0);
  const hasAttachments = attachments.length > 0;

  // Default to compact when the email brings in enough attachments that
  // the full banner would dominate the task pane. Tracked per email item
  // (ctx.itemId) — switching emails recomputes the default rather than
  // carrying the previous email's expanded state into a different inbox.
  // The previous-itemId ref lets us clear the manual override during
  // render when the email changes, without bouncing through useEffect
  // (which would trigger an extra render and an eslint set-state warning).
  const itemId = ctx?.itemId ?? null;
  const shouldDefaultCompact = remainingAttachments.length >= COMPACT_DEFAULT_THRESHOLD;
  const [compactOverride, setCompactOverride] = useState(/** @type {boolean|null} */ (null));
  const prevItemIdRef = useRef(itemId);
  if (prevItemIdRef.current !== itemId) {
    prevItemIdRef.current = itemId;
    if (compactOverride !== null) setCompactOverride(null);
  }
  const compact = compactOverride === null ? shouldDefaultCompact : compactOverride;

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

  if (!hasBody && !hasAttachments) {
    return null;
  }

  const subject = (ctx?.subject || '').trim() || 'Current email';
  const bodyPreview = shortenBody(ctx?.bodyText);
  const bodySent = includeBody !== false && hasBody;
  const totalAttachmentSize = remainingAttachments.reduce(
    (sum, a) => sum + (Number(a?.size) || 0),
    0
  );

  // Compact summary: single row showing subject + attachment count + size.
  // Lets the user verify what's queued without the full per-attachment list.
  if (compact) {
    const attachmentSummary =
      remainingAttachments.length === 0
        ? hasAttachments
          ? 'No attachments will be sent'
          : null
        : `${remainingAttachments.length} attachment${
            remainingAttachments.length === 1 ? '' : 's'
          } • ${formatFileSize(totalAttachmentSize)}`;

    return (
      <div className="mx-3 mt-2 mb-1 rounded-lg border border-slate-200 bg-white shadow-sm">
        <button
          type="button"
          onClick={() => setCompactOverride(false)}
          className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-slate-50 transition-colors rounded-lg"
          aria-expanded="false"
          aria-label="Expand email context details"
          title="Show full email context"
        >
          <div className="flex-shrink-0 text-slate-500">
            <Icon name="mail" size="sm" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-slate-900 truncate" title={subject}>
              {subject}
            </div>
            <div className="text-[11px] text-slate-500 truncate">
              {bodySent ? 'Email body' : 'Body excluded'}
              {attachmentSummary ? ` • ${attachmentSummary}` : ''}
            </div>
          </div>
          {removedCount > 0 && (
            <span
              className="flex-shrink-0 text-[11px] text-indigo-600 font-medium"
              title={`${removedCount} attachment${removedCount === 1 ? '' : 's'} removed`}
            >
              −{removedCount}
            </span>
          )}
          <Icon name="chevronDown" size="sm" className="flex-shrink-0 text-slate-400" aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <div className="mx-3 mt-2 mb-1 rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-100">
        <div className="flex items-center gap-2 text-xs font-medium text-slate-700">
          <Icon name="info" size="xs" className="text-slate-400" />
          <span>Context attached to this message</span>
        </div>
        <div className="flex items-center gap-2">
          {removedCount > 0 && (
            <button
              type="button"
              onClick={onRestoreAttachments}
              className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
              title="Restore removed attachments"
            >
              Restore {removedCount}
            </button>
          )}
          <button
            type="button"
            onClick={() => setCompactOverride(true)}
            className="text-slate-400 hover:text-slate-600 transition-colors p-0.5 rounded"
            aria-expanded="true"
            aria-label="Collapse email context details"
            title="Collapse"
          >
            <Icon name="chevronUp" size="sm" />
          </button>
        </div>
      </div>

      {/* Email body card */}
      {hasBody && (
        <div
          className={`flex items-start gap-3 px-3 py-2 ${
            hasAttachments ? 'border-b border-slate-100' : ''
          }`}
        >
          <div className="flex-shrink-0 mt-0.5 text-slate-500">
            <Icon name="mail" size="sm" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-medium text-slate-900 truncate" title={subject}>
                {subject}
              </div>
              <label className="flex items-center gap-1.5 text-xs text-slate-600 select-none cursor-pointer flex-shrink-0">
                <input
                  type="checkbox"
                  checked={bodySent}
                  onChange={e => onToggleBody?.(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                />
                Include body
              </label>
            </div>
            {bodyPreview && (
              <div
                className={`mt-0.5 text-xs ${
                  bodySent ? 'text-slate-500' : 'text-slate-400 italic line-through'
                } line-clamp-2`}
                title={bodyPreview}
              >
                {bodyPreview}
              </div>
            )}
            {!bodySent && (
              <div className="mt-0.5 text-[11px] text-amber-600">Email body will not be sent.</div>
            )}
          </div>
        </div>
      )}

      {/* Attachments list */}
      {hasAttachments && remainingAttachments.length > 0 && (
        <div className="divide-y divide-slate-100">
          {remainingAttachments.map(att => {
            const status = getAttachmentStatus(att);
            const isImage = isImageAttachment(att);
            return (
              <div
                key={att.id || att.name}
                className="flex items-center gap-3 px-3 py-2 hover:bg-slate-50 transition-colors"
              >
                <div className="flex-shrink-0 text-slate-500">
                  <Icon name={isImage ? 'camera' : 'paper-clip'} size="sm" />
                </div>
                <div className="flex-1 min-w-0">
                  <div
                    className="text-sm font-medium text-slate-900 truncate"
                    title={att.name || 'Attachment'}
                  >
                    {att.name || 'Attachment'}
                  </div>
                  <div className="text-[11px] text-slate-500 flex items-center gap-1.5">
                    <span>{formatFileSize(Number(att.size) || 0)}</span>
                    {status.kind === 'failed' && (
                      <>
                        <span aria-hidden>•</span>
                        <span className="text-rose-600" title={status.label}>
                          Failed
                        </span>
                      </>
                    )}
                    {status.kind === 'pending' && (
                      <>
                        <span aria-hidden>•</span>
                        <span className="text-slate-500">{status.label}</span>
                      </>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onRemoveAttachment?.(att.id)}
                  className="flex-shrink-0 text-slate-400 hover:text-rose-600 transition-colors p-1"
                  title="Remove attachment from this message"
                  aria-label={`Remove ${att.name || 'attachment'} from this message`}
                >
                  <Icon name="x" size="sm" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Footer summary */}
      {hasAttachments && (
        <div className="flex items-center justify-between px-3 py-1.5 border-t border-slate-100 bg-slate-50/60 text-[11px] text-slate-500">
          <span>
            {remainingAttachments.length === 0
              ? 'No attachments will be sent'
              : `${remainingAttachments.length} attachment${
                  remainingAttachments.length === 1 ? '' : 's'
                } • ${formatFileSize(totalAttachmentSize)}`}
          </span>
        </div>
      )}
    </div>
  );
}

export default OfficeMailContextBanner;
