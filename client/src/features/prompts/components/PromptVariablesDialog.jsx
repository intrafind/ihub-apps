import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import Icon from '../../../shared/components/Icon';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { highlightVariables } from '../../../utils/highlightVariables';
import {
  fillPromptVariables,
  initialVariableValues,
  missingRequiredVariables
} from '../../../../../shared/promptVariables.js';

const inputClass =
  'block w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 text-sm px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500';

/**
 * The fill-in form a prompt with variables opens before its text goes
 * anywhere: one field per variable, required-field checks, and a live preview
 * of the final text. Automatic variables (`{{user_name}}`, `{{date}}`, …) are
 * never asked for; they show up filled in, in the preview.
 *
 * @param {Object} props
 * @param {Object} props.prompt - The prompt (for its name).
 * @param {string} props.text - The prompt text in the current language.
 * @param {Array<Object>} props.fields - From `buildVariableFields`.
 * @param {Object} props.autoValues - Resolved automatic variables.
 * @param {string} [props.submitLabel] - Label of the confirm button.
 * @param {(values: Object) => void} props.onSubmit
 * @param {() => void} props.onClose
 */
function PromptVariablesDialog({
  prompt,
  text,
  fields,
  autoValues,
  submitLabel,
  onSubmit,
  onClose
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [values, setValues] = useState(() => initialVariableValues(fields));
  const [showErrors, setShowErrors] = useState(false);
  const firstFieldRef = useRef(null);
  const fieldsRef = useRef({});

  const missing = useMemo(() => missingRequiredVariables(fields, values), [fields, values]);
  // A field not filled in yet keeps its placeholder in the preview, so the
  // user sees what is still missing; the final text drops an empty one.
  const preview = useMemo(() => {
    const filled = Object.fromEntries(
      Object.entries(values).filter(
        ([, value]) => value !== undefined && value !== null && String(value).trim() !== ''
      )
    );
    return fillPromptVariables(text, filled, { autoValues }).text;
  }, [text, values, autoValues]);

  const setValue = (name, value) => setValues(prev => ({ ...prev, [name]: value }));

  const submit = event => {
    event?.preventDefault();
    if (missing.length > 0) {
      setShowErrors(true);
      fieldsRef.current[missing[0]]?.focus();
      return;
    }
    onSubmit(values);
  };

  const onKeyDown = event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit(event);
  };

  const renderInput = (field, index) => {
    const id = `prompt-var-${field.name}`;
    const invalid = showErrors && missing.includes(field.name);
    const common = {
      id,
      ref: el => {
        fieldsRef.current[field.name] = el;
        if (index === 0) firstFieldRef.current = el;
      },
      'aria-invalid': invalid || undefined,
      'aria-describedby': field.description ? `${id}-help` : undefined
    };
    const value = values[field.name];
    switch (field.type) {
      case 'textarea':
        return (
          <textarea
            {...common}
            rows={4}
            value={value ?? ''}
            onChange={e => setValue(field.name, e.target.value)}
            className={inputClass}
          />
        );
      case 'number':
        return (
          <input
            {...common}
            type="number"
            value={value ?? ''}
            onChange={e => setValue(field.name, e.target.value)}
            className={inputClass}
          />
        );
      case 'boolean':
        return (
          <input
            {...common}
            type="checkbox"
            checked={value === true || value === 'true'}
            onChange={e => setValue(field.name, e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
          />
        );
      case 'select':
        return (
          <select
            {...common}
            value={value ?? ''}
            onChange={e => setValue(field.name, e.target.value)}
            className={inputClass}
          >
            <option value="">{t('prompts.variables.choose', 'Choose…')}</option>
            {(field.predefinedValues || []).map(option => (
              <option key={String(option.value)} value={String(option.value)}>
                {getLocalizedContent(option.label, lang) || String(option.value)}
              </option>
            ))}
          </select>
        );
      default:
        return (
          <input
            {...common}
            type="text"
            value={value ?? ''}
            onChange={e => setValue(field.name, e.target.value)}
            className={inputClass}
          />
        );
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      maxWidthClassName="max-w-2xl"
      initialFocusRef={firstFieldRef}
      closeOnBackdropClick={false}
    >
      <form onSubmit={submit} onKeyDown={onKeyDown} className="flex flex-col min-h-0">
        <div className="flex items-start justify-between p-5 border-b border-gray-200 dark:border-gray-700">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 truncate">
              {getLocalizedContent(prompt?.name, lang)}
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t('prompts.variables.subtitle', 'Fill in the details for this prompt')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close', 'Close')}
            className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            <Icon name="x" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-4">
          {fields.map((field, index) => {
            const id = `prompt-var-${field.name}`;
            const invalid = showErrors && missing.includes(field.name);
            const label = getLocalizedContent(field.label, lang) || field.name;
            return (
              <div key={field.name}>
                <div className={field.type === 'boolean' ? 'flex items-center gap-2' : ''}>
                  {field.type === 'boolean' && renderInput(field, index)}
                  <label
                    htmlFor={id}
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                  >
                    {label}
                    {field.required && field.type !== 'boolean' && (
                      <span className="text-red-500 ml-0.5" aria-hidden="true">
                        *
                      </span>
                    )}
                  </label>
                </div>
                {field.type !== 'boolean' && renderInput(field, index)}
                {field.description && (
                  <p id={`${id}-help`} className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {getLocalizedContent(field.description, lang)}
                  </p>
                )}
                {!field.inText && (
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {t('prompts.variables.appVariable', 'Passed to the app')}
                  </p>
                )}
                {invalid && (
                  <p className="mt-1 text-xs text-red-600 dark:text-red-400" role="alert">
                    {t('prompts.variables.required', 'This field is required')}
                  </p>
                )}
              </div>
            );
          })}

          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">
              {t('prompts.variables.preview', 'Preview')}
            </div>
            <pre
              className="bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-md p-3 text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap wrap-break-word max-h-56 overflow-y-auto"
              aria-live="polite"
              data-testid="prompt-variables-preview"
            >
              {highlightVariables(preview)}
            </pre>
          </div>
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-gray-200 dark:border-gray-700">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="submit"
            className="px-4 py-2 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700"
          >
            {submitLabel || t('prompts.variables.insert', 'Insert')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default PromptVariablesDialog;
