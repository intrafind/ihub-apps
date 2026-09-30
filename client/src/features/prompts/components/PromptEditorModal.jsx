import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import Icon from '../../../shared/components/Icon';
import IconPicker from '../../../shared/components/IconPicker';
import { createUserPrompt, updateUserPrompt } from '../../../api';
import useApps from '../../../shared/hooks/useApps';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { loadAutoVariables } from '../utils/autoVariables';
import { promptErrorMessage } from '../utils/promptErrors';
import {
  BUILTIN_AUTO_VARIABLES,
  CONTENT_VARIABLE,
  VARIABLE_NAME_PATTERN,
  VARIABLE_TYPES,
  extractVariableNames,
  humanizeVariableName,
  isAutoVariable
} from '../../../../../shared/promptVariables.js';

const inputClass =
  'block w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 text-sm px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500';
const labelClass = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';

/** A label or description as the editor shows it: the text in the UI language. */
const asText = (value, lang) => (value ? getLocalizedContent(value, lang) : '');

/**
 * Keep only the metadata that says something, so a variable nobody described
 * is stored as nothing and stays a required free-text field.
 */
function cleanVariable(variable) {
  const out = { name: variable.name };
  if (variable.label && String(variable.label).trim()) out.label = String(variable.label).trim();
  if (variable.description && String(variable.description).trim()) {
    out.description = String(variable.description).trim();
  }
  if (variable.type && variable.type !== 'string') out.type = variable.type;
  if (typeof variable.required === 'boolean') out.required = variable.required;
  if (variable.defaultValue !== undefined && variable.defaultValue !== '') {
    out.defaultValue = variable.defaultValue;
  }
  if (variable.type === 'select') {
    const options = (variable.predefinedValues || [])
      .filter(option => String(option.value ?? '').trim())
      .map(option => ({
        label: String(option.label || option.value).trim(),
        value: String(option.value).trim()
      }));
    if (options.length) out.predefinedValues = options;
  }
  return out;
}

/** Whether a variable carries anything beyond its name. */
const isDescribed = variable => Object.keys(cleanVariable(variable)).length > 1;

/**
 * Create or edit a prompt of one's own.
 *
 * Variables are detected from the text as it is typed: every `{{name}}` that
 * is not filled in automatically becomes a field the user is asked for when
 * the prompt is used. Each can optionally be described — label, help text,
 * type, default, required, options.
 *
 * @param {Object} props
 * @param {Object} [props.prompt] - The user prompt being edited; omitted to create one.
 * @param {Object} [props.initial] - Prefill for a new prompt (`{ prompt, name, appId }`),
 *   e.g. from "Save as prompt" on a chat message.
 * @param {() => void} props.onClose
 * @param {(prompt: Object) => void} props.onSaved
 */
