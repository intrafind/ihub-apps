// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import Icon from '../../../shared/components/Icon';
import { MAX_PROJECT_ID_LENGTH } from '../utils/projectAdmin';
import ProjectAppSelect from '../../projects/components/ProjectAppSelect';
import ProjectAvailability from './ProjectAvailability';

const INPUT_CLASS =
  'w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500';
const LABEL_CLASS = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2';

/**
 * The instructions of an admin project, with what they do.
 *
 * @param {Object} props
 * @param {string} props.value
 * @param {(value: string) => void} props.onChange
 * @param {number} [props.rows]
 * @returns {JSX.Element}
 */
export function ProjectInstructionsField({ value, onChange, rows = 5 }) {
  const { t } = useTranslation();
  return (
    <div>
      <label htmlFor="project-instructions" className={LABEL_CLASS}>
        {t('admin.projects.fields.instructions', 'Instructions')}
      </label>
      <textarea
        id="project-instructions"
        rows={rows}
        value={value}
        onChange={e => onChange(e.target.value)}
        aria-describedby="project-instructions-hint"
        className={INPUT_CLASS}
      />
      <p id="project-instructions-hint" className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        {t(
          'admin.projects.fields.instructionsHint',
          'Added to the system prompt of every app, workflow step or agent that links this project, in every link mode. Say how the knowledge is to be used; put facts into documents.'
        )}
      </p>
    </div>
  );
}

/**
 * The app new chats of an admin project start in. Users who add the project
 * to theirs get it selected automatically.
 *
 * @param {Object} props
 * @param {string} props.value - The app id; empty for none.
 * @param {(appId: string) => void} props.onChange
 * @returns {JSX.Element}
 */
export function ProjectDefaultAppField({ value, onChange }) {
  const { t } = useTranslation();
  return (
    <div>
      <label htmlFor="project-defaultAppId" className={LABEL_CLASS}>
        {t('admin.projects.fields.defaultApp', 'Default app')}
      </label>
      <ProjectAppSelect
        id="project-defaultAppId"
        value={value || ''}
        noneLabel={t('admin.projects.fields.defaultAppNone', 'No default (first available app)')}
        onChange={onChange}
        className={INPUT_CLASS}
      />
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        {t(
          'admin.projects.fields.defaultAppHint',
          'Chats in this project start in this app, so users who add the project to theirs get the right app selected automatically. They can still pick another app.'
        )}
      </p>
    </div>
  );
}

/**
 * The category and the tags of an admin project, side by side.
 *
 * @param {Object} props
 * @param {string} props.category
 * @param {string} props.tagsText - The tags as typed.
 * @param {(value: string) => void} props.onCategoryChange
 * @param {(text: string) => void} props.onTagsTextChange
 * @returns {JSX.Element}
 */
export function ProjectCategoryTagsFields({
  category,
  tagsText,
  onCategoryChange,
  onTagsTextChange
}) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <div>
        <label htmlFor="project-category" className={LABEL_CLASS}>
          {t('admin.projects.fields.category', 'Category')}
        </label>
        <input
          id="project-category"
          type="text"
          value={category}
          maxLength={100}
          onChange={e => onCategoryChange(e.target.value)}
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
  );
}

/**
 * The form that creates an admin project: the id, localized name and
 * description, availability, instructions, category and tags. An existing
 * project is changed from its side panel instead (`AdminProjectSettingsPanel`).
 *
 * @param {Object} props
 * @param {Object} props.form - See `createEmptyProjectForm`.
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
      className="bg-white dark:bg-gray-800 rounded-lg shadow-xs p-6 space-y-6"
    >
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
        value={form}
        onChange={flags => {
          onFieldChange('enabled', flags.enabled);
          onFieldChange('published', flags.published);
        }}
      />

      <ProjectInstructionsField
        value={form.instructions}
        onChange={value => onFieldChange('instructions', value)}
      />

      <ProjectDefaultAppField
        value={form.defaultAppId}
        onChange={value => onFieldChange('defaultAppId', value)}
      />

      <details
        className="group rounded-lg border border-gray-200 dark:border-gray-700"
        open={Boolean(form.category) || tagsText.trim() !== ''}
      >
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('admin.projects.details', 'Category and tags (optional)')}
        </summary>
        <div className="px-4 pb-4">
          <ProjectCategoryTagsFields
            category={form.category}
            tagsText={tagsText}
            onCategoryChange={value => onFieldChange('category', value)}
            onTagsTextChange={onTagsTextChange}
          />
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
        <p className="hidden sm:block flex-1 px-4 text-right text-xs text-gray-500 dark:text-gray-400">
          {t(
            'admin.projects.createHint',
            'Next you add the documents. Until the project is linked to an app, only administrators see it.'
          )}
        </p>
        <button
          type="submit"
          disabled={saving}
          className="px-6 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center"
        >
          {saving && <Icon name="arrow-path" className="animate-spin h-4 w-4 mr-2" />}
          {saving
            ? t('common.saving', 'Saving...')
            : t('admin.projects.createAndContinue', 'Create and add items')}
        </button>
      </div>
    </form>
  );
}

export default AdminProjectSettingsForm;
