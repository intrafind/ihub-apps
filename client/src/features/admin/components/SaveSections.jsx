// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore
} from 'react';
import AdminSaveBar from './AdminSaveBar';
import UnsavedChangesDialog from './UnsavedChangesDialog';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';

/**
 * One save bar for a page whose sections load, edit and save on their own (the cards of the
 * Security page, the Logging page, the EU AI Act cards, a card inside a list page).
 *
 * A section keeps its own state and handlers and registers what the bar needs with
 * {@link useSaveSection}. The page wraps its sections in {@link SaveSectionsProvider} and
 * shows {@link SaveSectionsBar} (or hands {@link useSaveSections} to `AdminSettingsPage`).
 *
 * - The bar shows while any section is dirty or a save runs.
 * - Save runs the dirty sections one after another, in the order they registered, and stops
 *   at the first one that fails. A section that saved stays saved; the failed one and those
 *   after it stay dirty, so the bar stays and names the error.
 * - Discard resets every dirty section.
 *
 * Outside a provider `useSaveSection` does nothing and says `managed: false`, so a section
 * reused somewhere else can still draw its own Save button.
 *
 * Providers nest: a provider below another one hands out the outer registry and its bar draws
 * nothing, so a tab that carries its own provider and bar can be hosted by a page that keeps
 * the tab mounted (hidden) and shows ONE bar and leave-guard for the whole page.
 */

const SaveSectionsContext = createContext(null);
/** True below a provider that deferred to an outer one: its bar is the outer bar's job. */
const SaveSectionsHostedContext = createContext(false);

/** The registry: what each section last said, read by the bar when it renders or saves. */
function createStore() {
  const entries = new Map();
  const listeners = new Set();
  let version = 0;
  let snapshot = { dirty: false, saving: false, error: null, version: 0 };
  let running = false;

  const compute = () => {
    let dirty = false;
    let saving = running;
    let error = null;
    for (const entry of entries.values()) {
      if (entry.dirty) dirty = true;
      if (entry.saving) saving = true;
      if (!error && entry.error) error = entry.error;
    }
    return { dirty, saving, error, version };
  };

  const notify = () => {
    version += 1;
    snapshot = compute();
    for (const listener of listeners) listener();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    /** Store the latest value of a section; tell the bar only when what it shows changed. */
    set(id, next) {
      const before = entries.get(id);
      entries.set(id, next);
      if (
        !before ||
        before.dirty !== next.dirty ||
        before.saving !== next.saving ||
        before.error !== next.error
      ) {
        notify();
      }
    },
    remove(id) {
      if (entries.delete(id)) notify();
    },
    async saveAll() {
      if (running) return false;
      running = true;
      notify();
      try {
        // A snapshot of the dirty sections as they are now, in registration order.
        for (const [id] of [...entries].filter(([, entry]) => entry.dirty)) {
          const entry = entries.get(id);
          if (!entry?.dirty) continue;
          let ok;
          try {
            ok = await entry.save();
          } catch {
            ok = false;
          }
          if (ok === false) return false;
        }
        return true;
      } finally {
        running = false;
        notify();
      }
    },
    discardAll() {
      for (const entry of entries.values()) {
        if (entry.dirty) entry.discard();
      }
    }
  };
}

/**
 * Provides the registry to the sections of a page.
 *
 * @param {Object} props
 * @param {React.ReactNode} props.children
 */
export function SaveSectionsProvider({ children }) {
  const outer = useContext(SaveSectionsContext);
  const storeRef = useRef(null);
  if (outer === null && storeRef.current === null) storeRef.current = createStore();
  if (outer !== null) {
    return (
      <SaveSectionsHostedContext.Provider value={true}>
        {children}
      </SaveSectionsHostedContext.Provider>
    );
  }
  return (
    <SaveSectionsContext.Provider value={storeRef.current}>{children}</SaveSectionsContext.Provider>
  );
}

