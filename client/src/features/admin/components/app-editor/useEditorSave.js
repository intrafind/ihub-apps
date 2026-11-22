// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useRef, useState } from 'react';

/** Ctrl+S or Cmd+S, without Alt or Shift. */
const isSaveShortcut = event =>
  (event.ctrlKey || event.metaKey) &&
  !event.altKey &&
  !event.shiftKey &&
  (event.key === 's' || event.key === 'S');

/**
 * Saving the form of the app editor: the Save button, Ctrl/Cmd+S, and the
 * save that comes before publishing. A save stays in the editor.
 *
 * A form that is not valid is not sent. The page then leads the author to the
 * field; where it cannot (`explainInvalid` returns a sentence), that sentence
 * is the error.
 *
 * @param {object} options
 * @param {boolean} options.ready - There is a loaded app to save.
 * @param {boolean} options.valid - The form reports no error.
 * @param {() => Promise<unknown>} options.persist - Stores the app; rejects when the
 *   server refuses.
 * @param {() => string|null} options.explainInvalid - Called instead of `persist` for a
 *   form that is not valid.
 * @param {(error: unknown) => string} options.describeError - A failed request as a sentence.
 * @param {() => void} [options.onSaved] - The app was stored.
 * @returns {{saving: boolean, saveError: string|null, save: () => Promise<boolean>}}
 *   `save` resolves with whether the app was stored; it never rejects. A call
 *   while a save is running sends nothing and resolves with that save's result.
 *
 * @example
 * const { saving, saveError, save } = useEditorSave({
 *   ready: Boolean(app), valid, persist: editor.save, explainInvalid, describeError
 * });
 */
export function useEditorSave({ ready, valid, persist, explainInvalid, describeError, onSaved }) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  // Set at once, unlike the state: two key presses in a row send one request.
  // The second caller gets the running save, so "Publish" during a save waits
  // for it instead of taking it for a save that failed.
  const runningRef = useRef(null);

  const run = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await persist();
      onSaved?.();
      return true;
    } catch (error) {
      setSaveError(describeError(error));
      return false;
    } finally {
      runningRef.current = null;
      setSaving(false);
    }
  };

  const save = async () => {
    if (runningRef.current) return runningRef.current;
    if (!ready) return false;
    if (!valid) {
      setSaveError(explainInvalid());
      return false;
    }
    runningRef.current = run();
    return runningRef.current;
  };

  // The listener is registered once and always calls the newest `save`.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKeyDown = event => {
      if (!isSaveShortcut(event)) return;
      event.preventDefault();
      void saveRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return { saving, saveError, save };
}

export default useEditorSave;
