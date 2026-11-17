// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useMemo, useState } from 'react';
import { makeAdminApiCall } from '../../../api/adminApi';
import { buildSetupSteps, hasOpenSetupSteps } from '../utils/setupChecklist';

/** localStorage key: set when the admin hid the checklist in this browser. */
export const SETUP_CHECKLIST_DISMISS_KEY = 'ihub.admin.setupChecklistDismissed';

function readDismissed() {
  try {
    return localStorage.getItem(SETUP_CHECKLIST_DISMISS_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeDismissed() {
  try {
    localStorage.setItem(SETUP_CHECKLIST_DISMISS_KEY, 'true');
  } catch {
    // Private mode or blocked storage: the checklist simply comes back next time.
  }
}

/**
 * Loads the signals behind the Overview's "Getting started" checklist and decides whether it is
 * shown: while at least one required step is open and the admin has not hidden it. It does not
 * depend on how many apps exist (a real install ships 27, 18 of them enabled).
 *
 * Reads `GET /admin/auth/demo-accounts` and `GET /admin/models/_key-status`; the app count and the
 * sign-in setup come from the Overview's own `GET /admin/overview/stats` answer. A failed read
 * leaves its step open (see `buildSetupSteps`). Nothing is shown until that answer is there: the
 * "Admin account ready" step depends on whether local sign-in is on, so deciding without it would
 * show the checklist and then hide it again, or show a wrong hint when the stats cannot be read.
 *
 * @param {Object} options
 * @param {boolean} [options.enabled=true] - False for content admins, who may not call these.
 * @param {Object|null} [options.overviewStats] - `GET /admin/overview/stats`, or null.
 * @returns {{steps: import('../utils/setupChecklist').SetupStep[]|null, visible: boolean,
 *   dismiss: () => void}} `steps` is null until the signals and the overview stats have loaded.
 */
export function useSetupChecklist({ enabled = true, overviewStats = null } = {}) {
  const [signals, setSignals] = useState(null);
  const [dismissed, setDismissed] = useState(readDismissed);

  useEffect(() => {
    if (!enabled || dismissed) return undefined;
    let cancelled = false;
    const loadSignals = async () => {
      const [demoResult, keyResult] = await Promise.allSettled([
        makeAdminApiCall('/admin/auth/demo-accounts'),
        makeAdminApiCall('/admin/models/_key-status')
      ]);
      if (cancelled) return;
      setSignals({
        demoAccounts: demoResult.status === 'fulfilled' ? (demoResult.value?.data ?? null) : null,
        modelKeyStatuses:
          keyResult.status === 'fulfilled' && Array.isArray(keyResult.value?.data?.items)
            ? keyResult.value.data.items
            : null
      });
    };
    loadSignals().catch(() => {
      // Unknown signals leave their steps open; never claim a state nobody checked.
      if (!cancelled) setSignals({ demoAccounts: null, modelKeyStatuses: null });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, dismissed]);

  const steps = useMemo(
    () => (signals && overviewStats ? buildSetupSteps({ ...signals, overviewStats }) : null),
    [signals, overviewStats]
  );

  const dismiss = useCallback(() => {
    writeDismissed();
    setDismissed(true);
  }, []);

  return {
    steps,
    visible: enabled && !dismissed && hasOpenSetupSteps(steps),
    dismiss
  };
}
