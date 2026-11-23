// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../../shared/components/Modal';
import { INPUT_CLASS, PRIMARY_BUTTON_CLASS, SECONDARY_BUTTON_CLASS } from '../formStyles';
import {
  REVISE_AUTHOR_TEXT_MAX,
  revisionLanguageKey
} from '../../../../../../shared/appRevision.js';
import { reviseErrorMessage } from '../app-conversation/reviseErrors';

/**
 * The quick requests of the dialog: the chip's label and the request it sends.
 * Full keys, so that the i18n test of the app builder checks each one.
 */
export const IMPROVE_CHIPS = Object.freeze([
  {
    id: 'shorter',
    labelKey: 'admin.apps.edit.improve.chips.shorter',
    requestKey: 'admin.apps.edit.improve.requests.shorter'
  },
  {
    id: 'formal',
    labelKey: 'admin.apps.edit.improve.chips.formal',
    requestKey: 'admin.apps.edit.improve.requests.formal'
  },
  {
    id: 'steps',
    labelKey: 'admin.apps.edit.improve.chips.steps',
    requestKey: 'admin.apps.edit.improve.requests.steps'
  },
  {
    id: 'unsure',
    labelKey: 'admin.apps.edit.improve.chips.unsure',
    requestKey: 'admin.apps.edit.improve.requests.unsure'
  }
]);

const CHIP_CLASS =
  'inline-flex items-center rounded-full border border-gray-300 bg-white px-3 py-1 text-sm text-gray-800 hover:bg-gray-50 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-admin-accent dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed';
const TEXT_BLOCK_CLASS =
  'max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-gray-200 bg-gray-50 p-3 font-sans text-sm text-gray-800 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-admin-accent dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200';

/**
 * "Improve with AI" for the instructions of an app (slice 2 of the chat
 * builder plan): the author says what should be better, or picks a chip
 * (Shorter, More formal, Clearer steps, Say what to do if unsure); the model
 * proposes a new text, shown beside the current one; "Use this text" writes
 * it into the form.
 *
 * Nothing is saved here: the save bar's Discard takes the text back. The
 * request is one turn of `_revise` that may change the instructions only and
 * never asks back (`fields: ['system']`, `allowQuestions: false`).
 *
 * @param {object} props
 * @param {boolean} props.isOpen
 * @param {() => void} props.onClose
 * @param {(request: object) => Promise<object>} props.refine - The source's `refineDraft`.
 * @param {object} props.draft - The app's content as the turn sends it.
 * @param {string} props.language - The content language; the text in it is improved.
 * @param {(system: object) => void} props.onUse - Receives the whole new `system`
 *   value (its other languages kept).
 * @returns {JSX.Element|null}
 */
function ImproveInstructionsDialog({ isOpen, onClose, refine, draft, language, onUse }) {
  if (!isOpen) return null;
  return (
    <ImprovePanel
      onClose={onClose}
      refine={refine}
      draft={draft}
      language={language}
      onUse={onUse}
    />
  );
}

