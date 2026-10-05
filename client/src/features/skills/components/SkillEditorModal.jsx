import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import Icon from '../../../shared/components/Icon';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import { createUserSkill, fetchUserSkill, updateUserSkill } from '../../../api';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import { skillErrorMessage } from '../utils/skillErrors';
import {
  DEFAULT_SKILL_LIMITS,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_FILE_FOLDERS,
  SKILL_NAME_MAX_LENGTH,
  joinSkillFilePath,
  skillValidationMessage,
  splitSkillFilePath,
  validateSkillDraft
} from '../utils/skillValidation';

const inputClass =
  'block w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 text-sm px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500';
const invalidInputClass = 'border-red-500 dark:border-red-500';
const labelClass = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';
const errorClass = 'mt-1 text-xs text-red-600 dark:text-red-400';
const hintClass = 'mt-1 text-xs text-gray-500 dark:text-gray-400';

let fileKeySeed = 0;
/** A stable React key for a file row, which has no id of its own. */
const nextFileKey = () => `file-${++fileKeySeed}`;

/** The editor's row for a stored file. */
const toFileRow = file => ({
  key: nextFileKey(),
  ...splitSkillFilePath(file?.path),
  content: typeof file?.content === 'string' ? file.content : ''
});

/** Bytes as KB with one decimal, e.g. `4.0`. */
const formatKB = bytes => (bytes / 1024).toFixed(1);

/** The dialog's title bar. */
function EditorHeader({ editing, onClose }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start justify-between p-5 border-b border-gray-200 dark:border-gray-700">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        {editing
          ? t('skills.editor.editTitle', 'Edit skill')
          : t('skills.editor.createTitle', 'New skill')}
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
  );
}

/**
 * Create or edit a skill of one's own: its name (the slug the model sees),
 * the description that tells the model when to use it, the Markdown
 * instructions, and optional text files under `references/`, `assets/` or
 * `scripts/`.
 *
 * Everything is checked while typing (see `utils/skillValidation`) and the
 * total size is shown against the platform's `maxSkillSizeKB`. A skill from a
 * list comes without body and files; it is loaded before the form shows, and
 * its `revision` is sent as `expectedRevision` so a concurrent save is
 * reported instead of overwritten.
 *
 * @param {Object} props
 * @param {Object} [props.skill] - The user skill being edited; omitted to create one.
 * @param {Object} [props.initial] - Prefill for a new skill (`{ name, description, body, files }`).
 * @param {() => void} props.onClose
 * @param {(skill: Object) => void} props.onSaved
 */
