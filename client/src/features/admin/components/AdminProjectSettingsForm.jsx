// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import Icon from '../../../shared/components/Icon';
import { MAX_PROJECT_ID_LENGTH } from '../utils/projectAdmin';
import ProjectPublishedSwitch from './ProjectPublishedSwitch';

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
        // The title above the switches: the Published hint needs the width.
        <div className="space-y-3">
          <div className="min-w-0">
            <h2
              id="project-settings-title"
              className="text-lg font-medium text-gray-900 dark:text-gray-100"
            >
              {t('admin.projects.settings', 'Settings')}
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
              {t('admin.projects.fields.id', 'Project ID')}:{' '}
              <code className="font-mono">{form.id}</code>
            </p>
          </div>
          <div className="flex flex-col items-start gap-2">
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={e => onFieldChange('enabled', e.target.checked)}
                className="h-4 w-4 text-indigo-600 border-gray-300 rounded-sm focus:ring-indigo-500"
              />
              {t('admin.projects.fields.enabled', 'Enabled')}
            </label>
            <ProjectPublishedSwitch
              checked={form.published}
              onChange={published => onFieldChange('published', published)}
            />
          </div>
        </div>
      )}
      {isNew && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label htmlFor="project-id" className={LABEL_CLASS}>
              {t('admin.projects.fields.id', 'Project ID')} *
            </label>
            <input
              id="project-id"
              type="text"
              value={form.id}
              disabled={!isNew}
              maxLength={MAX_PROJECT_ID_LENGTH}
              onChange={e => onFieldChange('id', e.target.value)}
              placeholder="employee-handbook"
              aria-invalid={Boolean(idError)}
              className={`${INPUT_CLASS} ${!isNew ? 'opacity-60 cursor-not-allowed' : ''} ${
                idError ? 'border-red-400' : ''
              }`}
            />
            {idError && <p className="mt-1 text-sm text-red-600">{idError}</p>}
            {!isNew && (
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {t('admin.projects.fields.idFixed', 'The ID cannot be changed after creation.')}
              </p>
            )}
          </div>
          <div className="flex items-end gap-6">
            <label className="flex items-center gap-2 pb-2 text-sm text-gray-700 dark:text-gray-300">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={e => onFieldChange('enabled', e.target.checked)}
                className="h-4 w-4 text-indigo-600 border-gray-300 rounded-sm focus:ring-indigo-500"
              />
              {t('admin.projects.fields.enabled', 'Enabled')}
            </label>
            <ProjectPublishedSwitch
              checked={form.published}
              onChange={published => onFieldChange('published', published)}
              className="pb-2"
            />
          </div>
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

      <div className="flex items-center justify-between pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-600"
        >
          {t('common.cancel', 'Cancel')}
        </button>
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