/** The open dialog; see {@link ImproveInstructionsDialog}. */
function ImprovePanel({ onClose, refine, draft, language, onUse }) {
  const { t } = useTranslation();
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const inputId = `${baseId}-input`;
  const [request, setRequest] = useState('');
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const controllerRef = useRef(null);
  const inputRef = useRef(null);
  const resultRef = useRef(null);

  useEffect(() => () => controllerRef.current?.abort(), []);
  useEffect(() => {
    if (result) resultRef.current?.focus();
  }, [result]);

  // The key the server reads the instructions from and writes the new text under:
  // `de-DE` for instructions kept under `de-DE`, else the base language.
  const textKey = revisionLanguageKey(draft?.system, language);
  const current = typeof draft?.system?.[textKey] === 'string' ? draft.system[textKey] : '';

  const ask = async text => {
    const message = typeof text === 'string' ? text.trim() : '';
    if (!message || working) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setWorking(true);
    setError(null);
    setResult(null);
    try {
      const answer = await refine({
        draft,
        conversation: [{ role: 'author', text: message.slice(0, REVISE_AUTHOR_TEXT_MAX) }],
        fields: ['system'],
        allowQuestions: false,
        language,
        signal: controller.signal
      });
      if (controller.signal.aborted) return;
      const system = answer?.patch?.system;
      const proposed = typeof system?.[textKey] === 'string' ? system[textKey] : null;
      setResult(
        answer?.reply === 'change' && proposed !== null && proposed !== current
          ? { system, text: proposed, note: answer.text || '' }
          : { system: null, text: null, note: answer?.text || '' }
      );
    } catch (failure) {
      if (controller.signal.aborted) return;
      setError(reviseErrorMessage(failure));
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setWorking(false);
      }
    }
  };

  const cancel = () => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setWorking(false);
  };

  return (
    <Modal isOpen onClose={onClose} labelledBy={titleId} maxWidthClassName="max-w-3xl">
      <div className="flex min-h-0 flex-col">
        <div className="border-b border-gray-200 px-4 py-3 dark:border-gray-700 sm:px-6">
          <h2 id={titleId} className="text-lg font-medium text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.improve.title')}
          </h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {t('admin.apps.edit.improve.hint')}
          </p>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-6">
          <form
            onSubmit={event => {
              event.preventDefault();
              void ask(request);
            }}
            className="space-y-2"
          >
            <label
              htmlFor={inputId}
              className="block text-sm font-medium text-gray-900 dark:text-gray-100"
            >
              {t('admin.apps.edit.improve.inputLabel')}
            </label>
            <textarea
              id={inputId}
              ref={inputRef}
              rows={2}
              value={request}
              maxLength={REVISE_AUTHOR_TEXT_MAX}
              onChange={event => setRequest(event.target.value)}
              className={INPUT_CLASS}
            />
            <ul
              className="flex flex-wrap gap-2"
              aria-label={t('admin.apps.edit.improve.chips.label')}
            >
              {IMPROVE_CHIPS.map(chip => (
                <li key={chip.id}>
                  <button
                    type="button"
                    className={CHIP_CLASS}
                    disabled={working}
                    onClick={() => {
                      const text = t(chip.requestKey);
                      setRequest(text);
                      void ask(text);
                    }}
                  >
                    {t(chip.labelKey)}
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <p role="status" className="mr-auto text-sm text-gray-700 dark:text-gray-300">
                {working ? t('admin.apps.conversation.working') : ''}
              </p>
              {working && (
                <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={cancel}>
                  {t('admin.apps.conversation.cancel')}
                </button>
              )}
              <button
                type="submit"
                className={PRIMARY_BUTTON_CLASS}
                disabled={working || request.trim() === ''}
              >
                {t('admin.apps.edit.improve.submit')}
              </button>
            </div>
          </form>

          {error && (
            <p role="alert" className="text-sm text-red-800 dark:text-red-200">
              {t(error.key, error.values)}
            </p>
          )}

          {result && (
            <div
              ref={resultRef}
              tabIndex={-1}
              data-testid="improve-result"
              className="space-y-3 rounded-sm focus:outline-hidden"
            >
              {result.note && (
                <p className="text-sm text-gray-800 dark:text-gray-200">{result.note}</p>
              )}
              {result.text === null ? (
                <p className="text-sm text-gray-700 dark:text-gray-300">
                  {t('admin.apps.edit.improve.noChange')}
                </p>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  <section>
                    <h3 className="mb-1 text-sm font-semibold text-gray-900 dark:text-gray-100">
                      {t('admin.apps.edit.improve.before')}
                    </h3>
                    <pre
                      lang={language}
                      data-testid="improve-before"
                      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- scrollable region must be keyboard reachable
                      tabIndex={0}
                      className={TEXT_BLOCK_CLASS}
                    >
                      {current}
                    </pre>
                  </section>
                  <section>
                    <h3 className="mb-1 text-sm font-semibold text-gray-900 dark:text-gray-100">
                      {t('admin.apps.edit.improve.after')}
                    </h3>
                    <pre
                      lang={language}
                      data-testid="improve-after"
                      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- scrollable region must be keyboard reachable
                      tabIndex={0}
                      className={TEXT_BLOCK_CLASS}
                    >
                      {result.text}
                    </pre>
                  </section>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-gray-200 px-4 py-3 dark:border-gray-700 sm:px-6">
          <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={onClose}>
            {t('admin.apps.edit.improve.close')}
          </button>
          {result?.system && (
            <button
              type="button"
              className={PRIMARY_BUTTON_CLASS}
              onClick={() => {
                onUse(result.system);
                onClose();
              }}
            >
              {t('admin.apps.edit.improve.use')}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

export default ImproveInstructionsDialog;
