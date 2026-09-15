import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ChatHeader from './chat/ChatHeader';
import ChatInput from '../../chat/components/ChatInput';
import OfficeContextStrip from './chat/OfficeContextStrip';
import SettingsDialog from './settings-dialog';
import Icon from '../../../shared/components/Icon';
import useOutlookMailContextSnapshot from '../hooks/useOutlookMailContextSnapshot';
import usePinnedEmails from '../hooks/usePinnedEmails';
import { useOfficeFavoriteApps } from '../utilities/officeFavorites';
import { useOfficeConfig } from '../contexts/OfficeConfigContext';
import { officeLocale } from '../utilities/officeLocale';
import { isOutlookAppointmentMode } from '../utilities/officeCapabilities';
import { buildOfficeStarterPrompts } from '../utilities/officeStarterPrompts';
import {
  OFFICE_START_PAGE_APPS_COUNT,
  pickOfficeDefaultApp,
  rankOfficeAppShortcuts
} from '../utilities/officeStartPage';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { buildStartPageGreeting } from '../../../utils/startPageGreeting';
import { fetchApps } from '../../../api';
import './OfficeChatPanel.css';
import './OfficeStartPage.css';

/** The text links ("Open app", "All apps"). */
const LINK_CLASS = 'office-start-link text-indigo-600 hover:underline dark:text-indigo-400';

/** Same look as the chat panel's starter prompts (OfficeChatPanel.jsx). */
const STARTER_PROMPT_CLASS =
  'office-starter-prompt w-full text-left rounded-lg border border-slate-200 bg-white hover:bg-slate-50 hover:border-slate-300 transition-colors text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:hover:border-slate-600 dark:text-slate-200';

/** An app shortcut row; colours match the compact AppCard the apps list uses. */
const SHORTCUT_CLASS =
  'office-start-shortcut border border-slate-200 bg-white hover:border-slate-300 hover:shadow-xs transition-colors dark:border-slate-700 dark:bg-slate-800 dark:hover:border-slate-600';

/**
 * The task pane's landing view — the Outlook counterpart of the web app's
 * start page (features/apps/pages/StartPage.jsx).
 *
 * Greeting, then the default app's chat input with the open email above it:
 * the user can collect a few emails with the context strip's "Add email(s)",
 * type, and send — the chat opens with that app and the message goes out
 * right away, exactly as if it had been typed inside the app. Under the input
 * sit the app's starter prompts (or the admin's Outlook defaults), and below
 * those a handful of app shortcuts — favorites first, then the admin's
 * default apps — plus a link to the full apps list.
 *
 * Deliberately lean: no model selector, tools menu, uploads or voice input.
 * Those belong to the app once it is open — the pane can be 280 px wide and a
 * few hundred pixels tall, and the start page has to leave room for the input
 * and the shortcuts. Which pieces survive a narrow or a short pane is decided
 * in OfficeStartPage.css.
 *
 * @param {object} props
 * @param {object|null} props.user - The signed-in user, for the greeting.
 * @param {() => void} props.onLogout
 * @param {(app: object) => void} props.onSelectApp - Open an app without a message.
 * @param {(start: object) => void} props.onStartChat - Open the default app and send
 *   `{ app, text, pinnedEmails, hostContextOverride, starterPrompt?, autoSend }`.
 * @param {() => void} props.onBrowseApps - Go to the full apps list.
 */
