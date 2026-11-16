// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiErrorMessage } from '../../../utils/apiErrorMessage';

/**
 * State for one `ConfirmDialog` that runs an async action on confirm.
 *
 * Replaces the `if (!confirm(...)) return; try { … } catch { alert(…) }`
 * pattern. The dialog:
 *   - names the item and the consequence (the caller passes title/message);
 *   - shows a spinner and ignores Escape while the action runs (`busy`);
 *   - closes when the action succeeds;
 *   - stays open with the server's message inline when it fails, so the admin
 *     can retry or cancel (no `alert()`, no silent failure).
 *
 * @returns {{
 *   requestConfirm: (options: ConfirmRequest) => void,
 *   close: () => void,
 *   isOpen: boolean,
 *   dialogProps: Object
 * }} `dialogProps` is spread onto `<ConfirmDialog {...dialogProps} />`.
 *
 * @typedef {Object} ConfirmRequest
 * @property {string} title - Names action and item: `Delete model "GPT-4o"?`.
 * @property {React.ReactNode} [message] - Scope and consequence.
 * @property {React.ReactNode[]} [consequences] - Bulleted details.
 * @property {boolean} [irreversible] - Shows "This can't be undone."
 * @property {{ token: string, label?: string }} [typedConfirmation] - Type-to-confirm.
 * @property {{ reason: React.ReactNode }} [blocked] - Not possible: only Close.
 * @property {string} confirmLabel - Verb on the confirm button.
 * @property {boolean} [danger] - Destructive styling.
 * @property {() => (void|Promise<void>)} action - Runs on confirm. Throw to keep
 *   the dialog open with the error shown.
 * @property {(error: unknown) => string} [errorMessage] - Turns a thrown error
 *   into the inline message (default: the API problem `detail`, localized by `code`).
 *
 * @example
 * const { requestConfirm, dialogProps } = useConfirmAction();
 * const onDelete = model => requestConfirm({
 *   title: t('admin.confirm.deleteTitle', { type: t('admin.confirm.types.model'), name: model.name }),
 *   confirmLabel: t('admin.confirm.delete', 'Delete'),
 *   danger: true,
 *   action: async () => { await deleteModel(model.id); reload(); }
 * });
 * return <><button onClick={() => onDelete(m)}>…</button><ConfirmDialog {...dialogProps} /></>;
 */
export function useConfirmAction() {
  const { t } = useTranslation();
  const [request, setRequest] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // The request whose action is running; a dialog closed meanwhile is not reopened.
  const runningRef = useRef(null);

  const requestConfirm = useCallback(options => {
    setError(null);
    setBusy(false);
    setRequest(options);
  }, []);

  const close = useCallback(() => {
    runningRef.current = null;
    setRequest(null);
    setError(null);
    setBusy(false);
  }, []);

  const onConfirm = useCallback(async () => {
    if (!request || busy) return;
    runningRef.current = request;
    setBusy(true);
    setError(null);
    try {
      await request.action();
      if (runningRef.current === request) close();
    } catch (err) {
      if (runningRef.current !== request) return;
      const message = request.errorMessage
        ? request.errorMessage(err)
        : apiErrorMessage(err, t, t('admin.confirm.failed', 'The action failed.'));
      setError(message);
      setBusy(false);
    }
  }, [request, busy, close, t]);

  const dialogProps = {
    isOpen: Boolean(request),
    title: request?.title ?? '',
    message: request?.message,
    consequences: request?.consequences,
    irreversible: request?.irreversible,
    typedConfirmation: request?.typedConfirmation,
    blocked: request?.blocked,
    confirmLabel: request?.confirmLabel,
    danger: request?.danger,
    busy,
    error,
    onConfirm,
    onDeny: close
  };

  return { requestConfirm, close, isOpen: Boolean(request), dialogProps };
}

export default useConfirmAction;
