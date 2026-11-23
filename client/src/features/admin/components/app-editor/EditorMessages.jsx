// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import { CALLOUT_CLASS } from '../formStyles';

const TOAST_MS = 4000;

/**
 * A short confirmation that goes away by itself ("App saved"). A new message
 * replaces the one that is showing and starts the time again.
 *
 * @returns {[string|null, (message: string) => void]} The message to show, if
 *   any, and the function that shows one.
 *
 * @example
 * const [toast, showToast] = useEditorToast();
 * showToast(t('admin.apps.edit.saved'));
 * <EditorToast message={toast} />
 */
export function useEditorToast() {
  const [message, setMessage] = useState(null);
  const timerRef = useRef(null);

  const show = useCallback(text => {
    clearTimeout(timerRef.current);
    setMessage(text);
    timerRef.current = setTimeout(() => setMessage(null), TOAST_MS);
  }, []);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  return [message, show];
}

const VISIBLE_CLASS =
  'fixed top-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-md bg-green-700 px-4 py-2 text-sm text-white shadow-lg';

/**
 * The confirmation of `useEditorToast`, at the top of the window. The region
 * is always in the page and empty while there is nothing to say, so that a
 * screen reader announces a message when it appears; it takes no focus.
 *
 * @param {object} props
 * @param {string|null} props.message
 * @returns {JSX.Element}
 */
function EditorToast({ message }) {
  return (
    <div role="status" data-testid="editor-toast" className={message ? VISIBLE_CLASS : 'sr-only'}>
      {message && (
        <>
          <Icon name="check-circle" className="h-4 w-4" aria-hidden="true" />
          {message}
        </>
      )}
    </div>
  );
}

/**
 * Why the last save did not go through, above the form. It is announced at
 * once.
 *
 * @param {object} props
 * @param {string|null} props.message - Nothing is rendered without one.
 * @returns {JSX.Element|null}
 */
export function EditorSaveError({ message }) {
  const { t } = useTranslation();
  if (!message) return null;
  return (
    <div role="alert" className={`mt-6 flex items-start gap-2 ${CALLOUT_CLASS.danger}`}>
      <Icon name="x-circle" className="shrink-0" aria-hidden="true" />
      <div>
        <h2 className="font-medium">{t('admin.apps.errorTitle')}</h2>
        <p className="mt-1">{message}</p>
      </div>
    </div>
  );
}

export default EditorToast;