function OfficeStartPage({ user, onLogout, onSelectApp, onStartChat, onBrowseApps }) {
  const { t } = useTranslation();
  const officeConfig = useOfficeConfig();
  const { favorites } = useOfficeFavoriteApps();
  const mailSnapshot = useOutlookMailContextSnapshot();
  const pinned = usePinnedEmails();

  const [appsState, setAppsState] = useState({ apps: [], loading: true, error: false });
  const [draft, setDraft] = useState('');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  useEffect(() => {
    let mounted = true;
    fetchApps()
      .then(data => {
        if (!mounted) return;
        setAppsState({ apps: Array.isArray(data) ? data : [], loading: false, error: false });
      })
      .catch(() => {
        if (mounted) setAppsState({ apps: [], loading: false, error: true });
      });
    return () => {
      mounted = false;
    };
  }, []);

  const { apps, loading, error } = appsState;

  // Default app: admin-configured via officeIntegration.startPage.defaultAppId
  // when this user may use it, otherwise the top-ranked chat app.
  const defaultApp = useMemo(
    () => pickOfficeDefaultApp(apps, favorites, officeConfig),
    [apps, favorites, officeConfig]
  );

  // The shortcut rows: favorites first, then the admin's default apps, then
  // the rest by `order`. The default app already has the input above, so it
  // does not take one of the few rows as well.
  const shortcuts = useMemo(
    () =>
      rankOfficeAppShortcuts(apps, {
        favoriteAppIds: favorites,
        officeConfig,
        language: officeLocale
      })
        .filter(app => app.id !== defaultApp?.id)
        .slice(0, OFFICE_START_PAGE_APPS_COUNT),
    [apps, favorites, officeConfig, defaultApp?.id]
  );

  // Calendar items get the calendar prompt set. While the snapshot is still
  // loading, a cheap synchronous probe of the live item picks the right set
  // without waiting for the fetch.
  const isAppointment = mailSnapshot.ctx
    ? mailSnapshot.ctx.itemKind === 'appointment'
    : isOutlookAppointmentMode();

  const starterPrompts = useMemo(
    () =>
      buildOfficeStarterPrompts({
        app: defaultApp,
        officeConfig,
        isAppointment,
        language: officeLocale
      }),
    [defaultApp, officeConfig, isAppointment]
  );

  const greeting = useMemo(
    () => buildStartPageGreeting({ user, language: officeLocale, t }),
    [user, t]
  );

  const paneTitle = getLocalizedContent(officeConfig?.displayName, officeLocale) || 'iHub Apps';
  const defaultAppName = getLocalizedContent(defaultApp?.name, officeLocale) || defaultApp?.id;

  // Everything the chat needs to start exactly as the user prepared it here:
  // the emails they collected and the current email as they edited it
  // (attachments dropped, body excluded) — the panel's own snapshot would
  // otherwise start from a clean read and lose those edits.
  const startChat = useCallback(
    (text, extras = {}) => {
      if (!defaultApp) return;
      onStartChat({
        app: defaultApp,
        text,
        pinnedEmails: pinned.pinnedEmails,
        hostContextOverride: mailSnapshot.buildSnapshotOverride(),
        autoSend: true,
        ...extras
      });
    },
    [defaultApp, onStartChat, pinned.pinnedEmails, mailSnapshot]
  );

  const handleSubmit = useCallback(
    e => {
      e?.preventDefault?.();
      const text = draft.trim();
      if (!text && !defaultApp?.allowEmptyContent) return;
      startChat(text);
    },
    [draft, defaultApp, startChat]
  );

  // A default Outlook prompt fires straight away; an app prompt only when it
  // says so — otherwise the chat opens with the text ready to edit.
  const handlePromptSelect = useCallback(
    prompt => {
      startChat(prompt.message, {
        starterPrompt: prompt.raw ?? null,
        autoSend: prompt.autoSend === true
      });
    },
    [startChat]
  );

  const currentItemId = mailSnapshot.ctx?.itemId ?? null;

  const menuItems = [
    {
      key: 'settings',
      label: t('office.menu.settings', 'Settings'),
      onClick: () => setIsSettingsOpen(true)
    },
    { key: 'logout', label: t('office.menu.logout', 'Logout'), onClick: onLogout }
  ];

  const showNoApps = !loading && apps.length === 0;

  return (
    <div className="office-task-pane h-screen w-full flex flex-col p-0 bg-slate-50 dark:bg-slate-900">
      <div className="flex-1 min-h-0 flex flex-col w-full">
        <div className="flex flex-col h-full min-h-0 w-full overflow-hidden bg-white dark:bg-slate-900">
          <ChatHeader title={paneTitle} showCheckmark={false} menuItems={menuItems} />

          <div className="office-start flex-1 min-h-0 overflow-y-auto">
            <div className="office-start-greeting">
              {/* The pane title in the header is the h1; the greeting heads the content. */}
              <h2 className="office-start-title text-slate-900 dark:text-slate-100">{greeting}</h2>
              <p className="office-start-subtitle text-slate-600 dark:text-slate-400">
                {t('startPage.subtitle', 'How can I help you today?')}
              </p>
            </div>

            {/* The default app's input, with the open email (and collected
                emails) above it — the same strip the chat panel shows. */}
            {defaultApp && (
              <section className="office-start-compose" aria-labelledby="office-start-app-name">
                <div className="office-start-app-row">
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span
                      className="office-start-app-badge"
                      style={{ backgroundColor: defaultApp.color || '#4f46e5' }}
                      aria-hidden
                    >
                      <Icon name={defaultApp.icon} size="xs" />
                    </span>
                    <span
                      id="office-start-app-name"
                      className="truncate text-xs font-medium text-slate-600 dark:text-slate-400"
                    >
                      {defaultAppName}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => onSelectApp(defaultApp)}
                    className={LINK_CLASS}
                  >
                    {t('office.startPage.openApp', 'Open app')} →
                  </button>
                </div>

                <OfficeContextStrip
                  ctx={mailSnapshot.ctx}
                  loading={mailSnapshot.loading}
                  visibleAttachments={mailSnapshot.visibleAttachments}
                  removedAttachmentIds={mailSnapshot.removedAttachmentIds}
                  onRemoveAttachment={mailSnapshot.removeAttachment}
                  onRestoreAttachments={mailSnapshot.restoreAttachments}
                  includeBody={mailSnapshot.includeBody}
                  onToggleBody={mailSnapshot.setIncludeBody}
                  pinned={pinned.pinnedEmails}
                  onUnpin={pinned.unpin}
                  onClearPinned={pinned.clearPinned}
                  onAddEmails={pinned.addEmails}
                  canAddEmails={!isAppointment && (!!currentItemId || pinned.multiSelectSupported)}
                  addEmailsLoading={pinned.addEmailsLoading}
                  addEmailsDisabled={
                    !pinned.multiSelectSupported &&
                    !!currentItemId &&
                    pinned.pinnedEmails.some(p => p.itemId === currentItemId)
                  }
                />

                <div className="office-start-input bg-white shrink-0 dark:bg-slate-900">
                  <ChatInput
                    app={defaultApp}
                    value={draft}
                    onChange={e => setDraft(e?.target?.value ?? e)}
                    onSubmit={handleSubmit}
                    isProcessing={false}
                    onCancel={() => {}}
                    allowEmptySubmit={!!defaultApp.allowEmptyContent}
                    currentLanguage={officeLocale}
                    showModelSelector={false}
                    enabledTools={null}
                    maxRows={3}
                  />
                </div>

                {starterPrompts.length > 0 && (
                  <div className="office-start-prompts">
                    {starterPrompts.map(prompt => (
                      <button
                        key={prompt.key}
                        type="button"
                        onClick={() => handlePromptSelect(prompt)}
                        className={STARTER_PROMPT_CLASS}
                      >
                        {prompt.label}
                      </button>
                    ))}
                  </div>
                )}
              </section>
            )}

            {loading && (
              <div
                className="office-start-status flex items-center justify-center gap-2 text-slate-500 dark:text-slate-400"
                role="status"
              >
                <span
                  className="h-4 w-4 rounded-full border-2 border-slate-300 border-t-slate-700 animate-spin dark:border-slate-600 dark:border-t-slate-300"
                  aria-hidden
                />
                {t('pages.appsList.loading', 'Loading…')}
              </div>
            )}

            {showNoApps && (
              <p className="office-start-status text-slate-500 dark:text-slate-400" role="status">
                {error
                  ? t(
                      'startPage.appsUnavailable',
                      'Apps could not be loaded. Please try again later.'
                    )
                  : t('startPage.noApps', 'No apps are available for your account yet.')}
              </p>
            )}

            {/* Jump into an app */}
            {!loading && apps.length > 0 && (
              <section className="office-start-apps" aria-labelledby="office-start-apps-heading">
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <h3
                    id="office-start-apps-heading"
                    className="office-start-heading text-slate-500 dark:text-slate-400"
                  >
                    {t('startPage.jumpIntoApp', 'Jump into an app')}
                  </h3>
                  <button type="button" onClick={onBrowseApps} className={LINK_CLASS}>
                    {t('office.startPage.allApps', 'All apps')} →
                  </button>
                </div>
                {shortcuts.length > 0 && (
                  <ul className="office-start-shortcuts">
                    {shortcuts.map(app => {
                      const name = getLocalizedContent(app.name, officeLocale) || app.id;
                      const description = getLocalizedContent(app.description, officeLocale) || '';
                      return (
                        <li key={app.id}>
                          <button
                            type="button"
                            onClick={() => onSelectApp(app)}
                            className={SHORTCUT_CLASS}
                            title={description || name}
                          >
                            <span
                              className="office-start-shortcut-icon"
                              style={{ backgroundColor: app.color || '#4f46e5' }}
                              aria-hidden
                            >
                              <Icon name={app.icon} size="sm" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="office-start-shortcut-name truncate text-slate-900 dark:text-slate-100">
                                {name}
                              </span>
                              {description && (
                                <span className="office-start-shortcut-desc truncate text-slate-500 dark:text-slate-400">
                                  {description}
                                </span>
                              )}
                            </span>
                            <Icon
                              name="chevron-right"
                              size="sm"
                              className="shrink-0 text-slate-400 dark:text-slate-500"
                              aria-hidden
                            />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            )}
          </div>
        </div>
      </div>

      <SettingsDialog
        user={user}
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
      />
    </div>
  );
}

export default OfficeStartPage;
