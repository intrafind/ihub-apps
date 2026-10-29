// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import DynamicLanguageEditor from '../../../../shared/components/DynamicLanguageEditor';
import FormSection from './FormSection';
import { CALLOUT_CLASS } from './formStyles';
import { FORM_LANGUAGES, toolIdsFor } from '../../utils/peopleDirectories';

/**
 * Editor section "Model-facing": the name and description the model reads to
 * decide which directory fits a question. They become the name and
 * description of the directory's tools, so the section previews them the way
 * the model sees them, in English and German, with the tool ids apps select.
 *
 * @param {Object} props
 * @param {Object} props.form - Form state
 * @param {(patch: Object) => void} props.update - Merge a patch into the form
 */
function ModelFacingSection({ form, update }) {
  const { t } = useTranslation();
  const toolIds = toolIdsFor(form.id, form.units);

  return (
    <FormSection
      id="pd-model"
      title={t('admin.peopleDirectories.model.title', 'Model-facing name and description')}
      description={t(
        'admin.peopleDirectories.model.description',
        'The model chooses a directory by these texts. Say whose staff it lists, which fields it has, and whether it is an external service.'
      )}
    >
      <DynamicLanguageEditor
        label={t('admin.peopleDirectories.model.name', 'Name')}
        name="pd-name"
        value={form.name}
        onChange={name => update({ name })}
        placeholder={{ en: 'Company directory', de: 'Firmenverzeichnis' }}
      />
      <DynamicLanguageEditor
        label={t('admin.peopleDirectories.model.descriptionLabel', 'Description')}
        name="pd-description"
        type="textarea"
        value={form.description}
        onChange={description => update({ description })}
        placeholder={{
          en: 'Employees of our company: name, e-mail, phone, department, manager.',
          de: 'Mitarbeitende unseres Unternehmens: Name, E-Mail, Telefon, Abteilung, Vorgesetzte.'
        }}
      />

      <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-3">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t('admin.peopleDirectories.model.previewTitle', 'What the model sees')}
        </h3>
        <dl className="mt-2 space-y-2">
          {FORM_LANGUAGES.map(lang => {
            const name = form.name?.[lang]?.trim() || form.name?.en?.trim() || form.id || '—';
            const description =
              form.description?.[lang]?.trim() || form.description?.en?.trim() || '';
            return (
              <div key={lang} className="flex gap-2 text-sm">
                <dt className="w-8 shrink-0 font-medium uppercase text-gray-600 dark:text-gray-400">
                  {lang}
                </dt>
                <dd lang={lang} className="text-gray-900 dark:text-gray-100">
                  <span className="font-medium">{name}</span>
                  {description ? ` – ${description}` : ''}
                </dd>
              </div>
            );
          })}
        </dl>
        <p className="mt-3 text-xs text-gray-600 dark:text-gray-400">
          {t('admin.peopleDirectories.model.toolIds', 'Tools apps can select:')}{' '}
          {toolIds.map((toolId, index) => (
            <span key={toolId}>
              {index > 0 && ', '}
              <code className="font-mono text-gray-800 dark:text-gray-200">{toolId}</code>
            </span>
          ))}
        </p>
      </div>

      {!FORM_LANGUAGES.some(lang => form.description?.[lang]?.trim()) && (
        <div className={CALLOUT_CLASS.info} role="note">
          {t(
            'admin.peopleDirectories.model.noDescription',
            'Without a description the model knows nothing but the name and id, and may pick the wrong directory.'
          )}
        </div>
      )}
    </FormSection>
  );
}

export default ModelFacingSection;
