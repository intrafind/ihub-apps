// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { makeAdminApiCall } from '../../../api/adminApi';
import { usePlatformConfig } from '../../../shared/contexts/platformConfigContextValue';

/**
 * Status of a users.json record against the required version: `acknowledged`,
 * `outdated` (only older versions) or `never`. Same rule as the server
 * (`aiAcknowledgementService.statusOfUser`).
 *
 * @param {{aiAcknowledgements?: Array<{version: number}>}} user
 * @param {number} requiredVersion
 * @returns {'acknowledged'|'outdated'|'never'}
 */
export function acknowledgementStatus(user, requiredVersion) {
  const entries = Array.isArray(user?.aiAcknowledgements) ? user.aiAcknowledgements : [];
  if (entries.some(entry => entry.version >= requiredVersion)) return 'acknowledged';
  return entries.length > 0 ? 'outdated' : 'never';
}

/** The newest entry of a user, or null. */
export function latestAcknowledgement(user) {
  const entries = Array.isArray(user?.aiAcknowledgements) ? user.aiAcknowledgements : [];
  return entries.reduce((best, e) => (!best || e.version > best.version ? e : best), null);
}

/**
 * The admin actions on AI-use acknowledgements (#3326): request again, remove
 * one user's or everyone's, export CSV. Shared by the users page and, later, the
 * EU AI Act overview page, so both call the same endpoints and show the same
 * confirmations.
 *
 * @param {Object} [options]
 * @param {() => void} [options.onChanged] - Called after an action that changed data
 * @returns {{
 *   settings: {enabled: boolean, enforce: boolean, requiredVersion: number, masterOn: boolean}|null,
 *     `enabled` is what the admin configured; `masterOn` is the EU AI Act master switch,
 *   message: {type: 'success'|'error', text: string}|null,
 *   busy: boolean,
 *   dialogProps: Object|null,
 *   closeDialog: () => void,
 *   askRequestAgain: () => void,
 *   askRemoveOne: (user: Object) => void,
 *   askRemoveAll: (count: number) => void,
 *   exportCsv: (status?: 'acknowledged'|'pending') => Promise<void>,
 *   reload: () => Promise<void>
 * }}
 */
