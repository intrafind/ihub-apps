// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import Modal from '../../../shared/components/Modal';
import { getLocalizedContent } from '../../../utils/localizeContent';

/** The prefix of the capability ID of a connected system (`integration:<installationId>`). */
const INTEGRATION_PREFIX = 'integration:';

const isIntegration = capability =>
  typeof capability?.id === 'string' && capability.id.startsWith(INTEGRATION_PREFIX);

/** The words for a capability inside a sentence of the notice. */
function capabilityLabel(capability, t, language) {
  if (isIntegration(capability)) {
    // The server sends the name as stored: a text per language, or a string.
    return (
      getLocalizedContent(capability.name, language) ||
      capability.id.slice(INTEGRATION_PREFIX.length)
    );
  }
  switch (capability.id) {
    case 'model':
      return t('userApps.notice.capability.model');
    case 'upload':
      return t('userApps.notice.capability.upload');
    case 'webSearch':
      return t('userApps.notice.capability.webSearch');
    case 'skills':
      return t('userApps.notice.capability.skills');
    default:
      return capability.id;
  }
}

/**
 * The lines of the notice, built from what the server sent with the app.
 * Nothing is inferred here beyond grouping: which capability is granted, and
 * which reason a missing one has, is the server's answer.
 *
 * @param {Object} app - A personal app as `GET /api/apps/{appId}` answers it.
 * @param {(key: string, values?: Object) => string} t
 * @param {string} [language] - The language of the name of a connected system.
 * @returns {{owner: string, mayUse: string[], asksFirst: boolean, asksFirstSystems: boolean,
 *   notForYou: string[], unavailable: string[]}}
 *   `mayUse`: what the app may use for this person; web search and connected
 *   systems carry the note that the person switches them on.
 *   `notForYou`: missing because of this person's own rights (`youMayNot`).
 *   `unavailable`: missing for any other reason; the reason is not told.
 *
 * @example
 * personalAppNoticeLines(
 *   { owner: { name: 'Anna Schmidt' }, approval: { mode: 'always' },
 *     capabilities: [{ id: 'webSearch', granted: true }] },
 *   t
 * ).asksFirst; // → true
 */
export function personalAppNoticeLines(app, t, language) {
  const capabilities = Array.isArray(app?.capabilities) ? app.capabilities : [];
  const asks = app?.approval?.mode === 'always';
  const lines = {
    owner: app?.owner?.name || app?.owner?.id || '',
    mayUse: [],
    asksFirst: false,
    asksFirstSystems: false,
    notForYou: [],
    unavailable: []
  };
  for (const capability of capabilities) {
    if (!capability || typeof capability.id !== 'string') continue;
    const label = capabilityLabel(capability, t, language);
    if (capability.granted === true) {
      // The model is how the app answers, not something it reaches out to.
      if (capability.id === 'model') continue;
      const switchedOnInChat = capability.id === 'webSearch' || isIntegration(capability);
      lines.mayUse.push(switchedOnInChat ? `${label} (${t('userApps.notice.switchOn')})` : label);
      if (asks && capability.id === 'webSearch') lines.asksFirst = true;
      if (asks && isIntegration(capability)) lines.asksFirstSystems = true;
    } else if (capability.reason === 'youMayNot') {
      lines.notForYou.push(label);
    } else {
      lines.unavailable.push(label);
    }
  }
  return lines;
}

/** Whether the notice belongs above the chat: a personal app the caller does not own. */
export const showsPersonalAppNotice = app =>
  app?.ownership === 'user' && app?.permissions?.isOwner !== true;

const collapsedKey = appId => `ihub_personal_app_notice_collapsed:${appId}`;

function readCollapsed(appId) {
  try {
    return window.sessionStorage.getItem(collapsedKey(appId)) === '1';
  } catch {
    return false;
  }
}

function storeCollapsed(appId, collapsed) {
  try {
    if (collapsed) window.sessionStorage.setItem(collapsedKey(appId), '1');
    else window.sessionStorage.removeItem(collapsedKey(appId));
  } catch {
    // Storage is a convenience here; the notice works without it.
  }
}

/**
 * The notice above the chat of a personal app someone else owns: who owns
 * it, that administrators have not checked it, what it may use, that it asks
 * first, and what is missing. "Show instructions" opens the instructions
 * read-only. The notice collapses to one line and cannot be dismissed for
 * good. Renders nothing for an admin app and for the owner.
 *
 * @param {Object} props
 * @param {Object|null} props.app - The app of the chat.
 * @returns {JSX.Element|null}
 */
