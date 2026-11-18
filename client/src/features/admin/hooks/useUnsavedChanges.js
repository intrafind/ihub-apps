// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useContext, useEffect, useRef, useState } from 'react';
// The app renders a declarative <BrowserRouter> (client/src/App.jsx), not a data
// router, so React Router's useBlocker is not available. UNSAFE_NavigationContext
// exposes the history object the router navigates with; patching its push /
// replace / go is the standard way to block in-app navigation in that mode.
// Browser Back/Forward (POP) never goes through the navigator, so it is handled
// with a `popstate` listener registered before the router's (see
// installUnsavedChangesPopGate).
import { UNSAFE_NavigationContext as NavigationContext, parsePath } from 'react-router-dom';

/**
 * Structural equality used for the dirty check (plain objects, arrays, Sets of
 * primitives, primitives).
 *
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set && b instanceof Set) || a.size !== b.size) return false;
    for (const item of a) if (!b.has(item)) return false;
    return true;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.hasOwn(b, key)) return false;
    if (!deepEqual(a[key], b[key])) return false;
  }
  return true;
}

/**
 * One registry per router navigator. Every mounted guard registers here; the
 * registry installs exactly one set of interceptors (push / replace / go and a
 * popstate listener) while at least one guard is mounted and restores the
 * navigator's original methods when the last guard unmounts. This keeps nested
 * or duplicate guards (a page plus a section, two sections of one settings page)
 * from stacking interceptors or prompting twice.
 *
 * @type {WeakMap<object, object>}
 */
const registries = new WeakMap();

