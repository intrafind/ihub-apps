import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'ihub_workflow_show_technical';
const STORAGE_EVENT = 'ihub-workflow-show-technical-changed';

function readFromStorage() {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Boolean preference for whether technical workflow details (execution IDs,
 * token counts, model badges, raw JSON dumps, node-type stickers) should be
 * visible. Persisted to localStorage so it sticks across reloads.
 *
 * Multiple components can use this hook simultaneously — when one updates the
 * value, others receive the change via a window CustomEvent so they re-render
 * without prop drilling.
 *
 * @returns {[boolean, (value: boolean) => void]} - Current value and setter.
 */
export function useTechnicalDetailsToggle() {
  const [value, setValue] = useState(readFromStorage);

  useEffect(() => {
    const onChange = event => setValue(event.detail);
    window.addEventListener(STORAGE_EVENT, onChange);
    return () => window.removeEventListener(STORAGE_EVENT, onChange);
  }, []);

  const update = useCallback(next => {
    setValue(next);
    try {
      localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // localStorage can throw in private browsing or with quotas exceeded; ignore.
    }
    window.dispatchEvent(new CustomEvent(STORAGE_EVENT, { detail: next }));
  }, []);

  return [value, update];
}

export default useTechnicalDetailsToggle;
