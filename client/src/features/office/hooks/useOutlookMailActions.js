import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MAIL_ACTION_ANSWER,
  MAIL_ACTION_ANSWER_ALL,
  MAIL_ACTION_FORWARD,
  MAIL_ACTION_INSERT,
  MAIL_ACTION_NEW,
  MAIL_ACTION_PREFERENCE_EVENT,
  actionsForMode,
  getStoredMailActionPreference,
  readAdminMailActionDefault,
  resolveDefaultMailAction
} from '../utilities/officeMailAction';
import { detectOutlookMode, runOutlookMailAction } from '../utilities/outlookMailActions';

/** Outlook's own iconography: the reply arrow, the forward arrow, a new draft. */
const ACTION_ICONS = {
  [MAIL_ACTION_ANSWER]: 'undo',
  [MAIL_ACTION_ANSWER_ALL]: 'users',
  [MAIL_ACTION_FORWARD]: 'redo',
  [MAIL_ACTION_NEW]: 'pencil',
  [MAIL_ACTION_INSERT]: 'arrow-right'
};

/**
 * The answer actions the Outlook task pane offers for the item it is attached
 * to, the default among them, and the runner behind them (issue #2446).
 *
 * The list is context-dependent because Outlook's API is: read mode gets the
 * `display*Form` openers (reply / reply all / forward / new), compose mode gets
 * the draft writers (insert). The mode is re-read whenever the user selects a
 * different item, and the default follows user override → admin default → the
 * mode's own default.
 *
 * @param {object} params
 * @param {object} [params.officeConfig] - `useOfficeConfig()`, for the admin default
 * @returns {{
 *   mode: 'read'|'compose'|null,
 *   actions: Array<{ id: string, label: string, icon: string }>,
 *   defaultActionId: string|null,
 *   notice: { tone: 'error'|'info', message: string }|null,
 *   dismissNotice: () => void,
 *   runAction: (actionId: string, content: string) => Promise<void>
 * }}
 */
export default function useOutlookMailActions({ officeConfig } = {}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState(() => detectOutlookMode());
  const [userPreference, setUserPreference] = useState(getStoredMailActionPreference);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    const refreshMode = () => setMode(detectOutlookMode());
    const refreshPreference = () => setUserPreference(getStoredMailActionPreference());
    document.addEventListener('ihub:itemchanged', refreshMode);
    document.addEventListener(MAIL_ACTION_PREFERENCE_EVENT, refreshPreference);
    // Office.js may still have been initialising when this hook first ran.
    refreshMode();
    return () => {
      document.removeEventListener('ihub:itemchanged', refreshMode);
      document.removeEventListener(MAIL_ACTION_PREFERENCE_EVENT, refreshPreference);
    };
  }, []);

  const labels = useMemo(
    () => ({
      [MAIL_ACTION_ANSWER]: t('office.mailActions.answer', 'Reply'),
      [MAIL_ACTION_ANSWER_ALL]: t('office.mailActions.answerAll', 'Reply all'),
      [MAIL_ACTION_FORWARD]: t('office.mailActions.forward', 'Forward'),
      [MAIL_ACTION_NEW]: t('office.mailActions.new', 'New email'),
      [MAIL_ACTION_INSERT]: t('office.mailActions.insert', 'Insert into draft')
    }),
    [t]
  );

  const actions = useMemo(
    () =>
      actionsForMode(mode).map(id => ({
        id,
        label: labels[id] || id,
        icon: ACTION_ICONS[id] || 'arrow-right'
      })),
    [mode, labels]
  );

  const defaultActionId = useMemo(
    () =>
      resolveDefaultMailAction({
        mode,
        userPreference,
        adminDefault: readAdminMailActionDefault(officeConfig?.defaultMailAction)
      }),
    [mode, userPreference, officeConfig?.defaultMailAction]
  );

  const runAction = useCallback(
    async (actionId, content) => {
      setNotice(null);
      const result = await runOutlookMailAction(actionId, content, {
        forwardLabels: {
          forwarded: t('office.mailActions.forwardedMessage', 'Forwarded message'),
          from: t('office.mailActions.forwardFrom', 'From'),
          sent: t('office.mailActions.forwardSent', 'Sent'),
          to: t('office.mailActions.forwardTo', 'To'),
          cc: t('office.mailActions.forwardCc', 'Cc'),
          subject: t('office.mailActions.forwardSubject', 'Subject')
        },
        originalAttachedNotice: t(
          'office.mailActions.originalAttached',
          'Outlook add-ins cannot rebuild a forward with its attachments, so the original message is attached instead — nothing is lost.'
        )
      });
      if (result.ok) {
        setNotice(result.notice ? { tone: 'info', message: result.notice.message } : null);
        return;
      }
      setNotice({ tone: 'error', message: result.message });
    },
    [t]
  );

  const dismissNotice = useCallback(() => setNotice(null), []);

  return { mode, actions, defaultActionId, notice, dismissNotice, runAction };
}
