// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useState } from 'react';
import {
  adoptInstalledIntegration,
  migrateInstalledIntegration,
  restoreInstalledIntegration
} from '../../../../api/integrationsAdminApi';
import {
  MIGRATION_ACTION,
  defaultBackupOf,
  needsConfirmation,
  outcomeFromError,
  outcomeFromResponse
} from './migrationState';

/**
 * Send one migration action to the admin API.
 *
 * Restore names the default backup explicitly (the one the confirmation
 * dialog showed), so a backup taken in the meantime is not restored instead.
 *
 * @param {string} action - a `MIGRATION_ACTION` value other than Uninstall
 * @param {Object} instance - the installation
 * @returns {Promise<Object>} the response body
 */
function callMigrationApi(action, instance) {
  switch (action) {
    case MIGRATION_ACTION.MIGRATE:
    case MIGRATION_ACTION.RERUN:
      return migrateInstalledIntegration(instance.id);
    case MIGRATION_ACTION.RESTORE:
      return restoreInstalledIntegration(instance.id, defaultBackupOf(instance)?.id);
    case MIGRATION_ACTION.ADOPT:
      return adoptInstalledIntegration(instance.id);
    default:
      return Promise.reject(new Error(`Unknown migration action "${action}"`));
  }
}

/**
 * The migration actions of installations (concept §3/§4): Migrate now,
 * Re-run migration, Restore backup, Adopt current version and Uninstall, with
 * the confirmation the destructive ones need. The installation page and the
 * Installed tab's tiles share it; the components only render the buttons,
 * the dialog and the outcome.
 *
 * - `request(action, instance)` runs Migrate / Re-run at once, opens the
 *   confirmation for Restore and Adopt (`pending`), and hands Uninstall to
 *   `onUninstall` (the page's existing remove flow, which asks itself).
 * - `confirm()` runs the pending action, `cancel()` drops it.
 * - Every run ends in `onDone(outcome)` with `outcomeFromResponse` /
 *   `outcomeFromError` (`migrationState.js`): the caller shows the log entry
 *   or the error reason and reloads.
 *
 * @example
 * const migration = useMigrationActions({ onDone: async outcome => { setOutcome(outcome); await load(); },
 *   onUninstall: () => setConfirm('remove') });
 * <MigrationActionButtons instance={instance} onRequest={migration.request} busy={migration.running === instance.id} />
 *
 * @param {Object} params
 * @param {(outcome: Object) => (void|Promise<void>)} params.onDone
 * @param {(instance: Object) => void} [params.onUninstall]
 * @returns {{ pending: { action: string, instance: Object }|null, running: string|null,
 *   request: (action: string, instance: Object) => void, confirm: () => void, cancel: () => void }}
 */
export default function useMigrationActions({ onDone, onUninstall }) {
  const [pending, setPending] = useState(null);
  // The id of the installation whose action runs, null while none does.
  const [running, setRunning] = useState(null);

  const run = useCallback(
    async (action, instance) => {
      setRunning(instance.id);
      let outcome;
      try {
        outcome = outcomeFromResponse(action, instance, await callMigrationApi(action, instance));
      } catch (error) {
        outcome = outcomeFromError(action, instance, error);
      }
      setRunning(null);
      await onDone?.(outcome);
      return outcome;
    },
    [onDone]
  );

  const request = useCallback(
    (action, instance) => {
      if (action === MIGRATION_ACTION.UNINSTALL) {
        onUninstall?.(instance);
        return;
      }
      if (needsConfirmation(action)) {
        setPending({ action, instance });
        return;
      }
      void run(action, instance);
    },
    [onUninstall, run]
  );

  const confirm = useCallback(() => {
    if (!pending) return;
    setPending(null);
    void run(pending.action, pending.instance);
  }, [pending, run]);

  const cancel = useCallback(() => setPending(null), []);

  return { pending, running, request, confirm, cancel };
}
