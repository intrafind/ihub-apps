import { useCallback, useContext, useEffect, useRef, useState } from 'react';
// UNSAFE_NavigationContext is the standard workaround for blocking navigation
// in React Router v6 when using BrowserRouter (which lacks useBlocker support).
// useBlocker only works with data routers (createBrowserRouter).
import { UNSAFE_NavigationContext as NavigationContext } from 'react-router-dom';

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual(a[key], b[key])) return false;
  }
  return true;
}

export function useUnsavedChanges(initialData, currentData) {
  const savedRef = useRef(false);
  const { navigator } = useContext(NavigationContext);
  const pendingNavRef = useRef(null);
  const [blockerState, setBlockerState] = useState('unblocked');

  // Reset saved flag when data changes after a save
  useEffect(() => {
    savedRef.current = false;
  }, [currentData]);

  const isDirty = !savedRef.current && initialData !== null && !deepEqual(initialData, currentData);

  // Live ref so the navigation interceptor reads the current dirty state at
  // call-time. markSaved() typically runs synchronously right before navigate()
  // (e.g. in a save handler), before React re-renders. Reading a ref avoids
  // blocking that programmatic navigation with a stale, closure-captured value.
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;

  const markSaved = useCallback(() => {
    savedRef.current = true;
    isDirtyRef.current = false;
  }, []);

  // Intercept React Router's navigator.push / navigator.replace.
  // This is the recommended BrowserRouter workaround since useBlocker requires
  // a data router. The interceptor stays installed and checks the live dirty
  // ref so a save-then-navigate sequence is never blocked. We restore on
  // cleanup to avoid stacking interceptors.
  useEffect(() => {
    const origPush = navigator.push.bind(navigator);
    const origReplace = navigator.replace.bind(navigator);

    navigator.push = (...args) => {
      if (!isDirtyRef.current) return origPush(...args);
      pendingNavRef.current = { fn: origPush, args };
      setBlockerState('blocked');
      return undefined;
    };

    navigator.replace = (...args) => {
      if (!isDirtyRef.current) return origReplace(...args);
      pendingNavRef.current = { fn: origReplace, args };
      setBlockerState('blocked');
      return undefined;
    };

    return () => {
      navigator.push = origPush;
      navigator.replace = origReplace;
    };
  }, [navigator]);

  // Browser close / reload
  useEffect(() => {
    if (!isDirty) return undefined;
    const handler = e => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  const blocker = {
    state: blockerState,
    proceed: useCallback(() => {
      const pending = pendingNavRef.current;
      pendingNavRef.current = null;
      setBlockerState('unblocked');
      if (pending) pending.fn(...pending.args);
    }, []),
    reset: useCallback(() => {
      pendingNavRef.current = null;
      setBlockerState('unblocked');
    }, [])
  };

  return { isDirty, blocker, markSaved };
}
