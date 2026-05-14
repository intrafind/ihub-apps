import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

function truncate(s, n) {
  if (!s) return '';
  const str = String(s);
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

/**
 * Toolbar that lives between the message list and the chat input in the
 * Outlook taskpane. Lets users attach the currently-open email — and, on
 * Mailbox 1.15+, any emails Ctrl-selected in the message list — to the
 * outgoing prompt without losing them when they navigate between emails.
 */
function PinnedEmailsBar({
  pinned,
  onUnpin,
  onClearAll,
  onPinCurrent,
  onPinSelected,
  canPinCurrent,
  isCurrentPinned,
  isMultiSelectSupported,
  multiSelectLoading
}) {
  const { t } = useTranslation();
  const hasPins = Array.isArray(pinned) && pinned.length > 0;

  // Nothing to do when we can't pin and don't have any pins to show.
  if (!hasPins && !canPinCurrent && !isMultiSelectSupported) return null;

  return (
    <div className="office-pinned-bar border-t border-slate-100 bg-slate-50/70 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        {canPinCurrent && (
          <button
            type="button"
            onClick={onPinCurrent}
            disabled={isCurrentPinned}
            title={
              isCurrentPinned
                ? t('office.pinned.alreadyAdded', 'Already added')
                : t('office.pinned.addCurrentTooltip', 'Attach this email to the chat')
            }
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-slate-700 hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Icon name="paper-clip" size="sm" />
            <span>
              {isCurrentPinned
                ? t('office.pinned.alreadyAdded', 'Already added')
                : t('office.pinned.addCurrent', 'Add this email')}
            </span>
          </button>
        )}

        {isMultiSelectSupported && (
          <button
            type="button"
            onClick={onPinSelected}
            disabled={multiSelectLoading}
            title={t(
              'office.pinned.addSelectedTooltip',
              'Attach every email you have selected in Outlook'
            )}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-slate-700 hover:bg-slate-100 disabled:opacity-50 transition-colors"
          >
            <Icon name="plus-circle" size="sm" />
            <span>
              {multiSelectLoading
                ? t('common.loading', 'Loading…')
                : t('office.pinned.addSelected', 'Add selected emails')}
            </span>
          </button>
        )}

        {hasPins && (
          <button
            type="button"
            onClick={onClearAll}
            title={t('office.pinned.clearAllTooltip', 'Remove every pinned email')}
            className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition-colors"
          >
            <Icon name="trash" size="sm" />
            <span>{t('office.pinned.clearAll', 'Clear')}</span>
          </button>
        )}
      </div>

      {hasPins && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {pinned.map((p, idx) => {
            const key = p.itemId || `pin-${idx}`;
            const label = truncate(p.subject || t('office.pinned.untitled', '(no subject)'), 60);
            return (
              <span
                key={key}
                className="inline-flex items-center gap-1 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-100 px-2 py-0.5"
                title={p.subject || ''}
              >
                <Icon name="paper-clip" size="xs" />
                <span className="max-w-[180px] truncate">{label}</span>
                <button
                  type="button"
                  onClick={() => onUnpin?.(p.itemId)}
                  title={t('office.pinned.removeOne', 'Remove from chat')}
                  className="ml-0.5 rounded-full p-0.5 hover:bg-indigo-100"
                  aria-label={t('office.pinned.removeOne', 'Remove from chat')}
                >
                  <Icon name="x" size="xs" />
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default PinnedEmailsBar;