function PersonalAppNotice({ app }) {
  const { t, i18n } = useTranslation();
  const detailsId = useId();
  const instructionsTitleId = useId();
  const appId = app?.id || '';
  // Collapsing is remembered per app for this tab; a new tab shows the notice again.
  const [collapsedFor, setCollapsedFor] = useState(() => ({
    appId,
    collapsed: readCollapsed(appId)
  }));
  const [showInstructions, setShowInstructions] = useState(false);

  if (!showsPersonalAppNotice(app)) return null;

  const collapsed = collapsedFor.appId === appId ? collapsedFor.collapsed : readCollapsed(appId);
  const setCollapsed = value => {
    storeCollapsed(appId, value);
    setCollapsedFor({ appId, collapsed: value });
  };

  const lines = personalAppNoticeLines(app, t, i18n.language);
  const list = items => items.join(', ');
  const name = getLocalizedContent(app.name, i18n.language) || app.id;
  const instructions = getLocalizedContent(app.system, i18n.language) || '';

  return (
    <aside
      data-testid="personal-app-notice"
      aria-label={t('userApps.notice.collapsed', { owner: lines.owner })}
      className="mx-auto mb-2 w-full max-w-3xl shrink-0 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-gray-900 dark:border-blue-800 dark:bg-gray-800 dark:text-gray-100"
    >
      {collapsed ? (
        <button
          type="button"
          aria-expanded="false"
          aria-controls={detailsId}
          onClick={() => setCollapsed(false)}
          className="flex w-full items-center gap-2 rounded-sm text-left focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          <Icon name="information-circle" size="sm" className="flex-none" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">
            {t('userApps.notice.collapsed', { owner: lines.owner })}
          </span>
          <span className="flex-none text-blue-800 underline dark:text-blue-300">
            {t('userApps.notice.expand')}
          </span>
        </button>
      ) : (
        <div className="flex items-start gap-2">
          <Icon
            name="information-circle"
            size="sm"
            className="mt-0.5 flex-none"
            aria-hidden="true"
          />
          <div id={detailsId} className="min-w-0 flex-1 space-y-0.5">
            <p className="font-medium">{t('userApps.notice.ownedBy', { owner: lines.owner })}</p>
            {lines.mayUse.length > 0 && (
              <p>{t('userApps.notice.mayUse', { list: list(lines.mayUse) })}</p>
            )}
            {lines.asksFirst && <p>{t('userApps.notice.asksFirst')}</p>}
            {lines.asksFirstSystems && <p>{t('userApps.notice.asksFirstSystems')}</p>}
            {lines.notForYou.length > 0 && (
              <p>{t('userApps.notice.notForYou', { list: list(lines.notForYou) })}</p>
            )}
            {lines.unavailable.length > 0 && (
              <p>{t('userApps.notice.unavailable', { list: list(lines.unavailable) })}</p>
            )}
            <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1">
              {instructions && (
                <button
                  type="button"
                  onClick={() => setShowInstructions(true)}
                  className="rounded-sm text-blue-800 underline focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-300"
                >
                  {t('userApps.notice.showInstructions')}
                </button>
              )}
              <button
                type="button"
                aria-expanded="true"
                aria-controls={detailsId}
                onClick={() => setCollapsed(true)}
                className="rounded-sm text-blue-800 underline focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-300"
              >
                {t('userApps.notice.collapse')}
              </button>
            </div>
          </div>
        </div>
      )}

      <Modal
        isOpen={showInstructions}
        onClose={() => setShowInstructions(false)}
        labelledBy={instructionsTitleId}
        maxWidthClassName="max-w-2xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <h2
            id={instructionsTitleId}
            className="text-base font-semibold text-gray-900 dark:text-gray-100"
          >
            {t('userApps.notice.instructionsTitle', { name })}
          </h2>
          <button
            type="button"
            onClick={() => setShowInstructions(false)}
            aria-label={t('common.close')}
            className="rounded-md p-1 text-gray-600 hover:bg-gray-100 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            <Icon name="close" size="md" aria-hidden="true" />
          </button>
        </div>
        {/* A text child: React escapes it, so instructions can never become markup. */}
        <pre
          data-testid="personal-app-instructions"
          tabIndex={0}
          className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words p-4 font-sans text-sm text-gray-800 dark:text-gray-200"
        >
          {instructions}
        </pre>
      </Modal>
    </aside>
  );
}

/**
 * The page shown instead of the chat when the caller may see a personal app
 * but not use it: the owner's shares do not count at the moment, or an
 * administrator switched the app off. The server says which
 * (`permissions.suspended`, `disabled`); this page never says why a share is
 * suspended.
 *
 * @param {Object} props
 * @param {Object} props.app - The reduced body of `GET /api/apps/{appId}`.
 * @returns {JSX.Element}
 */
export function PersonalAppUnavailable({ app }) {
  const { t, i18n } = useTranslation();
  const name = getLocalizedContent(app?.name, i18n.language) || app?.id || '';
  const owner = app?.owner?.name || app?.owner?.id || '';
  const text = app?.disabled
    ? app.disabled.reason
      ? t('userApps.edit.readOnly.disabled', { reason: app.disabled.reason })
      : t('userApps.edit.state.disabled')
    : t('userApps.notice.suspended', { owner });
  return (
    <div
      data-testid="personal-app-unavailable"
      className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center px-4 text-center"
    >
      <h1 className="mb-3 text-xl font-bold text-gray-900 dark:text-gray-100">{name}</h1>
      <p role="status" className="text-gray-700 dark:text-gray-300">
        {text}
      </p>
    </div>
  );
}

export default PersonalAppNotice;
