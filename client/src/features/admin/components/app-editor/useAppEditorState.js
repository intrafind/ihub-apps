// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useRef, useState } from 'react';
import { useUnsavedChanges } from '../../hooks/useUnsavedChanges';
import { describeAdminLoadError } from '../../hooks/useAdminConfigLoad';

const NOTHING_LOADED = Object.freeze({ appId: null, app: null, savedApp: null, loadError: null });

/**
 * The app the editor holds: the loaded app, the author's edits, and what is
 * saved. An app is created on its own page, so this editor only ever loads an
 * existing app; it has no "new" mode and no default object.
 *
 * Beside load and save it knows one more way the saved state changes:
 * `applySaved`. Publishing and unpublishing change one field on the server
 * without saving the form. The same field is then set in the edited app and in
 * the saved baseline, so the change is not an unsaved edit and the author's
 * other edits stay unsaved.
 *
 * How the app is loaded and saved comes from the caller, so the hook names no
 * endpoint.
 *
 * @param {object} options
 * @param {string} options.appId - The app to edit.
 * @param {(appId: string) => Promise<object>} options.loadApp - Resolves with the app as
 *   the form edits it.
 * @param {(app: object, appId: string) => Promise<unknown>} options.saveApp - Stores the app.
 * @returns {{
 *   app: object|null,
 *   setApp: (next: object|((app: object) => object)) => void,
 *   savedApp: object|null,
 *   isDirty: boolean,
 *   loading: boolean,
 *   loadError: {status: number|null, code: string|null, detail: string, retryAfterSeconds: number|null}|null,
 *   retryLoad: () => Promise<void>,
 *   save: () => Promise<unknown>,
 *   discard: () => void,
 *   applySaved: (patch: object) => void,
 *   blocker: {state: 'blocked'|'unblocked', proceed: Function, reset: Function}
 * }} `app` and `savedApp` are null until the app has loaded. While `loadError`
 *   is set there is nothing to edit and `save` refuses.
 *
 * @example
 * const editor = useAppEditorState({ appId, loadApp, saveApp });
 * await toggle(appId, true);
 * editor.applySaved({ enabled: true }); // published, and still not dirty
 */
export function useAppEditorState({ appId, loadApp, saveApp }) {
  // What was loaded, and for which app: after the route moved on to another
  // app, nothing of the one before may be shown or saved.
  const [state, setState] = useState(NOTHING_LOADED);
  const current = state.appId === appId ? state : NOTHING_LOADED;
  const { app, savedApp, loadError } = current;
  const loading = state.appId !== appId;
  // Bumped by every load, so a slow earlier answer cannot overwrite a newer one.
  const generationRef = useRef(0);

  const loadAppRef = useRef(loadApp);
  loadAppRef.current = loadApp;
  const saveAppRef = useRef(saveApp);
  saveAppRef.current = saveApp;

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    try {
      const loaded = await loadAppRef.current(appId);
      if (generation !== generationRef.current) return;
      setState({ appId, app: loaded, savedApp: loaded, loadError: null });
    } catch (error) {
      if (generation !== generationRef.current) return;
      setState({ appId, app: null, savedApp: null, loadError: describeAdminLoadError(error) });
    }
  }, [appId]);

  useEffect(() => {
    void load();
    return () => {
      generationRef.current += 1;
    };
  }, [load]);

  /** Changes the loaded state of this app; a no-op once the route shows another one. */
  const update = useCallback(
    change => setState(held => (held.appId === appId && held.app ? change(held) : held)),
    [appId]
  );

  const setApp = useCallback(
    next => update(held => ({ ...held, app: typeof next === 'function' ? next(held.app) : next })),
    [update]
  );

  const { isDirty, blocker } = useUnsavedChanges(savedApp, app);

  // Always the newest app: `save` stores what the author sees, and can tell
  // whether the author kept editing while the request was running.
  const latestAppRef = useRef(app);
  latestAppRef.current = app;

  const save = useCallback(async () => {
    // Never save over an app that did not load: the form holds no real data.
    if (loadError) throw new Error(loadError.detail);
    const snapshot = latestAppRef.current;
    if (!snapshot) throw new Error('The app has not loaded yet.');
    const result = await saveAppRef.current(snapshot, appId);
    // What was just saved is the new baseline; edits made while the request
    // ran differ from it and stay unsaved.
    update(held => ({ ...held, savedApp: snapshot }));
    return result;
  }, [appId, loadError, update]);

  const discard = useCallback(() => update(held => ({ ...held, app: held.savedApp })), [update]);

  const applySaved = useCallback(
    patch =>
      update(held => ({
        ...held,
        app: { ...held.app, ...patch },
        savedApp: { ...held.savedApp, ...patch }
      })),
    [update]
  );

  return {
    app,
    setApp,
    savedApp,
    isDirty,
    loading,
    loadError,
    retryLoad: load,
    save,
    discard,
    applySaved,
    blocker
  };
}

export default useAppEditorState;
