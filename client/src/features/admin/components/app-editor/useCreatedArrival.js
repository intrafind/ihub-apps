// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { hideNextSteps, nextStepsShown, showNextSteps } from './nextSteps';

/** The marker the "New app" page puts into the editor's URL: `?created=1`. */
const CREATED_PARAM = 'created';

/**
 * The editor's part of "Create and test". The create page opens the editor
 * with `?created=1`. Once the app has loaded, the hook reports the arrival to
 * the page (which opens the test chat and says that the app exists), shows the
 * next-steps card, and takes the marker out of the URL, so that a reload or a
 * shared link does not repeat it.
 *
 * The card then stays for this app until the author hides it; that is
 * remembered per app in the browser (`nextSteps.js`).
 *
 * @param {object} options
 * @param {string} options.appId
 * @param {boolean} options.ready - The app has loaded.
 * @param {() => void} options.onArrive - Called once per arrival.
 * @returns {{stepsShown: boolean, focusSteps: boolean, dismissSteps: () => void}}
 *   `focusSteps` is true when the author just arrived: the card's heading then
 *   takes the focus.
 */
export function useCreatedArrival({ appId, ready, onArrive }) {
  const location = useLocation();
  const navigate = useNavigate();
  // What this visit changed for this app; until then storage decides.
  const [steps, setSteps] = useState({ appId: null, shown: false, arrived: false });
  const storedShown = useMemo(() => nextStepsShown(appId), [appId]);
  const mine = steps.appId === appId;

  const created = new URLSearchParams(location.search).get(CREATED_PARAM) === '1';
  // The effect runs once per arrival, with whatever is current at that moment.
  const latestRef = useRef({ location, navigate, onArrive });
  latestRef.current = { location, navigate, onArrive };

  useEffect(() => {
    if (!created || !ready) return;
    const latest = latestRef.current;
    // The URL is outside React: this is the one place it turns into state.
    // eslint-disable-next-line @eslint-react/set-state-in-effect
    setSteps({ appId, shown: showNextSteps(appId), arrived: true });
    latest.onArrive();
    const params = new URLSearchParams(latest.location.search);
    params.delete(CREATED_PARAM);
    const search = params.toString();
    latest.navigate(
      { search: search ? `?${search}` : '', hash: latest.location.hash },
      { replace: true }
    );
  }, [created, ready, appId]);

  const dismissSteps = useCallback(() => {
    hideNextSteps(appId);
    setSteps({ appId, shown: false, arrived: false });
  }, [appId]);

  return {
    stepsShown: mine ? steps.shown : storedShown,
    focusSteps: mine && steps.arrived,
    dismissSteps
  };
}

export default useCreatedArrival;