/**
 * Registers a section with the page's save bar.
 *
 * @param {string} id - Unique among the sections of the page; the order of first use is the
 *   order Save runs them in.
 * @param {Object} section
 * @param {boolean} section.dirty - The section has unsaved edits (and has loaded).
 * @param {boolean} [section.saving] - A save of this section is running.
 * @param {() => Promise<boolean|void>} section.save - Saves the section. Resolve `false` (or
 *   throw) when it did not save, so the bar stops and stays; resolve anything else on success.
 * @param {() => void} section.discard - Puts the section back to what is saved, with its
 *   inputs and messages.
 * @param {string|null} [section.error] - Why the last save failed, shown in the bar.
 * @returns {{ managed: boolean }} `managed` is true inside a provider: the section then
 *   leaves its Save button to the bar.
 */
export function useSaveSection(id, { dirty, saving = false, save, discard, error = null }) {
  const store = useContext(SaveSectionsContext);
  // The newest handlers, read when the bar saves: no stale closure, no re-registering.
  const handlersRef = useRef({ save, discard });
  handlersRef.current = { save, discard };

  const stableSave = useCallback(() => handlersRef.current.save(), []);
  const stableDiscard = useCallback(() => handlersRef.current.discard(), []);

  useEffect(() => {
    if (!store) return;
    store.set(id, {
      dirty: Boolean(dirty),
      saving: Boolean(saving),
      error: error || null,
      save: stableSave,
      discard: stableDiscard
    });
  }, [store, id, dirty, saving, error, stableSave, stableDiscard]);

  // A section that goes away no longer holds anything to save.
  useEffect(() => {
    if (!store) return undefined;
    return () => store.remove(id);
  }, [store, id]);

  return { managed: Boolean(store) };
}

const EMPTY = { dirty: false, saving: false, error: null, version: 0 };

/**
 * What the page-level bar needs. Call it below a {@link SaveSectionsProvider}.
 *
 * @returns {{ dirty: boolean, saving: boolean, error: string|null, save: () => Promise<boolean>, discard: () => void }}
 */
export function useSaveSections() {
  const store = useContext(SaveSectionsContext);
  const subscribe = useCallback(
    listener => (store ? store.subscribe(listener) : () => {}),
    [store]
  );
  const getSnapshot = useCallback(() => (store ? store.getSnapshot() : EMPTY), [store]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(
    () => ({
      dirty: state.dirty,
      saving: state.saving,
      error: state.error,
      save: () => (store ? store.saveAll() : Promise.resolve(true)),
      discard: () => store?.discardAll()
    }),
    [state, store]
  );
}

/**
 * The bar of a page with sections: shows while any section is dirty, saves them one after
 * another and says why a save did not go through.
 *
 * @param {Object} [props]
 * @param {boolean} [props.disabled=false] - Hide the bar (the page is loading or its load failed).
 * @param {boolean} [props.leaveGuard=false] - Also ask before the admin leaves the page while
 *   a section is dirty ("Leave without saving?"). Leave it off on a page that guards itself.
 */
export function SaveSectionsBar({ disabled = false, leaveGuard = false }) {
  const { dirty, saving, error, save, discard } = useSaveSections();
  const hosted = useContext(SaveSectionsHostedContext);
  if (hosted) return null;
  return (
    <>
      {!disabled && (
        <AdminSaveBar
          dirty={dirty}
          saving={saving}
          message={error || undefined}
          onSave={() => void save()}
          onDiscard={discard}
        />
      )}
      {leaveGuard && <SaveSectionsLeaveGuard />}
    </>
  );
}

/** The route leave-guard of the page's sections: one dialog for all of them. */
function SaveSectionsLeaveGuard() {
  const { dirty } = useSaveSections();
  const { blocker } = useUnsavedChanges(false, dirty);
  return <UnsavedChangesDialog blocker={blocker} />;
}
