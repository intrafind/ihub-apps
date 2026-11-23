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
 * Saving the form of the app editor: the Save button, Ctrl/Cmd+S, the save
 * that comes before publishing, and the save of the conversation's Apply and
 * Undo (`saveValue`). A save stays in the editor.
 *
 * A form that is not valid is not sent. The page then leads the author to the
 * field; where it cannot (`explainInvalid` returns a sentence), that sentence
 * is the error. `saveValue` does not ask the form: its value was checked by
 * the server that proposed it, and the save route checks it again.
 *
 * A save the server refused because the app changed since the editor loaded
 * it (`isConflict`) is not an error line: `conflict` turns true, and the page
 * says so and offers to reload. The next successful save clears it.
 *
 * @param {object} options
 * @param {boolean} options.ready - There is a loaded app to save.
 * @param {boolean} options.valid - The form reports no error.
 * @param {() => Promise<unknown>} options.persist - Stores the app; rejects when the
 *   server refuses.
 * @param {(value: object) => Promise<unknown>} [options.persistValue] - Puts a value into
 *   the form and stores it; needed for `saveValue`.
 * @param {() => string|null} options.explainInvalid - Called instead of `persist` for a
 *   form that is not valid.
 * @param {(error: unknown) => string} options.describeError - A failed request as a sentence.
 * @param {(error: unknown) => boolean} [options.isConflict] - Whether a failed save was
 *   refused because someone else saved the app in between.
 * @param {() => void} [options.onSaved] - The app was stored by `save`.
 * @returns {{
 *   saving: boolean,
 *   saveError: string|null,
 *   conflict: boolean,
 *   clearConflict: () => void,
 *   save: () => Promise<boolean>,
 *   saveValue: (value: object) => Promise<{status: 'saved'|'conflict'|'failed', message?: string|null}>
 * }} `save` resolves with whether the app was stored; it never rejects. A call
 *   while a save is running sends nothing and resolves with that save's result.
 *   `saveValue` waits for a running save, then stores `value`; it never rejects.
 *
 * @example
 * const { saving, saveError, save } = useEditorSave({
 *   ready: Boolean(app), valid, persist: editor.save, explainInvalid, describeError
 * });
 */
export function useEditorSave({
  ready,
  valid,
  persist,
  persistValue,
  explainInvalid,
  describeError,
  isConflict,
  onSaved
}) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [conflict, setConflict] = useState(false);
  // Set at once, unlike the state: two key presses in a row send one request.
  // The second caller gets the running save, so "Publish" during a save waits
  // for it instead of taking it for a save that failed.
  const runningRef = useRef(null);

  /** One request; resolves with its outcome and never rejects. */
  const attempt = async request => {
    setSaving(true);
    setSaveError(null);
    try {
      await request();
      setConflict(false);
      return { status: 'saved' };
    } catch (error) {
      if (isConflict?.(error)) {
        setConflict(true);
        return { status: 'conflict' };
      }
      return { status: 'failed', message: describeError(error) };
    } finally {
      runningRef.current = null;
      setSaving(false);
    }
  };

  const run = async () => {
    const outcome = await attempt(persist);
    if (outcome.status === 'saved') onSaved?.();
    if (outcome.status === 'failed') setSaveError(outcome.message);
    return outcome.status === 'saved';
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

  const saveValue = async value => {
    // A save that is running stores what the form held; this one comes after it.
    if (runningRef.current) await runningRef.current;
    if (!ready || !persistValue) return { status: 'failed', message: null };
    const outcome = attempt(() => persistValue(value));
    runningRef.current = outcome.then(result => result.status === 'saved');
    return outcome;
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

  return {
    saving,
    saveError,
    conflict,
    clearConflict: () => setConflict(false),
    save,
    saveValue
  };
}

export default useEditorSave;