function PromptEditorModal({ prompt, initial = {}, onClose, onSaved }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { uiConfig } = useUIConfig();
  const { apps } = useApps();
  const editing = Boolean(prompt?.id);
  const source = editing ? prompt : initial;

  const [name, setName] = useState(() => asText(source.name, lang));
  const [description, setDescription] = useState(() => asText(source.description, lang));
  const [text, setText] = useState(() => asText(source.prompt, lang));
  const [icon, setIcon] = useState(source.icon || '');
  const [category, setCategory] = useState(source.category || '');
  const [appId, setAppId] = useState(source.appId || '');
  const [metadata, setMetadata] = useState(() => {
    const map = {};
    for (const variable of Array.isArray(source.variables) ? source.variables : []) {
      if (!variable?.name) continue;
      map[variable.name] = {
        ...variable,
        label: asText(variable.label, lang),
        description: asText(variable.description, lang),
        predefinedValues: (variable.predefinedValues || []).map(option => ({
          label: asText(option.label, lang),
          value: String(option.value ?? '')
        }))
      };
    }
    return map;
  });
  const [autoNames, setAutoNames] = useState(BUILTIN_AUTO_VARIABLES);
  const [expanded, setExpanded] = useState(null);
  const [newVariable, setNewVariable] = useState('');
  const [showInsert, setShowInsert] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const textRef = useRef(null);
  const nameRef = useRef(null);
  const newVariableRef = useRef(null);

  useEffect(() => {
    if (showInsert) newVariableRef.current?.focus();
  }, [showInsert]);

  useEffect(() => {
    let active = true;
    loadAutoVariables(lang).then(result => {
      if (active) setAutoNames(result.autoNames);
    });
    return () => {
      active = false;
    };
  }, [lang]);

  const detected = useMemo(() => extractVariableNames(text), [text]);
  const asked = detected.filter(
    name => metadata[name] || (name !== CONTENT_VARIABLE && !isAutoVariable(name, autoNames))
  );
  const automatic = detected.filter(name => !asked.includes(name));

  const categories = (uiConfig?.promptsList?.categories?.list || []).filter(c => c.id !== 'all');
  const chatApps = (apps || []).filter(app => (app?.type || 'chat') === 'chat');

  const insertAtCursor = snippet => {
    const el = textRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + snippet + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(start + snippet.length, start + snippet.length);
    });
  };

  const addVariable = () => {
    const variable = newVariable.trim().replace(/\s+/g, '_');
    if (!VARIABLE_NAME_PATTERN.test(variable)) {
      setError(
        t(
          'prompts.editor.invalidVariable',
          'A variable name starts with a letter and uses only letters, digits, _ and -'
        )
      );
      return;
    }
    setError(null);
    insertAtCursor(`{{${variable}}}`);
    setNewVariable('');
    setShowInsert(false);
  };

  const updateMeta = (variableName, patch) =>
    setMetadata(prev => ({
      ...prev,
      [variableName]: { name: variableName, ...(prev[variableName] || {}), ...patch }
    }));

  const save = async event => {
    event.preventDefault();
    if (!name.trim() || !text.trim()) {
      setError(t('prompts.editor.requiredFields', 'Name and prompt text are required'));
      return;
    }
    setSaving(true);
    setError(null);
    // Metadata is kept for the variables the text still uses.
    const variables = detected
      .map(variableName => metadata[variableName])
      .filter(variable => variable && isDescribed(variable))
      .map(cleanVariable);
    const body = {
      name: name.trim(),
      description: description.trim(),
      prompt: text,
      icon: icon || null,
      category: category || null,
      appId: appId || null,
      variables
    };
    try {
      const saved = editing
        ? await updateUserPrompt(prompt.id, { ...body, expectedRevision: prompt.revision })
        : await createUserPrompt(body);
      onSaved?.(saved);
    } catch (err) {
      setError(promptErrorMessage(err, t));
      setSaving(false);
    }
  };

  const renderMetaEditor = variableName => {
    const meta = metadata[variableName] || { name: variableName };
    const type = meta.type || 'string';
    return (
      <div className="mt-2 grid gap-3 sm:grid-cols-2 bg-gray-50 dark:bg-gray-900/50 p-3 rounded-md">
        <div>
          <label className={labelClass} htmlFor={`var-label-${variableName}`}>
            {t('prompts.editor.variableLabel', 'Label')}
          </label>
          <input
            id={`var-label-${variableName}`}
            className={inputClass}
            value={meta.label || ''}
            placeholder={humanizeVariableName(variableName)}
            onChange={e => updateMeta(variableName, { label: e.target.value })}
            maxLength={200}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor={`var-type-${variableName}`}>
            {t('prompts.editor.variableType', 'Type')}
          </label>
          <select
            id={`var-type-${variableName}`}
            className={inputClass}
            value={type}
            onChange={e => updateMeta(variableName, { type: e.target.value })}
          >
            {VARIABLE_TYPES.map(option => (
              <option key={option} value={option}>
                {t(`prompts.editor.types.${option}`, option)}
              </option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className={labelClass} htmlFor={`var-help-${variableName}`}>
            {t('prompts.editor.variableDescription', 'Help text')}
          </label>
          <input
            id={`var-help-${variableName}`}
            className={inputClass}
            value={meta.description || ''}
            onChange={e => updateMeta(variableName, { description: e.target.value })}
            maxLength={500}
          />
        </div>
        {type !== 'boolean' && (
          <div>
            <label className={labelClass} htmlFor={`var-default-${variableName}`}>
              {t('prompts.editor.variableDefault', 'Default value')}
            </label>
            <input
              id={`var-default-${variableName}`}
              className={inputClass}
              value={meta.defaultValue ?? ''}
              onChange={e => updateMeta(variableName, { defaultValue: e.target.value })}
              maxLength={2000}
            />
          </div>
        )}
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 self-end pb-2">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-gray-300 text-indigo-600"
            checked={meta.required !== false}
            onChange={e => updateMeta(variableName, { required: e.target.checked })}
          />
          {t('prompts.editor.variableRequired', 'Required')}
        </label>
        {type === 'select' && (
          <div className="sm:col-span-2">
            <div className={labelClass}>{t('prompts.editor.options', 'Options')}</div>
            {(meta.predefinedValues || []).map((option, index) => (
              <div key={index} className="flex gap-2 mb-2">
                <input
                  className={inputClass}
                  value={option.label}
                  placeholder={t('prompts.editor.optionLabel', 'Label')}
                  aria-label={t('prompts.editor.optionLabel', 'Label')}
                  onChange={e => {
                    const next = [...meta.predefinedValues];
                    next[index] = { ...option, label: e.target.value };
                    updateMeta(variableName, { predefinedValues: next });
                  }}
                />
                <input
                  className={inputClass}
                  value={option.value}
                  placeholder={t('prompts.editor.optionValue', 'Value')}
                  aria-label={t('prompts.editor.optionValue', 'Value')}
                  onChange={e => {
                    const next = [...meta.predefinedValues];
                    next[index] = { ...option, value: e.target.value };
                    updateMeta(variableName, { predefinedValues: next });
                  }}
                />
                <button
                  type="button"
                  className="text-gray-500 hover:text-red-600 px-2"
                  aria-label={t('common.delete', 'Delete')}
                  onClick={() =>
                    updateMeta(variableName, {
                      predefinedValues: meta.predefinedValues.filter((_, i) => i !== index)
                    })
                  }
                >
                  <Icon name="trash" size="sm" />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline"
              onClick={() =>
                updateMeta(variableName, {
                  predefinedValues: [...(meta.predefinedValues || []), { label: '', value: '' }]
                })
              }
            >
              + {t('prompts.editor.addOption', 'Add option')}
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      maxWidthClassName="max-w-3xl"
      initialFocusRef={nameRef}
      closeOnBackdropClick={false}
    >
      <form onSubmit={save} className="flex flex-col min-h-0">
        <div className="flex items-start justify-between p-5 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {editing
              ? t('prompts.editor.editTitle', 'Edit prompt')
              : t('prompts.editor.createTitle', 'New prompt')}
          </h2>
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
          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
            <div>
              <label htmlFor="prompt-editor-name" className={labelClass}>
                {t('prompts.editor.name', 'Name')}
                <span className="text-red-500 ml-0.5">*</span>
              </label>
              <input
                id="prompt-editor-name"
                ref={nameRef}
                className={inputClass}
                value={name}
                onChange={e => setName(e.target.value)}
                maxLength={200}
                placeholder={t('prompts.editor.namePlaceholder', 'e.g. Weekly status email')}
              />
            </div>
            <div>
              <div className={labelClass}>{t('prompts.editor.icon', 'Icon')}</div>
              <IconPicker value={icon} onChange={setIcon} />
            </div>
          </div>

          <div>
            <label htmlFor="prompt-editor-description" className={labelClass}>
              {t('prompts.editor.description', 'Description')}
            </label>
            <input
              id="prompt-editor-description"
              className={inputClass}
              value={description}
              onChange={e => setDescription(e.target.value)}
              maxLength={2000}
              placeholder={t('prompts.editor.descriptionPlaceholder', 'What is this prompt for?')}
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor="prompt-editor-text" className={labelClass}>
                {t('prompts.editor.text', 'Prompt')}
                <span className="text-red-500 ml-0.5">*</span>
              </label>
              <button
                type="button"
                onClick={() => setShowInsert(open => !open)}
                className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline inline-flex items-center gap-1"
              >
                <Icon name="plus" size="sm" />
                {t('prompts.editor.insertVariable', 'Insert variable')}
              </button>
            </div>
            {showInsert && (
              <div className="flex gap-2 mb-2">
                <input
                  className={inputClass}
                  value={newVariable}
                  onChange={e => setNewVariable(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addVariable();
                    }
                  }}
                  placeholder={t(
                    'prompts.editor.variableNamePlaceholder',
                    'Variable name, e.g. recipient'
                  )}
                  aria-label={t('prompts.editor.variableName', 'Variable name')}
                  ref={newVariableRef}
                />
                <button
                  type="button"
                  onClick={addVariable}
                  className="px-3 py-2 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700"
                >
                  {t('prompts.editor.insert', 'Insert')}
                </button>
              </div>
            )}
            <textarea
              id="prompt-editor-text"
              ref={textRef}
              className={`${inputClass} font-mono`}
              rows={8}
              value={text}
              onChange={e => setText(e.target.value)}
              maxLength={20000}
              placeholder={t('prompts.editor.textPlaceholder', {
                defaultValue: 'Write a {{tone}} email to {{recipient}} about {{topic}}.',
                skipInterpolation: true
              })}
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t('prompts.editor.textHelp', {
                defaultValue:
                  'Use {{name}} for anything to ask for when the prompt is used. {{content}} marks where your own text goes; {{user_name}}, {{date}} and the other global variables fill in by themselves.',
                skipInterpolation: true
              })}
            </p>
          </div>

          {(asked.length > 0 || automatic.length > 0) && (
            <div>
              <div className={labelClass}>{t('prompts.editor.variables', 'Variables')}</div>
              {asked.length > 0 && (
                <ul className="divide-y divide-gray-200 dark:divide-gray-700 border border-gray-200 dark:border-gray-700 rounded-md">
                  {asked.map(variableName => {
                    const meta = metadata[variableName];
                    const open = expanded === variableName;
                    return (
                      <li key={variableName} className="p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <code className="text-sm text-indigo-600 dark:text-indigo-400">{`{{${variableName}}}`}</code>
                            <span className="ml-2 text-sm text-gray-600 dark:text-gray-300">
                              {meta?.label || humanizeVariableName(variableName)}
                            </span>
                            <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                              {t(
                                `prompts.editor.types.${meta?.type || 'string'}`,
                                meta?.type || 'string'
                              )}
                              {meta?.required === false
                                ? ` · ${t('prompts.editor.optional', 'optional')}`
                                : ` · ${t('prompts.editor.variableRequired', 'Required')}`}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => setExpanded(open ? null : variableName)}
                            className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline shrink-0"
                            aria-expanded={open}
                          >
                            {open
                              ? t('prompts.editor.done', 'Done')
                              : t('prompts.editor.configure', 'Configure')}
                          </button>
                        </div>
                        {open && renderMetaEditor(variableName)}
                      </li>
                    );
                  })}
                </ul>
              )}
              {automatic.length > 0 && (
                <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                  {t('prompts.editor.automatic', 'Filled in automatically:')}{' '}
                  {automatic.map(variableName => (
                    <code key={variableName} className="mr-1 text-gray-600 dark:text-gray-300">
                      {`{{${variableName}}}`}
                    </code>
                  ))}
                </p>
              )}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            {categories.length > 0 && (
              <div>
                <label htmlFor="prompt-editor-category" className={labelClass}>
                  {t('prompts.editor.category', 'Category')}
                </label>
                <select
                  id="prompt-editor-category"
                  className={inputClass}
                  value={category}
                  onChange={e => setCategory(e.target.value)}
                >
                  <option value="">{t('prompts.editor.noCategory', 'No category')}</option>
                  {categories.map(c => (
                    <option key={c.id} value={c.id}>
                      {getLocalizedContent(c.name, lang)}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label htmlFor="prompt-editor-app" className={labelClass}>
                {t('prompts.editor.app', 'Open in app')}
              </label>
              <select
                id="prompt-editor-app"
                className={inputClass}
                value={appId}
                onChange={e => setAppId(e.target.value)}
              >
                <option value="">{t('prompts.editor.defaultApp', 'Default app')}</option>
                {appId && !chatApps.some(app => app.id === appId) && (
                  <option value={appId}>{appId}</option>
                )}
                {chatApps.map(app => (
                  <option key={app.id} value={app.id}>
                    {getLocalizedContent(app.name, lang)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {error && (
            <p className="text-sm text-red-600 dark:text-red-400" role="alert">
              {error}
            </p>
          )}
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
            disabled={saving}
            className="px-4 py-2 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {saving ? t('prompts.editor.saving', 'Saving…') : t('common.save', 'Save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default PromptEditorModal;
