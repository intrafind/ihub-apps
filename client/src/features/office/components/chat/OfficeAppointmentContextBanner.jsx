import { useMemo } from 'react';
import Icon from '../../../../shared/components/Icon';

function shortenBody(text, max = 140) {
  if (!text) return '';
  const cleaned = String(text).replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1).trimEnd()}…`;
}

function formatTimeRange(start, end) {
  if (!start && !end) return '';
  try {
    const s = start ? new Date(start) : null;
    const e = end ? new Date(end) : null;
    const dateFmt = new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    });
    const timeFmt = new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit'
    });
    if (s && e) {
      // If start and end share the same calendar day, render the date once.
      const sameDay = s.toDateString() === e.toDateString();
      if (sameDay) {
        return `${dateFmt.format(s)} · ${timeFmt.format(s)} – ${timeFmt.format(e)}`;
      }
      return `${dateFmt.format(s)} ${timeFmt.format(s)} – ${dateFmt.format(e)} ${timeFmt.format(e)}`;
    }
    if (s) return `${dateFmt.format(s)} · ${timeFmt.format(s)}`;
    if (e) return `Ends ${dateFmt.format(e)} ${timeFmt.format(e)}`;
  } catch {
    /* fall through to ISO */
  }
  return [start, end].filter(Boolean).join(' – ');
}

function formatAttendeeList(list, max = 4) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const names = list.map(a => a?.name || a?.email).filter(Boolean);
  if (names.length === 0) return null;
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} +${names.length - max} more`;
}

/**
 * Calendar-item counterpart to OfficeMailContextBanner. Shows the meeting
 * subject, time window, location, organizer and attendees alongside the
 * meeting body, with an "Include body" toggle that mirrors the email
 * banner so users can opt out of sending the full invite description.
 *
 * Always rendered embedded inside OfficeContextStrip — the strip owns the
 * outer collapse chrome.
 */
function OfficeAppointmentContextBanner({
  ctx,
  loading,
  includeBody,
  onToggleBody,
  embedded = false
}) {
  const subject = (ctx?.subject || '').trim() || 'Calendar event';
  const hasBody = Boolean(ctx?.bodyText && ctx.bodyText.trim().length > 0);
  const timeLine = useMemo(() => formatTimeRange(ctx?.start, ctx?.end), [ctx?.start, ctx?.end]);
  const requiredNames = useMemo(
    () => formatAttendeeList(ctx?.requiredAttendees),
    [ctx?.requiredAttendees]
  );
  const optionalNames = useMemo(
    () => formatAttendeeList(ctx?.optionalAttendees),
    [ctx?.optionalAttendees]
  );

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
        Reading current meeting…
      </div>
    );
  }

  // Suppress entirely when there's nothing to show.
  const hasAnyMeta = Boolean(
    timeLine || ctx?.location || ctx?.organizer || requiredNames || optionalNames
  );
  if (!hasBody && !hasAnyMeta) {
    return null;
  }

  const bodyPreview = shortenBody(ctx?.bodyText);
  const bodySent = includeBody !== false && hasBody;
  const outerClassName = embedded
    ? ''
    : 'mx-3 mt-2 mb-1 rounded-lg border border-slate-200 bg-white shadow-sm';

  return (
    <div className={outerClassName}>
      <div className="flex items-start gap-2 px-3 py-2">
        <div className="flex-shrink-0 mt-0.5 text-slate-500">
          <Icon name="calendar" size="sm" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium text-slate-900 truncate" title={subject}>
              {subject}
            </div>
            {hasBody && (
              <label className="flex items-center gap-1.5 text-xs text-slate-600 select-none cursor-pointer flex-shrink-0">
                <input
                  type="checkbox"
                  checked={bodySent}
                  onChange={e => onToggleBody?.(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                />
                Include body
              </label>
            )}
          </div>

          {timeLine && (
            <div className="mt-0.5 text-[11px] text-slate-500 flex items-center gap-1">
              <Icon name="clock" size="xs" className="flex-shrink-0 text-slate-400" />
              <span className="truncate" title={timeLine}>
                {timeLine}
              </span>
            </div>
          )}
          {ctx?.location && (
            <div className="mt-0.5 text-[11px] text-slate-500 flex items-center gap-1">
              <Icon name="globe" size="xs" className="flex-shrink-0 text-slate-400" />
              <span className="truncate" title={ctx.location}>
                {ctx.location}
              </span>
            </div>
          )}
          {ctx?.organizer && (
            <div className="mt-0.5 text-[11px] text-slate-500 truncate">
              <span className="font-medium text-slate-600">Organizer:</span>{' '}
              {ctx.organizer.name || ctx.organizer.email}
              {ctx?.isOrganizer && (
                <span className="ml-1.5 inline-flex items-center rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700">
                  You
                </span>
              )}
            </div>
          )}
          {requiredNames && (
            <div className="mt-0.5 text-[11px] text-slate-500 truncate" title={requiredNames}>
              <span className="font-medium text-slate-600">Required:</span> {requiredNames}
            </div>
          )}
          {optionalNames && (
            <div className="mt-0.5 text-[11px] text-slate-500 truncate" title={optionalNames}>
              <span className="font-medium text-slate-600">Optional:</span> {optionalNames}
            </div>
          )}

          {bodyPreview && (
            <div
              className={`mt-1 text-xs ${
                bodySent ? 'text-slate-500' : 'text-slate-400 italic line-through'
              } line-clamp-2`}
              title={bodyPreview}
            >
              {bodyPreview}
            </div>
          )}
          {hasBody && !bodySent && (
            <div className="mt-0.5 text-[11px] text-amber-600">
              Meeting description will not be sent.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default OfficeAppointmentContextBanner;