function SkillEditorModal({ skill, initial = {}, onClose, onSaved }) {
  const { t } = useTranslation();
  const editing = Boolean(skill?.id);
  const needsLoad = editing && typeof skill.body !== 'string';
  const [loaded, setLoaded] = useState(null);
  const [loadError, setLoadError] = useState(null);

  // Load the full skill when the caller only had the list entry.
  useEffect(() => {
    if (!needsLoad) return undefined;
    let active = true;
    fetchUserSkill(skill.id)
      .then(detail => {
        if (active) setLoaded(detail);
      })
      .catch(err => {
        if (active) setLoadError(skillErrorMessage(err, t));
      });
    return () => {
      active = false;
    };
  }, [needsLoad, skill?.id, t]);

  const source = needsLoad ? loaded : editing ? skill : initial;

  if (!source) {
    return (
      <Modal isOpen onClose={onClose} maxWidthClassName="max-w-3xl">
        <EditorHeader editing={editing} onClose={onClose} />
        <div className="p-6">
          {loadError ? (
            <p className="text-sm text-red-600 dark:text-red-400" role="alert">
              {loadError}
            </p>
          ) : (
            <LoadingSpinner />
          )}
        </div>
      </Modal>
    );
  }

  return (
    <SkillEditorForm
      skillId={editing ? skill.id : null}
      source={source}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

/**
 * The editor form, filled from a fully loaded skill (or a prefill).
 *
 * @param {Object} props
 * @param {string|null} props.skillId - Id of the skill being edited, null to create one.
 * @param {Object} props.source - The skill (or prefill) the form starts from.
 * @param {() => void} props.onClose
 * @param {(skill: Object) => void} props.onSaved
 */
function SkillEditorForm({ skillId, source, onClose, onSaved }) {
  const { t } = useTranslation();
  const { platformConfig } = usePlatformConfig();
  const editing = Boolean(skillId);
  const maxSkillSizeKB =
    platformConfig?.userSkills?.maxSkillSizeKB || DEFAULT_SKILL_LIMITS.maxSkillSizeKB;
  const maxFilesPerSkill =
    platformConfig?.userSkills?.maxFilesPerSkill ?? DEFAULT_SKILL_LIMITS.maxFilesPerSkill;

  const [name, setName] = useState(source.name || '');
  const [description, setDescription] = useState(source.description || '');
  const [body, setBody] = useState(source.body || '');
  const [files, setFiles] = useState(() =>
    (Array.isArray(source.files) ? source.files : []).map(toFileRow)
  );
  const [touched, setTouched] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const nameRef = useRef(null);

  const validation = useMemo(
    () =>
      validateSkillDraft({ name, description, body, files }, { maxSkillSizeKB, maxFilesPerSkill }),
    [name, description, body, files, maxSkillSizeKB, maxFilesPerSkill]
  );

  const show = field => submitted || touched[field];
  const touch = field => setTouched(prev => ({ ...prev, [field]: true }));

  const updateFile = (key, patch) =>
    setFiles(prev => prev.map(file => (file.key === key ? { ...file, ...patch } : file)));
  const removeFile = key => setFiles(prev => prev.filter(file => file.key !== key));
  const addFile = () =>
    setFiles(prev => [
      ...prev,
      { key: nextFileKey(), folder: 'references', fileName: '', content: '' }
    ]);

  const save = async event => {
    event.preventDefault();
    setSubmitted(true);
    if (!validation.valid) {
      setError(t('skills.editor.fixErrors', 'Please fix the highlighted fields.'));
      return;
    }
    setSaving(true);
    setError(null);
    const payload = {
      name,
      description: description.trim(),
      body,
      files: files.map(file => ({
        path: joinSkillFilePath(file.folder, file.fileName),
        content: file.content
      }))
    };
    try {
      const saved = editing
        ? await updateUserSkill(skillId, { ...payload, expectedRevision: source.revision })
        : await createUserSkill(payload);
      onSaved?.(saved);
    } catch (err) {
      setError(skillErrorMessage(err, t));
      setSaving(false);
    }
  };

  const nameError = show('name') ? skillValidationMessage(validation.name, t) : null;
  const descriptionError = show('description')
    ? skillValidationMessage(validation.description, t)
    : null;
  const bodyError = show('body') ? skillValidationMessage(validation.body, t) : null;
  const descriptionLength = description.length;

  return (
    <Modal
      isOpen
      onClose={onClose}
      maxWidthClassName="max-w-3xl"
      initialFocusRef={nameRef}
      closeOnBackdropClick={false}
    >
      <form onSubmit={save} className="flex flex-col min-h-0" noValidate>
        <EditorHeader editing={editing} onClose={onClose} />

        <div className="p-5 overflow-y-auto space-y-4">
          <div>
            <label htmlFor="skill-editor-name" className={labelClass}>
              {t('skills.editor.name', 'Name')}
              <span className="text-red-500 ml-0.5">*</span>
            </label>
            <input
              id="skill-editor-name"
              ref={nameRef}
              className={`${inputClass} font-mono ${nameError ? invalidInputClass : ''}`}
              value={name}
              onChange={e => {
                setName(e.target.value);
                touch('name');
              }}
              maxLength={SKILL_NAME_MAX_LENGTH}
              placeholder={t('skills.editor.namePlaceholder', 'e.g. weekly-report')}
              aria-invalid={Boolean(nameError)}
              aria-describedby="skill-editor-name-hint"
              autoComplete="off"
              spellCheck={false}
            />
            {nameError ? (
              <p id="skill-editor-name-hint" className={errorClass} role="alert">
                {nameError}
              </p>
            ) : (
              <p id="skill-editor-name-hint" className={hintClass}>
                {t(
                  'skills.editor.nameHint',
                  'Lowercase letters, digits and hyphens. The model sees this name.'
                )}
              </p>
            )}
          </div>

          <div>
            <div className="flex items-baseline justify-between">
              <label htmlFor="skill-editor-description" className={labelClass}>
                {t('skills.editor.description', 'Description')}
                <span className="text-red-500 ml-0.5">*</span>
              </label>
              <span
                className={`text-xs ${
                  descriptionLength > SKILL_DESCRIPTION_MAX_LENGTH
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-gray-500 dark:text-gray-400'
                }`}
                aria-live="polite"
              >
                {t('skills.editor.characterCount', {
                  defaultValue: '{{count}} / {{max}}',
                  count: descriptionLength,
                  max: SKILL_DESCRIPTION_MAX_LENGTH
                })}
              </span>
            </div>
            <textarea
              id="skill-editor-description"
              className={`${inputClass} ${descriptionError ? invalidInputClass : ''}`}
              rows={3}
              value={description}
              onChange={e => {
                setDescription(e.target.value);
                touch('description');
              }}
              placeholder={t(
                'skills.editor.descriptionPlaceholder',
                'Drafts the weekly team report from bullet points. Use when the user asks for a weekly report or status summary.'
              )}
              aria-invalid={Boolean(descriptionError)}
              aria-describedby="skill-editor-description-hint"
            />
            {descriptionError ? (
              <p id="skill-editor-description-hint" className={errorClass} role="alert">
                {descriptionError}
              </p>
            ) : (
              <p id="skill-editor-description-hint" className={hintClass}>
                {t('skills.editor.descriptionHint', 'Say what the skill does and when to use it.')}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="skill-editor-body" className={labelClass}>
              {t('skills.editor.body', 'Instructions')}
              <span className="text-red-500 ml-0.5">*</span>
            </label>
            <textarea
              id="skill-editor-body"
              className={`${inputClass} font-mono ${bodyError ? invalidInputClass : ''}`}
              rows={12}
              value={body}
              onChange={e => {
                setBody(e.target.value);
                touch('body');
              }}
              placeholder={t(
                'skills.editor.bodyPlaceholder',
                '# Weekly report\n\n1. Ask for the highlights of the week.\n2. …'
              )}
              aria-invalid={Boolean(bodyError)}
              aria-describedby="skill-editor-body-hint"
            />
            {bodyError ? (
              <p id="skill-editor-body-hint" className={errorClass} role="alert">
                {bodyError}
              </p>
            ) : (
              <p id="skill-editor-body-hint" className={hintClass}>
                {t(
                  'skills.editor.bodyHint',
                  'Markdown. The model reads these instructions when it uses the skill; refer to files by their path, e.g. references/template.md.'
                )}
              </p>
            )}
          </div>

          <fieldset>
            <legend className={labelClass}>{t('skills.editor.files', 'Files')}</legend>
            <p className={`${hintClass} mb-2`}>
              {t(
                'skills.editor.filesHint',
                'Optional text files the model can read when it needs them: references, templates, examples.'
              )}
            </p>
            {files.length > 0 && (
              <ul className="space-y-3 mb-3">
                {files.map((file, index) => {
                  const fileError = show(`file-${file.key}`)
                    ? skillValidationMessage(validation.files[index], t)
                    : null;
                  const path = joinSkillFilePath(file.folder, file.fileName);
                  return (
                    <li
                      key={file.key}
                      className="border border-gray-200 dark:border-gray-700 rounded-md p-3"
                    >
                      <div className="flex flex-wrap sm:flex-nowrap items-center gap-2">
                        <select
                          className={`${inputClass} sm:w-40`}
                          value={file.folder}
                          aria-label={t('skills.editor.fileFolder', 'Folder')}
                          onChange={e => {
                            updateFile(file.key, { folder: e.target.value });
                            touch(`file-${file.key}`);
                          }}
                        >
                          {!file.folder && (
                            <option value="">{t('skills.editor.chooseFolder', 'Folder…')}</option>
                          )}
                          {SKILL_FILE_FOLDERS.map(folder => (
                            <option key={folder} value={folder}>
                              {folder}/
                            </option>
                          ))}
                        </select>
                        <input
                          className={`${inputClass} font-mono ${fileError ? invalidInputClass : ''}`}
                          value={file.fileName}
                          aria-label={t('skills.editor.fileName', 'File name')}
                          aria-invalid={Boolean(fileError)}
                          placeholder={t('skills.editor.fileNamePlaceholder', 'template.md')}
                          onChange={e => {
                            updateFile(file.key, { fileName: e.target.value });
                            touch(`file-${file.key}`);
                          }}
                          autoComplete="off"
                          spellCheck={false}
                        />
                        <button
                          type="button"
                          onClick={() => removeFile(file.key)}
                          className="shrink-0 p-2 text-gray-500 hover:text-red-600"
                          aria-label={t('skills.editor.removeFile', {
                            defaultValue: 'Remove {{path}}',
                            path
                          })}
                          title={t('skills.editor.removeFileShort', 'Remove file')}
                        >
                          <Icon name="trash" size="sm" />
                        </button>
                      </div>
                      {fileError && (
                        <p className={errorClass} role="alert">
                          {fileError}
                        </p>
                      )}
                      <textarea
                        className={`${inputClass} font-mono mt-2`}
                        rows={5}
                        value={file.content}
                        aria-label={t('skills.editor.fileContent', {
                          defaultValue: 'Content of {{path}}',
                          path
                        })}
                        onChange={e => updateFile(file.key, { content: e.target.value })}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                onClick={addFile}
                disabled={files.length >= maxFilesPerSkill}
                className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline inline-flex items-center gap-1 disabled:opacity-50 disabled:no-underline"
              >
                <Icon name="plus" size="sm" />
                {t('skills.editor.addFile', 'Add file')}
              </button>
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {t('skills.editor.fileCount', {
                  defaultValue: '{{count}} of {{max}} files',
                  count: files.length,
                  max: maxFilesPerSkill
                })}
              </span>
            </div>
            {validation.tooManyFiles && (
              <p className={errorClass} role="alert">
                {t('skills.editor.tooManyFiles', {
                  defaultValue: 'A skill can have at most {{max}} files.',
                  max: maxFilesPerSkill
                })}
              </p>
            )}
          </fieldset>

          <div
            className={`text-sm ${
              validation.tooLarge
                ? 'text-red-600 dark:text-red-400'
                : 'text-gray-600 dark:text-gray-300'
            }`}
            aria-live="polite"
          >
            {t('skills.editor.size', {
              defaultValue: 'Size: {{size}} KB of {{max}} KB',
              size: formatKB(validation.size),
              max: maxSkillSizeKB
            })}
            {validation.tooLarge && (
              <span className="block text-xs">
                {t(
                  'skills.editor.tooLarge',
                  'Too large: shorten the instructions or remove files.'
                )}
              </span>
            )}
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
            {saving ? t('skills.editor.saving', 'Saving…') : t('common.save', 'Save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default SkillEditorModal;
