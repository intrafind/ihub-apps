// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useRef, useState } from 'react';

const NOT_LOADED = Object.freeze({ loading: true, failed: false, view: null });

/**
 * Publishing and unpublishing an app from its editor, and the view that says
 * who can use it.
 *
 * Both actions change only the published flag on the server. They are not a
 * save of the form:
 *
 * - Unpublish never saves and does not depend on the form being valid, so an
 *   app with a form error can still be taken away from users. Unsaved edits
 *   stay unsaved.
 * - Publish with a clean form only sets the flag.
 * - Publish with unsaved changes saves first. If that save does not go
 *   through, nothing is published and the dialog closes, so the author sees
 *   what to fix.
 *
 * The requests come from the caller, so the hook names no endpoint.
 *
 * @param {object} options
 * @param {string} options.appId
 * @param {boolean} options.isDirty - The editor has unsaved changes.
 * @param {(appId: string) => Promise<object>} options.loadAccess - Resolves with the
 *   content-access view `{ scope, groups, audience }`.
 * @param {(appId: string, published: boolean) => Promise<unknown>} options.setPublished -
 *   Sets the flag on the server.
 * @param {() => Promise<boolean>} options.saveFirst - Saves the form; resolves with
 *   whether it was saved.
 * @param {(published: boolean) => void} options.onChanged - The flag was set.
 * @param {(error: unknown) => string} options.describeError - A failed request as a sentence.
 * @returns {{
 *   access: {loading: boolean, failed: boolean, view: object|null},
 *   setAccessView: (view: object) => void,
 *   dialog: 'publish'|'unpublish'|null,
 *   busy: boolean,
 *   error: string|null,
 *   askPublish: () => void,
 *   askUnpublish: () => void,
 *   cancel: () => void,
 *   confirm: () => Promise<void>
 * }}
 */
export function useAppPublishing({
  appId,
  isDirty,
  loadAccess,
  setPublished,
  saveFirst,
  onChanged,
  describeError
}) {
  const [accessState, setAccessState] = useState({ appId: null, ...NOT_LOADED });
  const access = accessState.appId === appId ? accessState : NOT_LOADED;
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // The newest request wins: the dialog asks again when it opens.
  const requestRef = useRef(0);

  const loadAccessRef = useRef(loadAccess);
  loadAccessRef.current = loadAccess;

  const refreshAccess = useCallback(async () => {
    const request = ++requestRef.current;
    setAccessState(held => (held.appId === appId ? { ...held, loading: true } : held));
    try {
      const view = await loadAccessRef.current(appId);
      if (request !== requestRef.current) return;
      setAccessState({ appId, loading: false, failed: false, view });
    } catch {
      if (request !== requestRef.current) return;
      setAccessState({ appId, loading: false, failed: true, view: null });
    }
  }, [appId]);

  useEffect(() => {
    void refreshAccess();
    return () => {
      requestRef.current += 1;
    };
  }, [refreshAccess]);

  /** What the access section saved is newer than anything still on its way. */
  const setAccessView = useCallback(
    view => {
      requestRef.current += 1;
      setAccessState({ appId, loading: false, failed: false, view });
    },
    [appId]
  );

  const open = useCallback(kind => {
    setError(null);
    setDialog(kind);
  }, []);

  const askPublish = useCallback(() => {
    open('publish');
    // Groups may have changed since the page loaded; say who sees the app now.
    void refreshAccess();
  }, [open, refreshAccess]);

  const askUnpublish = useCallback(() => open('unpublish'), [open]);

  const cancel = useCallback(() => {
    setDialog(null);
    setError(null);
  }, []);

  const confirm = async () => {
    if (!dialog || busy) return;
    const publish = dialog === 'publish';
    setBusy(true);
    setError(null);
    try {
      if (publish && isDirty && !(await saveFirst())) {
        setDialog(null);
        return;
      }
      await setPublished(appId, publish);
      onChanged(publish);
      setDialog(null);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  return {
    access,
    setAccessView,
    dialog,
    busy,
    error,
    askPublish,
    askUnpublish,
    cancel,
    confirm
  };
}

export default useAppPublishing;