export function useAiAcknowledgementAdmin({ onChanged } = {}) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState(null);
  // The EU AI Act master switch (public platform config, on while unknown). While it is off the
  // acknowledgements stay as they are: only the read-only export is available.
  const platform = usePlatformConfig();
  const masterOn = platform?.platformConfig?.euAiAct?.enabled !== false;
  const settings = loaded ? { ...loaded, masterOn } : null;
  const setSettings = setLoaded;
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dialogProps, setDialogProps] = useState(null);

  const reload = useCallback(async () => {
    try {
      const response = await makeAdminApiCall('/admin/configs/platform');
      const block = response.data?.aiAcknowledgement || {};
      setSettings({
        enabled: block.enabled !== false,
        enforce: block.enforce !== false,
        requiredVersion: Number.isInteger(block.requiredVersion) ? block.requiredVersion : 1
      });
    } catch {
      setSettings(null);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const closeDialog = useCallback(() => setDialogProps(null), []);

  const run = useCallback(
    async (call, successText, failText) => {
      setDialogProps(null);
      setBusy(true);
      try {
        const result = await call();
        setMessage({ type: 'success', text: successText(result) });
        await reload();
        onChanged?.();
      } catch (error) {
        setMessage({
          type: 'error',
          text: `${failText}${error?.message ? `: ${error.message}` : ''}`
        });
      } finally {
        setBusy(false);
      }
    },
    [onChanged, reload]
  );

  const askRequestAgain = useCallback(() => {
    const from = settings?.requiredVersion ?? 1;
    setDialogProps({
      title: t('admin.users.aiAcknowledgement.requestAgainTitle', 'Ask everyone again?'),
      message: t(
        'admin.users.aiAcknowledgement.requestAgainMessage',
        'All users will be asked to confirm again at their next message (version {{from}} -> {{to}}). Existing confirmations are kept as history.',
        { from, to: from + 1 }
      ),
      confirmLabel: t('admin.users.aiAcknowledgement.requestAgainConfirm', 'Ask everyone again'),
      onConfirm: () =>
        run(
          () =>
            makeAdminApiCall('/admin/eu-ai-act/acknowledgements/_request-again', {
              method: 'POST'
            }),
          result =>
            t(
              'admin.users.aiAcknowledgement.requestAgainDone',
              'Version is now {{version}}. Users are asked at their next message.',
              { version: result?.data?.requiredVersion ?? from + 1 }
            ),
          t('admin.users.aiAcknowledgement.requestAgainFailed', 'Could not ask everyone again')
        )
    });
  }, [run, settings, t]);

  const askRemoveOne = useCallback(
    user => {
      const name = user.name || user.username || user.id;
      setDialogProps({
        title: t('admin.users.aiAcknowledgement.removeOneTitle', 'Remove AI confirmation'),
        message: t(
          'admin.users.aiAcknowledgement.removeOneMessage',
          'Remove the AI-use confirmation of {{name}}? They will be asked again at their next message. The audit log keeps the history.',
          { name }
        ),
        confirmLabel: t('admin.users.aiAcknowledgement.removeOneConfirm', 'Remove confirmation'),
        danger: true,
        onConfirm: () =>
          run(
            () =>
              makeAdminApiCall(
                `/admin/eu-ai-act/users/${encodeURIComponent(user.id)}/acknowledgements`,
                { method: 'DELETE' }
              ),
            () => t('admin.users.aiAcknowledgement.removeOneDone', 'Confirmation removed.'),
            t('admin.users.aiAcknowledgement.removeFailed', 'Could not remove the confirmation')
          )
      });
    },
    [run, t]
  );

  const askRemoveAll = useCallback(
    count => {
      setDialogProps({
        title: t('admin.users.aiAcknowledgement.removeAllTitle', 'Remove all AI confirmations?'),
        message: t(
          'admin.users.aiAcknowledgement.removeAllMessage',
          '{{count}} confirmations will be removed and everyone, anonymous visitors included, is asked again at their next message. Export the CSV first if you need the list. The audit log keeps the history.',
          { count }
        ),
        confirmLabel: t('admin.users.aiAcknowledgement.removeAllConfirm', 'Remove all'),
        danger: true,
        onConfirm: () =>
          run(
            () => makeAdminApiCall('/admin/eu-ai-act/acknowledgements', { method: 'DELETE' }),
            () => t('admin.users.aiAcknowledgement.removeAllDone', 'All confirmations removed.'),
            t('admin.users.aiAcknowledgement.removeFailed', 'Could not remove the confirmation')
          )
      });
    },
    [run, t]
  );

  const exportCsv = useCallback(
    async status => {
      setBusy(true);
      try {
        const query = status ? `?status=${encodeURIComponent(status)}` : '';
        const response = await makeAdminApiCall(
          `/admin/eu-ai-act/acknowledgements/_export${query}`,
          {
            responseType: 'blob'
          }
        );
        const blob = new Blob([response.data], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'ai-acknowledgements.csv';
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.URL.revokeObjectURL(url);
      } catch (error) {
        setMessage({
          type: 'error',
          text: `${t('admin.users.aiAcknowledgement.exportFailed', 'Could not export the CSV')}${
            error?.message ? `: ${error.message}` : ''
          }`
        });
      } finally {
        setBusy(false);
      }
    },
    [t]
  );

  return {
    settings,
    message,
    busy,
    dialogProps,
    closeDialog,
    askRequestAgain,
    askRemoveOne,
    askRemoveAll,
    exportCsv,
    reload
  };
}

export default useAiAcknowledgementAdmin;
