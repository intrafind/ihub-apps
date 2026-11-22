// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import { CALLOUT_CLASS, HELP_CLASS, INPUT_CLASS, PRIMARY_BUTTON_CLASS } from '../formStyles';
import {
  GENERATE_CLIENT_ERROR_KEYS,
  GENERATE_ERROR_KEYS,
  descriptionProblem,
  generateErrorMessage
} from './generateErrors';

/** The example chips under the description box: the chip's label and the text it fills in. */
export const DESCRIBE_EXAMPLE_KEYS = Object.freeze({
  summary: Object.freeze({
    chip: 'admin.apps.create.start.examples.summary.chip',
    text: 'admin.apps.create.start.examples.summary.text'
  }),
  reply: Object.freeze({
    chip: 'admin.apps.create.start.examples.reply.chip',
    text: 'admin.apps.create.start.examples.reply.text'
  }),
  translate: Object.freeze({
    chip: 'admin.apps.create.start.examples.translate.chip',
    text: 'admin.apps.create.start.examples.translate.text'
  })
});

/** A button that reads as a link, beside the button that starts a draft. */
export const DRAFT_LINK_BUTTON_CLASS =
  'rounded-sm text-sm font-medium text-admin-accent dark:text-admin-accent-fg-dark underline hover:no-underline focus:outline-hidden focus-visible:ring-2 focus-visible:ring-admin-accent dark:focus-visible:ring-admin-accent-fg-dark';

const CHIP_CLASS =
  'rounded-full border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-1 text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-admin-accent dark:focus-visible:ring-admin-accent-fg-dark disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * One draft request at a time, shared by the description box of the Start
 * screen and by the draft notice.
 *
 * - `start(description)` checks the description, then calls `generate`. While
 *   a request runs, a second call does nothing.
 * - `cancel()` aborts the request's signal and shows no error. Escape does the
 *   same while a request runs, unless a dialog has the focus.
 * - An answer or a failure is applied only while its request is the current
 *   one. A new request clears the message of the one before.
 *
 * @param {object} options
 * @param {(request: { description: string, language?: string, signal: AbortSignal }) => Promise<object>} options.generate
 *   Sends the request and resolves with the response body.
 * @param {string} [options.language] - The content language of the draft.
 * @param {(result: object, description: string) => void} options.onDraft - Receives the
 *   response body and the description that was sent.
 * @returns {{ pending: boolean, error: { key: string, values?: object, input?: boolean } | null, start: (description: string) => Promise<void>, cancel: () => void, clearInputError: () => void }}
 *   `error.input` marks a message about the description itself.
 */
