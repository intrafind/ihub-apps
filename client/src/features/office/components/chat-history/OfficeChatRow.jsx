import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import { formatOfficeChatTime } from '../../utilities/officeChatHistory';
import { officeLocale } from '../../utilities/officeLocale';
import '../OfficeStartPage.css';
import './OfficeChatHistory.css';

/** Same look as the start page's app shortcuts (OfficeStartPage.jsx). */
const ROW_CLASS =
  'office-start-shortcut border border-slate-200 bg-white hover:border-slate-300 hover:shadow-xs transition-colors dark:border-slate-700 dark:bg-slate-800 dark:hover:border-slate-600';

/**
 * One stored chat, as the start page and the history page list it: the app's
 * tile, the chat's title, the app's name and when the chat last moved.
 *
 * @param {object} props
 * @param {object} props.row - A row from `resolveOfficeChats`.
 * @param {(row: object) => void} props.onOpen - Open the chat in the pane.
 */
function OfficeChatRow({ row, onOpen }) {
  const { t } = useTranslation();
  const title = row.title || t('chatHistory.untitled', 'Untitled chat');
  const time = formatOfficeChatTime(row.chat.lastMessageAt, officeLocale);

  return (
    <button type="button" onClick={() => onOpen(row)} className={ROW_CLASS} title={title}>
      <span
        className="office-start-shortcut-icon"
        style={{ backgroundColor: row.app.color || '#4f46e5' }}
        aria-hidden
      >
        <Icon name={row.app.icon || 'chat-bubble'} size="sm" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="office-start-shortcut-name truncate text-slate-900 dark:text-slate-100">
          {title}
        </span>
        <span className="office-chat-row-meta truncate text-slate-500 dark:text-slate-400">
          {row.appName}
          {time && <> · {time}</>}
        </span>
      </span>
      {row.chat.hasUnseenActivity && (
        <span
          className="office-chat-row-badge shrink-0 bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
          title={t('chatHistory.unseenHint', 'This chat answered while you were away')}
        >
          {t('chatHistory.unseen', 'New')}
        </span>
      )}
    </button>
  );
}

export default OfficeChatRow;
