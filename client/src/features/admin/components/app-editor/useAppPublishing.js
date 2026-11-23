// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useState } from 'react';

/**
 * Publishing and unpublishing an app from its editor.
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
 * @param {(appId: string, published: boolean) => Promise<unknown>} options.setPublished -
 *   Sets the flag on the server.
 * @param {() => Promise<boolean>} options.saveFirst - Saves the form; resolves with
 *   whether it was saved.
 * @param {(published: boolean) => void} options.onChanged - The flag was set.
 * @param {(error: unknown) => string} options.describeError - A failed request as a sentence.
 * @param {(error: unknown) => boolean} [options.isConflict] - Whether the flag was refused
 *   because someone else saved the app since the editor loaded it.
 * @param {() => void} [options.onConflict] - Called instead of showing an error for such a
 *   refusal; the dialog closes, and the page says that the app changed.
 * @param {() => void} [options.onAskPublish] - The publish dialog opens: the moment to
 *   ask again who can use the app.
 * @returns {{
 *   dialog: 'publish'|'unpublish'|null,
 *   busy: boolean,
 *   error: string|null,
 *   askPublish: () => void,
 *   askUnpublish: () => void,
 *   cancel: () => void,
 *   confirm: () => Promise<void>
 * }} `error` is why the flag could not be set; the dialog stays open with it.
 *
 * @example
 * const publishing = useAppPublishing({ appId, isDirty, setPublished, saveFirst: save,
 *   onChanged: enabled => editor.applySaved({ enabled }), describeError });
 * <button onClick={publishing.askPublish}>Publish</button>
 */
export function useAppPublishing({
  appId,
  isDirty,
  setPublished,
  saveFirst,
  onChanged,
  describeError,
  isConflict,
  onConflict,
  onAskPublish
}) {
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const askPublish = () => {
    setError(null);
    setDialog('publish');
    onAskPublish?.();
  };

  const askUnpublish = useCallback(() => {
    setError(null);
    setDialog('unpublish');
  }, []);

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
      if (onConflict && isConflict?.(failure)) {
        setDialog(null);
        onConflict();
      } else {
        setError(describeError(failure));
      }
    } finally {
      setBusy(false);
    }
  };

  return { dialog, busy, error, askPublish, askUnpublish, cancel, confirm };
}

export default useAppPublishing;