export function useDraftRequest({ generate, language, onDraft }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  // The AbortController of the running request; null while none runs.
  const runningRef = useRef(null);

  const cancel = useCallback(() => {
    const controller = runningRef.current;
    if (!controller) return;
    runningRef.current = null;
    controller.abort();
    setPending(false);
  }, []);

  // Leaving the screen stops the request, and with it the model call on the server.
  useEffect(
    () => () => {
      runningRef.current?.abort();
      runningRef.current = null;
    },
    []
  );

  useEffect(() => {
    if (!pending) return undefined;
    const onKeyDown = event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // An open dialog closes on Escape itself.
      if (event.target?.closest?.('[role="dialog"], [role="alertdialog"]')) return;
      cancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [pending, cancel]);

  const start = useCallback(
    async description => {
      if (runningRef.current) return;
      const problem = descriptionProblem(description);
      if (problem) {
        setError({ ...problem, input: true });
        return;
      }

      const controller = new AbortController();
      runningRef.current = controller;
      setError(null);
      setPending(true);
      const sent = description.trim();

      let result;
      let failure = null;
      try {
        result = await generate({ description: sent, language, signal: controller.signal });
      } catch (caught) {
        failure = { error: caught };
      }

      // Cancelled, or the component is gone: a late answer changes nothing.
      if (runningRef.current !== controller) return;
      runningRef.current = null;
      setPending(false);

      if (failure) {
        // A request that stopped without the author's Cancel is one that got no answer.
        setError(
          generateErrorMessage(failure.error) ?? { key: GENERATE_CLIENT_ERROR_KEYS.timeout }
        );
        return;
      }
      if (!result || typeof result.app !== 'object' || result.app === null) {
        setError({ key: GENERATE_ERROR_KEYS.APP_GENERATOR_INVALID_ANSWER });
        return;
      }
      onDraft(result, sent);
    },
    [generate, language, onDraft]
  );

  const clearInputError = useCallback(() => {
    setError(current => (current?.input ? null : current));
  }, []);

  return { pending, error, start, cancel, clearInputError };
}

/**
 * The description box of the Start screen: the author says what the app
 * should do and gets a draft from the AI.
 *
 * The component holds the request and its message; the page holds the
 * description (so it survives a failed draft, a screen change and a reload)
 * and decides what a draft does. It makes no request of its own: `generate`
 * is the call of the API module.
 *
 * @param {object} props
 * @param {object} [props.source] - What the create page offers. `source.copy.limits` is the
 *   key of a line under the box that says what such an app cannot do; without it there is none.
 * @param {string} props.description - The text in the box.
 * @param {(text: string) => void} props.onDescriptionChange
 * @param {(result: object, description: string) => void} props.onDraft - Called with the body of
 *   `POST /api/admin/apps/_generate` (`{ app, suggestions, warnings, model, brief }`) and the
 *   description that was sent.
 * @param {(request: { description: string, language?: string, signal: AbortSignal }) => Promise<object>} props.generate
 * @param {string} [props.language] - The content language of the draft; the UI language when absent.
 * @param {string} [props.modelName] - The model that receives the description. Without it the
 *   line that names the model is left out.
 * @returns {JSX.Element}
 */
function DescribeStart({
  source,
  description = '',
  onDescriptionChange,
  onDraft,
  generate,
  language,
  modelName
}) {
  const { t, i18n } = useTranslation();
  const baseId = useId();
  const textareaRef = useRef(null);
  const submitRef = useRef(null);
  const { pending, error, start, cancel, clearInputError } = useDraftRequest({
    generate,
    language: language ?? i18n?.language,
    onDraft
  });

  const headingId = `${baseId}-heading`;
  const fieldId = `${baseId}-description`;
  const helpId = `${baseId}-help`;
  const errorId = `${baseId}-error`;
  const limitsId = `${baseId}-limits`;
  const limitsKey = source?.copy?.limits || null;
  const describedBy = [helpId, limitsKey ? limitsId : null, error ? errorId : null]
    .filter(Boolean)
    .join(' ');

  const handleChange = text => {
    clearInputError();
    onDescriptionChange(text);
  };

  const handleExample = textKey => {
    handleChange(t(textKey));
    textareaRef.current?.focus();
  };

  const handleKeyDown = event => {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    void start(description);
  };

  const handleCancel = () => {
    cancel();
    // The Cancel button is gone after this; keep the keyboard where the author was.
    submitRef.current?.focus();
  };

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 id={headingId} className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        {t('admin.apps.create.start.heading')}
      </h2>

      <div>
        <label htmlFor={fieldId} className="sr-only">
          {t('admin.apps.create.start.label')}
        </label>
        <textarea
          ref={textareaRef}
          id={fieldId}
          rows={4}
          className={INPUT_CLASS}
          placeholder={t('admin.apps.create.start.placeholder')}
          value={description}
          readOnly={pending}
          aria-invalid={error?.input ? 'true' : undefined}
          aria-describedby={describedBy}
          onChange={event => handleChange(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <p id={helpId} className={HELP_CLASS}>
          {t('admin.apps.create.start.help')}
        </p>
        {limitsKey && (
          <p id={limitsId} className={HELP_CLASS}>
            {t(limitsKey)}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-600 dark:text-gray-400">
          {t('admin.apps.create.start.examples.label')}
        </span>
        {Object.entries(DESCRIBE_EXAMPLE_KEYS).map(([name, keys]) => (
          <button
            key={name}
            type="button"
            className={CHIP_CLASS}
            disabled={pending}
            onClick={() => handleExample(keys.text)}
          >
            {t(keys.chip)}
          </button>
        ))}
      </div>

      {error && (
        <p id={errorId} role="alert" className={CALLOUT_CLASS.danger}>
          {t(error.key, error.values).trim()}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          ref={submitRef}
          type="button"
          className={`${PRIMARY_BUTTON_CLASS} w-full sm:w-auto aria-disabled:cursor-progress`}
          aria-disabled={pending ? 'true' : undefined}
          onClick={() => start(description)}
        >
          <Icon
            name={pending ? 'spinner' : 'sparkles'}
            size="sm"
            className={pending ? 'shrink-0 motion-safe:animate-spin' : 'shrink-0'}
            aria-hidden="true"
          />
          <span>
            {pending
              ? t('admin.apps.create.start.generating')
              : t('admin.apps.create.start.generate')}
          </span>
        </button>
        {pending && (
          <button type="button" className={DRAFT_LINK_BUTTON_CLASS} onClick={handleCancel}>
            {t('admin.apps.create.cancel')}
          </button>
        )}
        {modelName && (
          <p className="text-xs text-gray-600 dark:text-gray-400">
            {t('admin.apps.create.start.privacy', { model: modelName })}
          </p>
        )}
      </div>

      <p role="status" aria-live="polite" className="sr-only">
        {pending ? t('admin.apps.create.start.generating') : ''}
      </p>
    </section>
  );
}

export default DescribeStart;
