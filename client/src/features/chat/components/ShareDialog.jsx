import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import Icon from '../../../shared/components/Icon';
import { getLocalizedContent } from '../../../utils/localizeContent';
import AppLinkSharePanel from '../../apps/components/AppLinkSharePanel';
import ChatSharePanel from './ChatSharePanel';

/** What a link can carry, in the order the dialog offers it. */
const TARGET_ORDER = ['chat', 'app'];

/**
 * The one share dialog of a chat page.
 *
 * It offers what can be shared from here — the conversation itself as a
 * read-only link (`chatShare`), the app as a short link (`appLink`) — and
 * names which of the two a link carries, so a link to the app is never
 * mistaken for a copy of the conversation. With both on offer the choice is
 * a pair of tabs; it opens on the conversation once there is one.
 *
 * @param {Object} props - Component properties.
 * @param {boolean} props.isOpen - Whether the dialog is shown.
 * @param {() => void} props.onClose - Close the dialog.
 * @param {string|Object} [props.appName] - The app's (localized) name.
 * @param {{chatId: string, ready: boolean}|null} [props.chatShare] - Offer the
 *   conversation; `ready` once it is stored and has messages.
 * @param {{appId: string, path: string, params: Object}|null} [props.appLink] -
 *   Offer a short link to the app.
 * @returns {JSX.Element|null}
 */
export default function ShareDialog({
  isOpen,
  onClose,
  appName,
  chatShare = null,
  appLink = null
}) {
  const { t, i18n } = useTranslation();
  const titleRef = useRef(null);
  const tabsRef = useRef({});
  const targets = TARGET_ORDER.filter(key => (key === 'chat' ? chatShare : appLink));
  const [target, setTarget] = useState(() =>
    chatShare && (chatShare.ready || !appLink) ? 'chat' : 'app'
  );
  const name =
    typeof appName === 'object' ? getLocalizedContent(appName, i18n.language) : appName || '';
  const showTabs = targets.length > 1;

  const title = showTabs
    ? t('shareDialog.title', 'Share')
    : targets[0] === 'chat'
      ? t('chatSharing.title', 'Share chat')
      : t('shareDialog.titleApp', 'Share app');

  const targetCopy = {
    chat: {
      icon: 'chat-bubble-left-right',
      label: t('shareDialog.target.chat.label', 'This conversation'),
      hint: t('shareDialog.target.chat.hint', 'A read-only copy of the messages so far')
    },
    app: {
      icon: 'squares-2x2',
      label: t('shareDialog.target.app.label', 'Link to the app'),
      hint: t('shareDialog.target.app.hint', 'Opens the app for a new chat, without your messages')
    }
  };

  // Arrow keys move between the tabs (WAI-ARIA tabs pattern).
  const handleTabKeyDown = event => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = targets[(targets.indexOf(target) + step + targets.length) % targets.length];
    setTarget(next);
    tabsRef.current[next]?.focus();
  };

  const panelProps = key =>
    showTabs
      ? {
          role: 'tabpanel',
          id: `share-panel-${key}`,
          'aria-labelledby': `share-tab-${key}`,
          hidden: target !== key
        }
      : {};

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      maxWidthClassName={chatShare ? 'max-w-2xl' : 'max-w-lg'}
      initialFocusRef={titleRef}
    >
      <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-gray-200 dark:border-gray-700">
        <h2
          ref={titleRef}
          tabIndex={-1}
          className="text-lg font-semibold text-gray-900 dark:text-gray-100 outline-hidden"
        >
          {title}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close', 'Close')}
          className="p-1.5 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 dark:hover:text-gray-200"
        >
          <Icon name="x" size="sm" />
        </button>
      </div>

      {showTabs && (
        <div
          role="tablist"
          aria-label={t('shareDialog.targetLabel', 'What to share')}
          className="grid grid-cols-2 gap-2 px-6 pt-5"
        >
          {targets.map(key => {
            const selected = target === key;
            return (
              <button
                key={key}
                ref={el => {
                  tabsRef.current[key] = el;
                }}
                type="button"
                role="tab"
                id={`share-tab-${key}`}
                aria-selected={selected}
                aria-controls={`share-panel-${key}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => setTarget(key)}
                onKeyDown={handleTabKeyDown}
                className={`flex items-start gap-3 rounded-xl border p-3 text-left transition-colors ${
                  selected
                    ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20'
                    : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                }`}
              >
                <Icon
                  name={targetCopy[key].icon}
                  size="sm"
                  className={`mt-0.5 flex-none ${
                    selected ? 'text-indigo-600 dark:text-indigo-400' : 'text-gray-500'
                  }`}
                />
                <span>
                  <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
                    {targetCopy[key].label}
                  </span>
                  {/* On a phone the panel's own description says the same. */}
                  <span className="hidden sm:block text-xs text-gray-500 dark:text-gray-400">
                    {targetCopy[key].hint}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {chatShare && (
          <div {...panelProps('chat')}>
            {chatShare.ready ? (
              <ChatSharePanel chatId={chatShare.chatId} />
            ) : (
              <p className="text-sm text-gray-600 dark:text-gray-300">
                {t(
                  'shareDialog.chatNotReady',
                  'Send a first message — a conversation can be shared once it has started.'
                )}
              </p>
            )}
          </div>
        )}
        {appLink && (
          <div {...panelProps('app')}>
            <AppLinkSharePanel
              appId={appLink.appId}
              appName={name}
              path={appLink.path}
              params={appLink.params}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}
