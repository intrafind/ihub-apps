/**
 * Compact banner rendered above the chat input in the Outlook taskpane
 * (and any other host that surfaces mail attachments).
 *
 * For every attachment that flowed in from the host we show one of:
 *   ✅  attached      — will be sent with the next message
 *   ⚠️  unsupported   — skipped on purpose (e.g. .eml, .zip)
 *   ❌  failed        — the host returned an error or processing threw
 *
 * Image attachments still flow through `buildImageDataFromMailAttachments`
 * unchanged; they appear here as "attached" so the user has a single place
 * to confirm what's going out.
 */

function getStatusIcon(status) {
  if (status === 'attached') return '✓';
  if (status === 'unsupported') return '⚠';
  return '✕';
}

function getStatusClasses(status) {
  if (status === 'attached') return 'text-emerald-700 bg-emerald-50 border-emerald-200';
  if (status === 'unsupported') return 'text-amber-700 bg-amber-50 border-amber-200';
  return 'text-rose-700 bg-rose-50 border-rose-200';
}

function MailAttachmentStatusBanner({ statuses, apiUnavailable }) {
  if (!statuses?.length && !apiUnavailable) return null;

  return (
    <div className="px-3 py-2 border-t border-slate-100 bg-slate-50/60">
      {apiUnavailable && (
        <div className="mb-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          Attachment content requires Outlook Mailbox API 1.8 or newer. Attachments cannot be
          included in this host.
        </div>
      )}
      {statuses?.length > 0 && (
        <ul className="flex flex-col gap-1">
          {statuses.map(s => (
            <li
              key={`${s.name || 'attachment'}|${s.contentType || ''}|${s.size ?? ''}|${s.status}`}
              className={`flex items-center gap-2 text-xs rounded border px-2 py-1 ${getStatusClasses(s.status)}`}
              title={s.message || ''}
            >
              <span aria-hidden="true" className="font-bold">
                {getStatusIcon(s.status)}
              </span>
              <span className="font-medium truncate flex-1">{s.name || 'Attachment'}</span>
              {s.status !== 'attached' && s.message ? (
                <span className="ml-1 opacity-80 truncate">{s.message}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default MailAttachmentStatusBanner;