/** Strip a trailing slash so `/admin/ui` and `/admin/ui/` count as the same page. */
function normalizePathname(pathname) {
  if (!pathname || pathname === '/') return pathname || '/';
  return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

/**
 * Reads the pathname a push/replace targets. React Router passes either a
 * resolved Path object or a string; a string that is only `?query` / `#hash`
 * has no pathname and therefore stays on the current page.
 *
 * @param {string|{pathname?: string}} to
 * @returns {string|undefined}
 */
function targetPathname(to) {
  if (to == null) return undefined;
  const path = typeof to === 'string' ? parsePath(to) : to;
  return path.pathname;
}

/** The browser's current pathname (basename included), normalised; undefined outside a browser. */
function readWindowPathname() {
  if (typeof window === 'undefined' || !window.location) return undefined;
  return normalizePathname(window.location.pathname);
}

/** The history index React Router stores in `history.state.idx`, or null. */
function readHistoryIndex() {
  if (typeof window === 'undefined') return null;
  const idx = window.history?.state?.idx;
  return typeof idx === 'number' ? idx : null;
}

/**
 * The registry handler that currently decides about Back/Forward, or null.
 * One `popstate` listener (the gate) delegates to it.
 */
let activePopHandler = null;
let popGateInstalled = false;

/**
 * Adds the one `popstate` listener the guards use. The client entry
 * (`client/src/index.jsx`) calls it before the app renders, so it is registered
 * before the router's listener and the guard runs first. When it was added later
 * (on the first guard's mount), it was observed to run after the router in
 * Chromium: Forward was not blocked. Guards call it too, as a fallback for
 * renders without the client entry (tests, embeds).
 */
export function installUnsavedChangesPopGate() {
  if (popGateInstalled || typeof window === 'undefined') return;
  popGateInstalled = true;
  window.addEventListener(
    'popstate',
    event => {
      if (activePopHandler) activePopHandler(event);
    },
    true
  );
}

function getRegistry(navigator) {
  let registry = registries.get(navigator);
  if (!registry) {
    registry = {
      navigator,
      guards: [],
      originals: null,
      onPopState: null,
      // Index of the history entry the app is currently showing; used to work out
      // how far a Back/Forward jumped so it can be undone.
      currentIdx: null,
      // Pathname of that entry: a Back/Forward that stays on it (only the query
      // or hash differs) is not leaving the page and passes.
      currentPathname: undefined,
      // Set while we undo a blocked POP: the popstate our own history.go() causes
      // must not reach the router either.
      swallowNextPop: false,
      // Set by proceed() for a pending go/POP: the next popstate (to this index,
      // when known) passes through even though the page is still dirty.
      allowPop: null,
      // Router pathname of each history entry seen while the interceptors were
      // installed, by history index. Lets a navigate(-n) back to an entry of the
      // same page (a closed artifact pane, a pushed tab) through.
      entryPathnames: new Map(),
      // A held POP whose "Discard changes" arrived before the restoring popstate.
      afterRestore: null
    };
    registries.set(navigator, registry);
  }
  return registry;
}

/** The first mounted guard that is dirty right now (live ref, not render state). */
function firstDirtyGuard(registry) {
  return registry.guards.find(guard => guard.isDirtyRef.current) || null;
}

/**
 * Installs the shared interceptors on a navigator. Called when the first guard
 * registers; `uninstallGuardRegistry` undoes it when the last one leaves.
 *
 * @param {object} registry
 */
function installGuardRegistry(registry) {
  const { navigator } = registry;
  const originals = {
    push: navigator.push,
    replace: navigator.replace,
    go: navigator.go
  };
  registry.originals = originals;
  const callOriginal = (name, args) => originals[name].apply(navigator, args);
  const currentPathname = () => {
    const pathname = navigator.location?.pathname;
    return pathname === undefined ? undefined : normalizePathname(pathname);
  };

  /**
   * Records the history entry the app shows now (after a navigation passed).
   *
   * @param {boolean} [discardForward=false] - A push: the browser dropped every
   *   entry after the new one, so their recorded pathnames are dropped too.
   */
  const recordCurrentEntry = (discardForward = false) => {
    registry.currentIdx = readHistoryIndex();
    registry.currentPathname = readWindowPathname();
    const idx = registry.currentIdx;
    if (idx === null) return;
    if (discardForward) {
      for (const known of [...registry.entryPathnames.keys()]) {
        if (known > idx) registry.entryPathnames.delete(known);
      }
    }
    const pathname = currentPathname();
    if (pathname === undefined) registry.entryPathnames.delete(idx);
    else registry.entryPathnames.set(idx, pathname);
  };
  registry.recordCurrentEntry = recordCurrentEntry;
  registry.entryPathnames.clear();
  recordCurrentEntry();

  /**
   * Wraps push/replace: navigation to another pathname is blocked while a guard
   * is dirty; a change of only the query string or hash on the same pathname
   * (tabs, filters on one page) always passes.
   */
  const wrapPushOrReplace = name =>
    function guardedNavigation(...args) {
      const guard = firstDirtyGuard(registry);
      if (guard) {
        const target = targetPathname(args[0]);
        const current = currentPathname();
        const samePage =
          current !== undefined &&
          (target === undefined || target === '' || normalizePathname(target) === current);
        if (!samePage) {
          guard.block({ kind: name, args });
          return undefined;
        }
      }
      const result = callOriginal(name, args);
      recordCurrentEntry(name === 'push');
      return result;
    };

  /**
   * Whether `go(delta)` lands on a history entry recorded for the pathname the
   * app shows now (e.g. closing an artifact pane that was opened with
   * `?pane=…`). Unknown entries count as another page.
   *
   * @param {number} delta
   * @returns {boolean}
   */
  const isSamePageJump = delta => {
    const fromIdx = registry.currentIdx;
    const current = currentPathname();
    if (delta === 0 || fromIdx === null || current === undefined) return false;
    return registry.entryPathnames.get(fromIdx + delta) === current;
  };

  navigator.push = wrapPushOrReplace('push');
  navigator.replace = wrapPushOrReplace('replace');
  if (typeof originals.go === 'function') {
    navigator.go = function guardedGo(...args) {
      const guard = firstDirtyGuard(registry);
      if (guard && !isSamePageJump(Number(args[0]) || 0)) {
        // A jump to an entry this page did not record, or to another page, is
        // treated as leaving the page.
        guard.block({ kind: 'go', args });
        return undefined;
      }
      return callOriginal('go', args);
    };
  }

  if (typeof window !== 'undefined') {
    registry.onPopState = event => {
      if (registry.swallowNextPop) {
        // The popstate caused by undoing a blocked Back/Forward.
        registry.swallowNextPop = false;
        event.stopImmediatePropagation();
        // "Discard changes" was chosen before the browser finished putting the
        // page's entry back: run that held move now.
        const afterRestore = registry.afterRestore;
        registry.afterRestore = null;
        if (afterRestore) afterRestore();
        return;
      }
      const nextIdx = readHistoryIndex();
      const allow = registry.allowPop;
      registry.allowPop = null;
      if (allow && (allow.idx === null || allow.idx === nextIdx)) {
        recordCurrentEntry();
        return;
      }
      try {
        const guard = firstDirtyGuard(registry);
        const fromIdx = registry.currentIdx;
        const fromPathname = registry.currentPathname;
        const samePage = fromPathname !== undefined && readWindowPathname() === fromPathname;
        if (!guard || fromIdx === null || nextIdx === null || nextIdx === fromIdx || samePage) {
          // Not dirty; or we cannot tell how far the browser jumped (an entry the
          // router did not create); or the jump stays on this page (only the
          // query or hash differs, like a pushed tab): let the router handle it.
          recordCurrentEntry();
          return;
        }
        const delta = nextIdx - fromIdx;
        // Keep the router from seeing this POP, put the previous entry back and
        // ask the user. The gate's listener was registered before the router's,
        // so stopping here keeps the router from rendering the other page.
        event.stopImmediatePropagation();
        registry.swallowNextPop = true;
        window.history.go(-delta);
        guard.block({ kind: 'pop', delta, idx: nextIdx });
      } catch {
        // If anything about POP handling fails, fall back to letting the user
        // navigate rather than trapping them on the page.
        registry.swallowNextPop = false;
        recordCurrentEntry();
      }
    };
    // Runs through the gate, which is registered before React Router's listener.
    installUnsavedChangesPopGate();
    activePopHandler = registry.onPopState;
  }
}

/**
 * Restores the navigator's original methods and removes the popstate listener.
 *
 * @param {object} registry
 */
function uninstallGuardRegistry(registry) {
  const { navigator, originals } = registry;
  if (originals) {
    navigator.push = originals.push;
    navigator.replace = originals.replace;
    if (typeof originals.go === 'function') navigator.go = originals.go;
  }
  if (registry.onPopState && activePopHandler === registry.onPopState) {
    activePopHandler = null;
  }
  registry.originals = null;
  registry.onPopState = null;
  registry.recordCurrentEntry = null;
  registry.entryPathnames.clear();
  registry.swallowNextPop = false;
  registry.allowPop = null;
  registry.afterRestore = null;
  registries.delete(navigator);
}

/**
 * Runs a navigation that a guard blocked, bypassing every guard for exactly that
 * one transition.
 *
 * @param {object} navigator - The router navigator.
 * @param {{kind: 'push'|'replace'|'go'|'pop', args?: Array, delta?: number, idx?: number}} pending
 */
function runPendingNavigation(navigator, pending) {
  const registry = registries.get(navigator);
  // Without a registry (every guard unmounted meanwhile) the navigator already
  // has its original methods again.
  const fns = registry?.originals || {
    push: navigator.push,
    replace: navigator.replace,
    go: navigator.go
  };
  if (pending.kind === 'push' || pending.kind === 'replace') {
    fns[pending.kind].apply(navigator, pending.args);
    registry?.recordCurrentEntry?.();
    return;
  }
  if (pending.kind === 'go') {
    if (registry) {
      const delta = Number(pending.args[0]) || 0;
      const from = registry.currentIdx;
      registry.allowPop = { idx: from === null ? null : from + delta };
    }
    fns.go.apply(navigator, pending.args);
    return;
  }
  if (pending.kind === 'pop') {
    const replay = () => {
      if (registry) registry.allowPop = { idx: pending.idx ?? null };
      window.history.go(pending.delta);
    };
    if (registry?.swallowNextPop) {
      registry.afterRestore = replay;
    } else {
      replay();
    }
  }
}

/**
 * Guards an admin editor against losing unsaved changes.
 *
 * Compares the loaded value (`initialData`) with the value being edited
 * (`currentData`). While they differ the page is "dirty", and then:
 * - an in-app navigation to another page (link, breadcrumb, sidebar,
 *   `navigate(path)`, `navigate(path, { replace: true })`, `navigate(-1)`) is
 *   held and `blocker.state` becomes `'blocked'`, so the page can show the
 *   leave dialog (`UnsavedChangesDialog`);
 * - browser Back/Forward is undone and held the same way;
 * - a change of only the query string or hash on the same page (tabs, filters)
 *   is never held, nor is a `navigate(-n)` or Back back to such an entry (closing
 *   an artifact pane opened with `?pane=…`);
 * - reload / close tab shows the browser's own `beforeunload` prompt.
 *
 * Pass `null` as `initialData` while the page is loading or after its load
 * failed: the page is then never dirty. Use the normalised loaded value as the
 * baseline so a just-loaded page is not dirty.
 *
 * Several guards on one page share one set of interceptors and produce one
 * prompt; "Discard changes" in that prompt leaves the page for all of them.
 *
 * @param {*} initialData - The loaded (saved) value, or null while not loaded.
 * @param {*} currentData - The value being edited.
 * @returns {{
 *   isDirty: boolean,
 *   blocker: { state: 'blocked'|'unblocked', proceed: () => void, reset: () => void },
 *   markSaved: () => void
 * }} `markSaved()` clears the dirty flag synchronously so a navigate() right after
 *   a successful save is not blocked.
 *
 * @example
 * const { isDirty, blocker, markSaved } = useUnsavedChanges(savedConfig, config);
 * // ...
 * <UnsavedChangesDialog blocker={blocker} />
 */
/**
 * A callback that marks every unsaved-changes guard under this router as saved,
 * for an action that has already asked the admin to drop their edits and now
 * leaves the page itself (a full reload): without it the browser's own
 * "Leave site?" prompt would ask a second time.
 *
 * @returns {() => void}
 */
export function useDiscardUnsavedChanges() {
  const navigator = useContext(NavigationContext)?.navigator;
  return useCallback(() => {
    const registry = navigator && registries.get(navigator);
    if (registry) registry.guards.forEach(guard => guard.markSaved?.());
  }, [navigator]);
}

export function useUnsavedChanges(initialData, currentData) {
  // markSaved() records the value that was saved. The page counts as clean while
  // the edited value still equals it, and turns dirty on the very next edit: the
  // comparison happens during render, so no effect has to clear a flag first
  // (an effect would run after that render and leave the first edit unguarded).
  const savedRef = useRef({ saved: false, value: undefined });
  const currentDataRef = useRef(currentData);
  currentDataRef.current = currentData;
  // Outside a router (an editor rendered on its own, e.g. in a test) there is no
  // navigation to block; the beforeunload prompt still works.
  const navigator = useContext(NavigationContext)?.navigator;
  const pendingNavRef = useRef(null);
  const [blockerState, setBlockerState] = useState('unblocked');

  const isDirty =
    initialData !== null &&
    !deepEqual(initialData, currentData) &&
    !(savedRef.current.saved && deepEqual(savedRef.current.value, currentData));

  // Live ref so the navigation interceptor reads the current dirty state at
  // call-time. markSaved() typically runs synchronously right before navigate()
  // (e.g. in a save handler), before React re-renders. Reading a ref avoids
  // blocking that programmatic navigation with a stale, closure-captured value.
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;

  const markSaved = useCallback(() => {
    savedRef.current = { saved: true, value: currentDataRef.current };
    isDirtyRef.current = false;
  }, []);

  // Register with the navigator's shared registry. The first guard installs the
  // interceptors, the last one to unmount restores the navigator.
  useEffect(() => {
    if (!navigator) return undefined;
    const registry = getRegistry(navigator);
    const guard = {
      isDirtyRef,
      block: pending => {
        pendingNavRef.current = pending;
        setBlockerState('blocked');
      }
    };
    guard.markSaved = markSaved;
    registry.guards.push(guard);
    if (registry.guards.length === 1) installGuardRegistry(registry);
    return () => {
      registry.guards = registry.guards.filter(g => g !== guard);
      if (registry.guards.length === 0) uninstallGuardRegistry(registry);
    };
  }, [navigator, markSaved]);

  // Browser close / reload. The handler reads the live ref, so a Discard that
  // cleared the dirty flag (see proceed) silences it before React re-renders.
  useEffect(() => {
    if (!isDirty) return undefined;
    const handler = e => {
      if (!isDirtyRef.current) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  const proceed = useCallback(() => {
    const pending = pendingNavRef.current;
    pendingNavRef.current = null;
    setBlockerState('unblocked');
    if (!pending || !navigator) return;
    if (pending.kind === 'go' || pending.kind === 'pop') {
      // A history jump may leave the document (an entry from before the app
      // loaded). The admin already chose to drop the edits, so clear every
      // guard's dirty flag first: otherwise the browser's own "Leave site?"
      // prompt would ask a second time.
      const registry = registries.get(navigator);
      if (registry) registry.guards.forEach(guard => guard.markSaved?.());
      else markSaved();
    }
    runPendingNavigation(navigator, pending);
  }, [navigator, markSaved]);

  const reset = useCallback(() => {
    pendingNavRef.current = null;
    setBlockerState('unblocked');
  }, []);

  const blocker = { state: blockerState, proceed, reset };

  return { isDirty, blocker, markSaved };
}
