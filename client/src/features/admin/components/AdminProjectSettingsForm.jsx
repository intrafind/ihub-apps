// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import Icon from '../../../shared/components/Icon';
import { MAX_PROJECT_ID_LENGTH } from '../utils/projectAdmin';
import ProjectAvailability from './ProjectAvailability';

const INPUT_CLASS =
  'w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500';
const LABEL_CLASS = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2';

/**
 * The settings form of an admin project: the id (create only), enabled and
 * published, localized name and description, instructions, category and
 * tags. For a new project it fills the page; for an existing one it is the
 * compact, sticky side column beside the items.
 *
 * @param {Object} props
 * @param {Object} props.form - See `projectFormFromProject`.
 * @param {boolean} props.isNew
 * @param {boolean} props.saving
 * @param {string|null} props.idError
 * @param {string|null} props.nameError
 * @param {string} props.tagsText - The tags as typed.
 * @param {(field: string, value: any) => void} props.onFieldChange
 * @param {(text: string) => void} props.onTagsTextChange
 * @param {(event: Event) => void} props.onSubmit
 * @param {() => void} props.onCancel
 * @returns {JSX.Element}
 */
function AdminProjectSettingsForm({
  form,
  isNew,
  saving,
  idError,
  nameError,
  tagsText,
  onFieldChange,
  onTagsTextChange,
  onSubmit,
  onCancel
}) {
  const { t } = useTranslation();
  return (
    <form
      onSubmit={onSubmit}
      noValidate
      aria-labelledby={isNew ? undefined : 'project-settings-title'}
      className={`bg-white dark:bg-gray-800 rounded-lg shadow-xs ${
        isNew
          ? 'p-6 space-y-6'
          : 'p-5 space-y-5 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto'
      }`}
    >
      {!isNew && (
        <div className="min-w-0">
          <h2
            id="project-settings-title"
            className="text-lg font-medium text-gray-900 dark:text-gray-100"
          >
            {t('admin.projects.settings', 'Settings')}
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t('admin.projects.fields.id', 'Project ID')}:{' '}
            <code className="font-mono">{form.id}</code>
            <span className="ml-1">
              ({t('admin.projects.fields.idFixed', 'The ID cannot be changed after creation.')})
            </span>
          </p>
        </div>
      )}

      <div>
        <DynamicLanguageEditor
          label={t('admin.projects.fields.name', 'Name')}
          required
          value={form.name}
          onChange={value => onFieldChange('name', value)}
          placeholder={t('admin.projects.fields.namePlaceholder', 'Project name')}
          error={nameError}
        />
      </div>

      {isNew && (
        <div>
          <label htmlFor="project-id" className={LABEL_CLASS}>
            {t('admin.projects.fields.id', 'Project ID')} *
          </label>
          <input
            id="project-id"
            type="text"
            value={form.id}
            maxLength={MAX_PROJECT_ID_LENGTH}
            onChange={e => onFieldChange('id', e.target.value)}
            placeholder="employee-handbook"
            aria-invalid={Boolean(idError)}
            aria-describedby={idError ? 'project-id-error project-id-hint' : 'project-id-hint'}
            className={`${INPUT_CLASS} font-mono ${idError ? 'border-red-400' : ''}`}
          />
          <p id="project-id-hint" className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t(
              'admin.projects.fields.idHint',
              'Filled in from the name. Apps and links use it, and it cannot be changed after creation.'
            )}
          </p>
          {idError && (
            <p id="project-id-error" role="alert" className="mt-1 text-sm text-red-600">
              {idError}
            </p>
          )}
        </div>
      )}

      <div>
        <DynamicLanguageEditor
          label={t('admin.projects.fields.description', 'Description')}
          rows={2}
          value={form.description}
          onChange={value => onFieldChange('description', value)}
          placeholder={t(
            'admin.projects.fields.descriptionPlaceholder',
            'What this project contains'
          )}
          type="textarea"
        />
      </div>

      <ProjectAvailability
        compact={!isNew}
        value={form}
        onChange={flags => {
          onFieldChange('enabled', flags.enabled);
          onFieldChange('published', flags.published);
        }}
      />

      <div>
        <label htmlFor="project-instructions" className={LABEL_CLASS}>
          {t('admin.projects.fields.instructions', 'Instructions')}
        </label>
        <textarea
          id="project-instructions"
          rows={isNew ? 5 : 4}
          value={form.instructions}
          onChange={e => onFieldChange('instructions', e.target.value)}
          className={INPUT_CLASS}
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {t(
            'admin.projects.fields.instructionsHint',
            'Added to the system prompt of every app, workflow step or agent that links this project, in every link mode. Say how the knowledge is to be used; put facts into documents.'
          )}
        </p>
      </div>

      <details
        className="group rounded-lg border border-gray-200 dark:border-gray-700"
        open={Boolean(form.category) || tagsText.trim() !== ''}
      >
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('admin.projects.details', 'Category and tags (optional)')}
        </summary>
        <div className="px-4 pb-4">
          <div className={`grid grid-cols-1 ${isNew ? 'md:grid-cols-2 gap-6' : 'gap-5'}`}>
            <div>
              <label htmlFor="project-category" className={LABEL_CLASS}>
                {t('admin.projects.fields.category', 'Category')}
              </label>
              <input
                id="project-category"
                type="text"
                value={form.category}
                maxLength={100}
                onChange={e => onFieldChange('category', e.target.value)}
                placeholder={t('admin.projects.fields.categoryPlaceholder', 'Optional category')}
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <label htmlFor="project-tags" className={LABEL_CLASS}>
                {t('admin.projects.fields.tags', 'Tags')}
              </label>
              <input
                id="project-tags"
                type="text"
                value={tagsText}
                onChange={e => onTagsTextChange(e.target.value)}
                placeholder={t('admin.projects.fields.tagsPlaceholder', 'hr, policies')}
                className={INPUT_CLASS}
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t('admin.projects.fields.tagsHint', 'Separate tags with commas.')}
              </p>
            </div>
          </div>
        </div>
      </details>

      <div className="flex items-center justify-between pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-600"
        >
          {t('common.cancel', 'Cancel')}
        </button>
        {isNew && (
          <p className="hidden sm:block flex-1 px-4 text-right text-xs text-gray-500 dark:text-gray-400">
            {t(
              'admin.projects.createHint',
              'Next you add the documents. Until the project is linked to an app, only administrators see it.'
            )}
          </p>
        )}
        <button
          type="submit"
          disabled={saving}
          className="px-6 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center"
        >
          {saving && <Icon name="arrow-path" className="animate-spin h-4 w-4 mr-2" />}
          {saving
            ? t('common.saving', 'Saving...')
            : isNew
              ? t('admin.projects.createAndContinue', 'Create and add items')
              : t('common.save', 'Save')}
        </button>
      </div>
    </form>
  );
}

export default AdminProjectSettingsForm;
